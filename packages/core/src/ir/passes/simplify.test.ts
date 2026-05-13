import { describe, expect, it } from "vitest";
import { lit, opt, rep, repJoin, seq, str } from "../builders.js";
import type { Output } from "../meta.js";
import { simplify } from "./simplify.js";

function out(name: string): Output {
  return { name, tokens: [{ kind: "literal", value: `${name}.txt` }] };
}

describe("simplify", () => {
  it("collapses optional(optional(T)) -> optional(T)", () => {
    const result = simplify.apply(opt(opt(str("x"))));
    expect(result.expr.kind).toBe("optional");
    if (result.expr.kind === "optional") {
      expect(result.expr.attrs.node.kind).toBe("str");
    }
  });

  it("collapses repeat(repeat(T)) and merges constraints", () => {
    const inner = repJoin(",", str("x"));
    inner.attrs.countMin = 2;
    inner.attrs.countMax = 8;
    const outer = rep(inner);
    outer.attrs.countMin = 1;
    outer.attrs.countMax = 5;
    const result = simplify.apply(outer);
    expect(result.expr.kind).toBe("repeat");
    if (result.expr.kind === "repeat") {
      expect(result.expr.attrs.node.kind).toBe("str");
      expect(result.expr.attrs.countMin).toBe(2);
      expect(result.expr.attrs.countMax).toBe(5);
      expect(result.expr.attrs.join).toBe(",");
    }
  });

  it("collapses seq(T) -> T with innermost name winning", () => {
    const e = seq(str("inner"));
    e.meta = { name: "outer" };
    const result = simplify.apply(e);
    expect(result.expr.kind).toBe("str");
    expect(result.expr.meta?.name).toBe("inner");
  });

  it("merges consecutive literals", () => {
    const result = simplify.apply(seq(lit("a"), lit("b"), lit("c")));
    expect(result.expr.kind).toBe("literal");
    if (result.expr.kind === "literal") expect(result.expr.attrs.str).toBe("abc");
  });

  it("does not collapse alt(T) when the alt carries metadata", () => {
    const e = { kind: "alternative" as const, attrs: { alts: [str("x")] }, meta: { name: "a" } };
    const result = simplify.apply(e);
    expect(result.expr.kind).toBe("alternative");
  });

  it("carries attached outputs onto the surviving node when a wrapper collapses", () => {
    const e = seq(str("x"));
    e.meta = { outputs: [out("o")] };
    const result = simplify.apply(e);
    expect(result.expr.kind).toBe("str");
    expect(result.expr.meta?.name).toBe("x");
    expect(result.expr.meta?.outputs).toEqual([out("o")]);
  });

  it("concatenates outputs from both layers of a collapsed wrapper", () => {
    const inner = str("x");
    inner.meta = { name: "x", outputs: [out("inner")] };
    const e = seq(inner);
    e.meta = { outputs: [out("outer")] };
    const result = simplify.apply(e);
    expect(result.expr.meta?.outputs?.map((o) => o.name)).toEqual(["outer", "inner"]);
  });
});
