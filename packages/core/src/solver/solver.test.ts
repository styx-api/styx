import { describe, expect, it } from "vitest";
import { lit, path, seq, str } from "../ir/builders.js";
import { solve } from "./solver.js";

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

  it("emits an empty root struct for a no-input tool", () => {
    const expr = seq(lit("tool"));
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    const root = resolve(expr);
    expect(root?.type.kind).toBe("struct");
    expect(root?.type.kind === "struct" && Object.keys(root.type.fields)).toEqual([]);
  });
});
