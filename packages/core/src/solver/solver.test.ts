import { describe, expect, it } from "vitest";
import { alt, float, lit, opt, path, seq, str } from "../ir/builders.js";
import type { SolveResult } from "../bindings/index.js";
import { solve } from "./solver.js";

/** Assert no binding's access path has two consecutive same-named fields (`params.X.X`). */
function expectNoRepeatedFieldSegments(result: SolveResult): void {
  for (const b of result.bindings.values()) {
    for (let i = 1; i < b.access.length; i++) {
      const prev = b.access[i - 1]!;
      const cur = b.access[i]!;
      const doubled = prev.kind === "field" && cur.kind === "field" && prev.name === cur.name;
      expect(
        doubled,
        `binding ${b.name} has a doubled field segment ${cur.kind === "field" ? cur.name : ""}`,
      ).toBe(false);
    }
  }
}

describe("solver union @type tags", () => {
  it("derives the variant tag from variantTag, surviving a single-field collapse", () => {
    // The mrcalc shape: two distinct sub-commands (VariousString / VariousFile)
    // each collapse onto a single inner field both named "obj". Using `name`
    // alone would tag both `obj` (the second arm unreachable at runtime);
    // `variantTag` carries the sub-command id through the collapse so the tags
    // stay distinct and both arms are reachable.
    const asStr = str({ name: "obj", variantTag: "VariousString" });
    const asFile = path({ name: "obj", variantTag: "VariousFile" });
    const altNode = alt(asStr, asFile);
    const expr = seq(lit("tool"), altNode);
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    const u = resolve(altNode);
    expect(u?.type.kind).toBe("union");
    const tags = u?.type.kind === "union" ? u.type.variants.map((v) => v.name) : [];
    expect(tags).toEqual(["VariousString", "VariousFile"]);
  });

  it("falls back to name when no variantTag is present", () => {
    const a = seq(lit("--file"), path("file"));
    a.meta = { name: "fromFile" };
    const b = seq(lit("--url"), str("url"));
    b.meta = { name: "fromUrl" };
    const altNode = alt(a, b);
    const expr = seq(lit("tool"), altNode);
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    const u = resolve(altNode);
    const tags = u?.type.kind === "union" ? u.type.variants.map((v) => v.name) : [];
    expect(tags).toEqual(["fromFile", "fromUrl"]);
  });
});

describe("solver root-binding fixup", () => {
  it("wraps a single collapsed field in a root struct", () => {
    // seq(lit, scalar) collapses to the scalar; the fixup must still produce a
    // root struct so backends emit a params interface with the field.
    const expr = seq(lit("bet"), str("input"));
    expr.meta = { name: "bet" };
    const { resolve } = solve(expr);
    const root = resolve(expr);
    expect(root?.type.kind).toBe("struct");
    expect(root?.type.kind === "struct" && Object.keys(root.type.fields)).toEqual(["input"]);
  });

  it("recovers a field buried in a collapsed inner sequence (is-surface shape)", () => {
    // A single-input tool whose input carries a command-line-flag parses to
    // seq(lit, seq(lit, scalar)). When the inner sequence carries a `meta.doc`
    // (but no name), flatten preserves it nested; it then collapses to the
    // scalar, leaving the binding buried one level down. The root fixup must
    // still find it (by recursing through the collapsed sequence) so the params
    // interface gets the `infile` field that cargs references as `params.infile`.
    const infileNode = path("infile");
    const inner = seq(lit("-surface"), infileNode);
    inner.meta = { doc: { title: "Input file", description: "Input to check." } };
    const expr = seq(lit("is-surface"), inner);
    expr.meta = { name: "is-surface" };
    const { resolve } = solve(expr);
    const root = resolve(expr);
    expect(root?.type.kind).toBe("struct");
    expect(root?.type.kind === "struct" && Object.keys(root.type.fields)).toEqual(["infile"]);
    // The struct field name must equal the binding's access-path field, so the
    // emitted interface field matches `params.infile` in cargs.
    const infile = resolve(infileNode);
    expect(infile?.name).toBe("infile");
    expect(infile?.access).toEqual([{ kind: "field", name: "infile" }]);
  });

  it("keeps a single-optional-field sequence as a struct (does not collapse)", () => {
    // An option with no value of its own but a nested sub-flag, e.g.
    // `-whole-file [-demean]`: opt(seq[whole_file](lit, opt[demean](lit))).
    // The flag can be present while the sub-flag is absent, so collapsing the
    // single field would conflate the two optional states and drop `demean`.
    // The sequence must stay a struct so `demean` is addressable as
    // `params.whole_file.demean` (not promoted to a non-existent root field).
    const demean = opt(lit("-demean"), { name: "demean" });
    const inner = seq(lit("-whole-file"), demean);
    inner.meta = { name: "whole_file" };
    const expr = seq(lit("tool"), opt(inner));
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);

    const struct = resolve(inner);
    expect(struct?.type.kind).toBe("struct");
    expect(struct?.type.kind === "struct" && Object.keys(struct.type.fields)).toEqual(["demean"]);

    const demeanBinding = resolve(demean);
    expect(demeanBinding?.access).toEqual([
      { kind: "field", name: "whole_file" },
      { kind: "field", name: "demean" },
    ]);
  });

  it("still collapses a single required-value field (-x <val> shape)", () => {
    // The collapse exception is narrow: a required scalar field stays collapsed,
    // so `-x <val>` reads as one optional value, not a struct wrapper.
    const val = str("val");
    const inner = seq(lit("-x"), val);
    inner.meta = { name: "x" };
    const expr = seq(lit("tool"), opt(inner));
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    // The inner sequence collapsed - no struct binding registered for it.
    expect(resolve(inner)).toBeUndefined();
    expect(resolve(val)?.access).toEqual([{ kind: "field", name: "x" }]);
  });

  it("emits an empty root struct for a no-input tool", () => {
    const expr = seq(lit("tool"));
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    const root = resolve(expr);
    expect(root?.type.kind).toBe("struct");
    expect(root?.type.kind === "struct" && Object.keys(root.type.fields)).toEqual([]);
  });
});

describe("solver anonymous struct naming", () => {
  it("names a surviving anonymous struct structN, not its first field", () => {
    // bet shape: an anonymous multi-field aggregate (`set(...)`) whose first
    // field is `fractional_intensity`. Naming the struct after its first field
    // (the old `findDeepName` behavior) collided with that field, producing a
    // `params.fractional_intensity.fractional_intensity` access. The struct must
    // instead get a synthetic name that cannot clash with its own fields.
    const fInt = float({ name: "fractional_intensity" });
    const setNode = seq(
      opt(seq(lit("-f"), fInt)),
      opt(seq(lit("-g"), float({ name: "vg_fractional_intensity" }))),
    );
    const expr = seq(lit("bet"), path({ name: "infile" }), setNode);
    expr.meta = { name: "bet" };
    const result = solve(expr);

    const struct = result.resolve(setNode);
    expect(struct?.type.kind).toBe("struct");
    expect(struct?.name).toBe("struct1");
    // Its own name must not be one of its field names.
    expect(struct?.type.kind === "struct" && Object.keys(struct.type.fields)).not.toContain(
      "struct1",
    );

    // The parent struct keys the child by its synthetic name, and the field
    // keeps its own name: no doubled `params.X.X` path.
    const fBinding = result.resolve(fInt);
    expect(fBinding?.access).toEqual([
      { kind: "field", name: "struct1" },
      { kind: "field", name: "fractional_intensity" },
    ]);
    expectNoRepeatedFieldSegments(result);
  });

  it("skips a synthetic name that collides with an existing field (struct1 -> struct2)", () => {
    // A field literally named `struct1` forces the namer past its first
    // candidate so the struct's own name still cannot clash with a field.
    const collide = float({ name: "struct1" });
    const setNode = seq(
      opt(seq(lit("-a"), collide)),
      opt(seq(lit("-b"), float({ name: "other" }))),
    );
    const expr = seq(lit("tool"), path({ name: "infile" }), setNode);
    expr.meta = { name: "tool" };
    const result = solve(expr);

    const struct = result.resolve(setNode);
    expect(struct?.name).toBe("struct2");
    expect(struct?.type.kind === "struct" && Object.keys(struct.type.fields)).toContain("struct1");
    expectNoRepeatedFieldSegments(result);
  });

  it("does not overwrite a sibling literally named structN (sibling before struct)", () => {
    // A sibling scalar named `struct1` already claims `params.struct1`. The
    // anonymous struct's minted `struct1` would collide with it in the parent's
    // field record; the solver must rename the struct (to `struct2`) so both
    // parameters survive rather than one silently clobbering the other.
    const sibling = float({ name: "struct1" });
    const anon = seq(
      opt(seq(lit("-a"), float({ name: "aa" }))),
      opt(seq(lit("-b"), float({ name: "bb" }))),
    );
    const expr = seq(lit("tool"), opt(seq(lit("-x"), sibling)), anon);
    expr.meta = { name: "tool" };
    const result = solve(expr);

    const root = result.resolve(expr);
    const keys = root?.type.kind === "struct" ? Object.keys(root.type.fields).sort() : [];
    expect(keys).toEqual(["struct1", "struct2"]);
    expect(result.resolve(sibling)?.name).toBe("struct1");
    expect(result.resolve(anon)?.name).toBe("struct2");
    expectNoRepeatedFieldSegments(result);
  });

  it("does not overwrite a sibling literally named structN (struct before sibling)", () => {
    // Reverse order: the anonymous struct is minted as `struct1` first, then a
    // later sibling named `struct1` arrives. The solver must move the struct
    // aside (to `struct2`) rather than let the sibling clobber it.
    const sibling = float({ name: "struct1" });
    const anon = seq(
      opt(seq(lit("-a"), float({ name: "aa" }))),
      opt(seq(lit("-b"), float({ name: "bb" }))),
    );
    const expr = seq(lit("tool"), anon, opt(seq(lit("-x"), sibling)));
    expr.meta = { name: "tool" };
    const result = solve(expr);

    const root = result.resolve(expr);
    const keys = root?.type.kind === "struct" ? Object.keys(root.type.fields).sort() : [];
    expect(keys).toEqual(["struct1", "struct2"]);
    expect(result.resolve(sibling)?.name).toBe("struct1");
    expect(result.resolve(anon)?.name).toBe("struct2");
    expectNoRepeatedFieldSegments(result);
  });
});
