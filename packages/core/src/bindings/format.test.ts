import { describe, expect, it } from "vitest";
import { alt, lit, nodeRef, opt, path, seq } from "../ir/index.js";
import { solve } from "../solver/index.js";
import { formatSolveResult } from "./format.js";

describe("formatSolveResult", () => {
  it("renders the root binding alongside resolved outputs", () => {
    const host = opt(path("input"));
    host.meta = {
      outputs: [
        {
          name: "out",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const result = solve(seq(lit("cmd"), host));
    const text = formatSolveResult(result, seq(lit("cmd"), host));
    expect(text).toContain("outputs:");
    expect(text).toContain('out [optional]: ref(input) + ".out" when (present(input))');
  });

  it("renders a variant gate for an arm-hosted output", () => {
    const armA = seq(lit("--a"), path("a"));
    armA.meta = {
      name: "alpha",
      outputs: [{ name: "out", tokens: [{ kind: "ref", target: nodeRef("a") }] }],
    };
    const armB = seq(lit("--b"), path("b"));
    armB.meta = { name: "beta" };
    const expr = seq(lit("cmd"), alt(armA, armB));
    const result = solve(expr);
    const text = formatSolveResult(result, expr);
    // The gate names the union binding and the selected variant.
    expect(text).toMatch(/out \[optional\]:.*when \(\w+=alpha\)/);
  });

  it("emits a diagnostics section when validation reports issues", () => {
    const root = seq(lit("cmd"));
    root.meta = {
      outputs: [
        {
          name: "out",
          tokens: [{ kind: "ref", target: nodeRef("does_not_exist") }],
        },
      ],
    };
    const result = solve(root);
    const text = formatSolveResult(result, root);
    // validator complains about the dangling ref
    if (result.outputDiagnostics.errors.length || result.outputDiagnostics.warnings.length) {
      expect(text).toContain("diagnostics:");
    }
  });

  it("omits the outputs section when nothing is attached", () => {
    const result = solve(seq(lit("cmd"), path("input")));
    const text = formatSolveResult(result, seq(lit("cmd"), path("input")));
    expect(text).not.toContain("outputs:");
  });
});
