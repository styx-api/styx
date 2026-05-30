import { describe, expect, it } from "vitest";
import type { Binding, BindingId, BoundType } from "../bindings/index.js";
import { renderAccess, tsPropAccess } from "../backend/typescript/emit.js";
import { alt, lit, opt, path, rep, seq, str } from "../ir/builders.js";
import type { Expr } from "../ir/index.js";
import { solve } from "./solver.js";

/**
 * Oracle: a faithful copy of the pre-refactor `outputs-emit.walkAccess`
 * (string-based, stops at `repeat`). The refactor must render byte-identical
 * paths for every binding this oracle covers (i.e. every binding NOT inside a
 * `repeat`-of-list). Repeat-inner bindings were absent from the old map; the
 * refactor newly assigns them `iter`-rooted paths (covered by separate
 * assertions below and the list-of-struct output tests).
 */
type OldMap = Map<BindingId, string>;

interface OldCtx {
  paramsVar: string;
  directValue?: string;
  currentStructType?: BoundType;
}

function hasStructScope(type: BoundType): boolean {
  switch (type.kind) {
    case "optional":
      return hasStructScope(type.inner);
    case "list":
      return hasStructScope(type.item);
    case "struct":
      return true;
    default:
      return false;
  }
}

function unwrapToStruct(type: BoundType): Extract<BoundType, { kind: "struct" }> | undefined {
  switch (type.kind) {
    case "optional":
      return unwrapToStruct(type.inner);
    case "list":
      return unwrapToStruct(type.item);
    case "struct":
      return type;
    default:
      return undefined;
  }
}

function oldResolveAccess(arg: OldCtx, name: string): string {
  return arg.directValue ?? tsPropAccess(arg.paramsVar, name);
}

function oldWalk(
  node: Expr,
  resolve: (n: Expr) => Binding | undefined,
  arg: OldCtx,
  out: OldMap,
): void {
  const binding = resolve(node);
  switch (node.kind) {
    case "literal":
      return;
    case "int":
    case "float":
    case "str":
    case "path":
      if (binding) out.set(binding.id, oldResolveAccess(arg, binding.name));
      return;
    case "sequence": {
      let childArg = arg;
      if (binding && hasStructScope(binding.type) && binding.type !== arg.currentStructType) {
        const access = tsPropAccess(arg.paramsVar, binding.name);
        out.set(binding.id, access);
        childArg = {
          paramsVar: access,
          currentStructType: unwrapToStruct(binding.type) ?? arg.currentStructType,
        };
      } else if (binding) {
        out.set(binding.id, arg.directValue ?? arg.paramsVar);
      }
      for (const child of node.attrs.nodes) oldWalk(child, resolve, childArg, out);
      return;
    }
    case "optional": {
      if (!binding) {
        oldWalk(node.attrs.node, resolve, arg, out);
        return;
      }
      const access = tsPropAccess(arg.paramsVar, binding.name);
      out.set(binding.id, access);
      let childArg: OldCtx;
      if (hasStructScope(binding.type)) {
        childArg = {
          paramsVar: access,
          currentStructType: unwrapToStruct(binding.type) ?? arg.currentStructType,
        };
      } else if (binding.type.kind === "optional" || binding.type.kind === "bool") {
        childArg = { ...arg, directValue: access };
      } else {
        childArg = arg;
      }
      oldWalk(node.attrs.node, resolve, childArg, out);
      return;
    }
    case "repeat":
      // The old walker recorded the repeat's own path and stopped.
      if (binding) out.set(binding.id, oldResolveAccess(arg, binding.name));
      return;
    case "alternative": {
      if (!binding) {
        for (const a of node.attrs.alts) oldWalk(a, resolve, arg, out);
        return;
      }
      const access = oldResolveAccess(arg, binding.name);
      out.set(binding.id, access);
      const isComplexUnion =
        binding.type.kind === "union" &&
        !binding.type.variants.every((v) => v.type.kind === "literal");
      node.attrs.alts.forEach((a, i) => {
        if (isComplexUnion && binding.type.kind === "union") {
          const variantType = binding.type.variants[i]?.type;
          oldWalk(
            a,
            resolve,
            {
              paramsVar: access,
              currentStructType:
                variantType?.kind === "struct" ? variantType : arg.currentStructType,
            },
            out,
          );
        } else {
          oldWalk(a, resolve, arg, out);
        }
      });
      return;
    }
  }
}

function oldBuildAccessMap(expr: Expr, resolve: (n: Expr) => Binding | undefined): OldMap {
  const out: OldMap = new Map();
  oldWalk(expr, resolve, { paramsVar: "params", currentStructType: resolve(expr)?.type }, out);
  return out;
}

/** Stub loop-var lookup that fails loudly: no `iter` segment should appear in
 * a binding the old map covered. */
const noLoopVars = (b: BindingId): string => {
  throw new Error(`unexpected iter segment for binding ${b}`);
};

// A diverse corpus exercising every walker code path.
const corpus: Array<{ name: string; expr: Expr }> = [
  { name: "flat scalars", expr: seq(lit("tool"), str("a"), path("b")) },
  {
    name: "nested struct",
    expr: seq(lit("tool"), seq(lit("--sub"), str("x"), str("y"))),
  },
  { name: "optional scalar (collapse)", expr: seq(lit("tool"), opt(str("flag"))) },
  {
    name: "optional struct",
    expr: seq(lit("tool"), opt(seq(lit("--grp"), str("p"), str("q")))),
  },
  { name: "scalar list", expr: seq(lit("tool"), rep(str("items"))) },
  {
    name: "struct list",
    expr: seq(lit("tool"), rep(seq(str("file"), str("label")), "things")),
  },
  {
    name: "complex union",
    expr: seq(lit("tool"), alt(seq(lit("a"), str("af")), seq(lit("b"), str("bf"), str("bf2")))),
  },
];

describe("assignAccessPaths - oracle equivalence", () => {
  for (const { name, expr } of corpus) {
    it(`matches the old walker for every covered binding: ${name}`, () => {
      const { bindings, resolve } = solve(expr);
      const oldMap = oldBuildAccessMap(expr, resolve);
      expect(oldMap.size).toBeGreaterThan(0);
      for (const [id, oldPath] of oldMap) {
        const binding = bindings.get(id)!;
        // Bindings the old map covered never sit inside a repeat-of-list, so
        // their access has no `iter` segment and renderAccess needs no loop var.
        expect(renderAccess(binding.access, noLoopVars)).toBe(oldPath);
      }
    });
  }
});

describe("assignAccessPaths - segment shapes", () => {
  const field = (name: string): { kind: "field"; name: string } => ({ kind: "field", name });
  const iter = (binding: string): { kind: "iter"; binding: string } => ({ kind: "iter", binding });

  it("two-field nested struct scopes children under the struct field", () => {
    const x = str("x");
    const subSeq = seq(lit("--sub"), x, str("y"));
    const expr = seq(lit("tool"), subSeq);
    const { resolve } = solve(expr);
    const sub = resolve(subSeq)!;
    expect(resolve(x)!.access).toEqual([...sub.access, field("x")]);
  });

  it("optional<scalar> collapse: inner inherits the optional's path (no extra segment)", () => {
    const flag = str("flag");
    const optNode = opt(flag);
    const expr = seq(lit("tool"), optNode);
    const { resolve } = solve(expr);
    // Two distinct bindings (the optional wrapper and the inner scalar) but the
    // same access path - directValue is path inheritance, not a segment.
    expect(resolve(flag)!.access).toEqual(resolve(optNode)!.access);
    expect(resolve(flag)!.access).toEqual([field("flag")]);
  });

  it("scalar list element is just the iter loop var (no trailing field)", () => {
    const item = str("items");
    const repNode = rep(item);
    const expr = seq(lit("tool"), repNode);
    const { resolve } = solve(expr);
    const listBinding = resolve(repNode)!;
    expect(listBinding.access).toEqual([field("items")]);
    expect(resolve(item)!.access).toEqual([iter(listBinding.id)]);
    expect(renderAccess(resolve(item)!.access, () => "item0")).toBe("item0");
  });

  it("struct list inner field is iter-rooted then field", () => {
    const file = str("file");
    const innerSeq = seq(file, str("label"));
    const repNode = rep(innerSeq, "things");
    const expr = seq(lit("tool"), repNode);
    const { resolve } = solve(expr);
    const listBinding = resolve(repNode)!;
    expect(listBinding.access).toEqual([field("things")]);
    expect(resolve(file)!.access).toEqual([iter(listBinding.id), field("file")]);
    // renderAccess substitutes the loop var for the iter segment.
    expect(renderAccess(resolve(file)!.access, () => "item0")).toBe("item0.file");
  });

  it("nested repeat composes iter segments (resets base per loop)", () => {
    const leaf = str("leaf");
    const inner = rep(seq(leaf, str("other")), "inner");
    const outer = rep(seq(inner, str("tag")), "outer");
    const expr = seq(lit("tool"), outer);
    const { resolve } = solve(expr);
    const outerB = resolve(outer)!;
    const innerB = resolve(inner)!;
    // The inner repeat's own path is rooted at the outer loop var.
    expect(innerB.access).toEqual([iter(outerB.id), field("inner")]);
    // The leaf resets again to the inner loop var.
    expect(resolve(leaf)!.access).toEqual([iter(innerB.id), field("leaf")]);
    expect(renderAccess(resolve(leaf)!.access, (b) => (b === outerB.id ? "o" : "i"))).toBe(
      "i.leaf",
    );
  });

  it("complex-union variant field is a plain field off the union path (no variant segment)", () => {
    const bf = str("bf");
    const armB = seq(lit("b"), bf, str("bf2"));
    const altNode = alt(seq(lit("a"), str("af")), armB);
    const expr = seq(lit("tool"), altNode);
    const { resolve } = solve(expr);
    const union = resolve(altNode)!;
    expect(resolve(bf)!.access).toEqual([...union.access, field("bf")]);
    // No segment carries the @type discriminant - that lives in the gate.
    expect(resolve(bf)!.access.every((s) => s.kind === "field" || s.kind === "iter")).toBe(true);
  });
});
