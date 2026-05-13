import { describe, expect, it } from "vitest";
import { lit, nodeRef, path, seq, str } from "../ir/index.js";
import type { Expr, Output } from "../ir/index.js";
import { solve } from "./solver.js";
import { validateOutputs } from "./validate-outputs.js";

function withOutputs<T extends Expr>(node: T, outputs: Output[]): T {
  node.meta = { ...node.meta, outputs };
  return node;
}

describe("validateOutputs", () => {
  it("returns no diagnostics for a clean output", () => {
    const expr = withOutputs(seq(lit("cmd"), path("input")), [
      {
        name: "out",
        tokens: [
          { kind: "ref", target: nodeRef("input") },
          { kind: "literal", value: ".out" },
        ],
      },
    ]);
    const result = solve(expr);
    expect(result.outputDiagnostics).toEqual({ errors: [], warnings: [] });
  });

  it("flags a dangling token ref", () => {
    const expr = withOutputs(seq(lit("cmd"), path("input")), [
      {
        name: "out",
        tokens: [
          { kind: "ref", target: nodeRef("does_not_exist") },
          { kind: "literal", value: ".out" },
        ],
      },
    ]);
    const r = validateOutputs(expr, solve(expr).resolve);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => e.message.includes("does_not_exist"))).toBe(true);
  });

  it("returns no diagnostics when no node carries outputs", () => {
    const expr = seq(lit("cmd"), str("input"));
    expect(validateOutputs(expr, solve(expr).resolve)).toEqual({ errors: [], warnings: [] });
  });

  it("solve() auto-attaches outputDiagnostics", () => {
    const expr = withOutputs(seq(lit("cmd"), path("input")), [
      {
        name: "out",
        tokens: [
          { kind: "ref", target: nodeRef("does_not_exist") },
          { kind: "literal", value: ".out" },
        ],
      },
    ]);
    const result = solve(expr);
    expect(result.outputDiagnostics.errors.some((e) => e.message.includes("does_not_exist"))).toBe(
      true,
    );
  });

  it("synthesizes a name fallback when Output.name is omitted", () => {
    const expr = withOutputs(seq(lit("cmd"), path("input")), [
      { tokens: [{ kind: "ref", target: nodeRef("input") }] },
    ]);
    expect(solve(expr).outputs[0]?.name).toBe("output_0");
  });
});
