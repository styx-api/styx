import { describe, expect, it } from "vitest";
import type { Expr, Float, Int, Path, Repeat } from "../ir/index.js";
import {
  float,
  generateCtx,
  int,
  lit,
  namedAlt,
  opt,
  path,
  rep,
  seq,
  str,
} from "./python/test-helpers.js";
import { buildTypedSpec, type TypedParam } from "./typed-spec.js";

// -- IR construction helpers (mirroring python/validate.test.ts) --

function intRange(name: string, min?: number, max?: number): Int {
  const n = int(name);
  if (min !== undefined) n.attrs.minValue = min;
  if (max !== undefined) n.attrs.maxValue = max;
  return n;
}
function floatRange(name: string, min?: number, max?: number): Float {
  const n = float(name);
  if (min !== undefined) n.attrs.minValue = min;
  if (max !== undefined) n.attrs.maxValue = max;
  return n;
}
function listCount(node: Expr, name: string, min?: number, max?: number): Repeat {
  const r = rep(node, name);
  if (min !== undefined) r.attrs.countMin = min;
  if (max !== undefined) r.attrs.countMax = max;
  return r;
}
function pathMedia(name: string, types: string[]): Path {
  const n = path(name);
  n.attrs.mediaTypes = types;
  return n;
}
function withDefault<T extends Expr>(node: T, dv: string | number | boolean): T {
  node.meta = { ...node.meta, defaultValue: dv };
  return node;
}

function spec(expr: Expr, app = { id: "bet" }, pkg = { name: "fsl" }) {
  return buildTypedSpec(generateCtx(expr, { app, package: pkg }));
}
function param(params: TypedParam[], wireKey: string): TypedParam {
  const p = params.find((x) => x.wireKey === wireKey);
  if (!p) throw new Error(`no param ${wireKey}; have ${params.map((x) => x.wireKey).join(", ")}`);
  return p;
}

describe("buildTypedSpec - delegation handles", () => {
  it("derives the styx module, wrapper, and outputs-class names", () => {
    const s = spec(seq(lit("bet"), path("infile")));
    expect(s.rootIsStruct).toBe(true);
    expect(s.delegation).toEqual({
      moduleName: "bet",
      wrapperFn: "bet",
      outputsClass: "BetOutputs",
    });
  });

  it("always surfaces the synthetic root output", () => {
    const s = spec(seq(lit("bet"), path("infile")));
    expect(s.outputs.some((o) => o.id === "root")).toBe(true);
  });
});

describe("buildTypedSpec - scalar types and constraints", () => {
  it("extracts a numeric int range and marks a bare field mandatory", () => {
    const p = param(spec(seq(lit("bet"), intRange("iters", 1, 100))).params, "iters");
    expect(p.kind).toBe("int");
    expect(p.range).toEqual({ min: 1, max: 100 });
    expect(p.mandatory).toBe(true);
    expect(p.optional).toBe(false);
    expect(p.hasDefault).toBe(false);
  });

  it("extracts a float range and carries its default (non-mandatory)", () => {
    const p = param(
      spec(seq(lit("bet"), withDefault(floatRange("frac", 0, 1), 0.5))).params,
      "frac",
    );
    expect(p.kind).toBe("float");
    expect(p.range).toEqual({ min: 0, max: 1 });
    expect(p.hasDefault).toBe(true);
    expect(p.default).toBe(0.5);
    expect(p.mandatory).toBe(false);
  });

  it("captures file media types on a path field", () => {
    const p = param(spec(seq(lit("bet"), pathMedia("infile", ["image/nifti"]))).params, "infile");
    expect(p.kind).toBe("path");
    expect(p.mediaTypes).toEqual(["image/nifti"]);
  });
});

describe("buildTypedSpec - flags, enums, lists", () => {
  it("models a presence flag as an optional/defaulted bool", () => {
    const p = param(
      spec(seq(lit("bet"), opt(lit("-v"), { name: "verbose", defaultValue: false }))).params,
      "verbose",
    );
    expect(p.kind).toBe("bool");
    expect(p.hasDefault).toBe(true);
    expect(p.default).toBe(false);
    expect(p.mandatory).toBe(false);
  });

  it("extracts enum choices from a union of literals", () => {
    const p = param(
      spec(seq(lit("bet"), namedAlt("mode", lit("fast"), lit("robust")))).params,
      "mode",
    );
    expect(p.kind).toBe("enum");
    expect(p.choices).toEqual(["fast", "robust"]);
  });

  it("extracts list bounds and the element type", () => {
    const p = param(
      spec(seq(lit("bet"), opt(seq(lit("-c"), listCount(int("center"), "center", 3, 3))))).params,
      "center",
    );
    expect(p.kind).toBe("list");
    expect(p.listBounds).toEqual({ min: 3, max: 3 });
    expect(p.itemType?.kind).toBe("int");
    expect(p.optional).toBe(true);
    expect(p.mandatory).toBe(false);
  });
});

describe("buildTypedSpec - degradation", () => {
  it("degrades a discriminated union field to kind 'union'", () => {
    const p = param(
      spec(
        seq(
          lit("bet"),
          namedAlt("source", seq(lit("--file"), path("f")), seq(lit("--url"), str("u"))),
        ),
      ).params,
      "source",
    );
    expect(p.kind).toBe("union");
  });

  it("flags a non-struct root and surfaces no params", () => {
    const s = spec(rep(str("item")));
    expect(s.rootIsStruct).toBe(false);
    expect(s.params).toEqual([]);
  });
});
