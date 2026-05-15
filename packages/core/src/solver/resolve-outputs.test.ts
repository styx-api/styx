import { describe, expect, it } from "vitest";
import { outputGate } from "../bindings/index.js";
import type { Expr, Output } from "../ir/index.js";
import { alt, lit, nodeRef, opt, path, rep, seq, str } from "../ir/index.js";
import { resolveOutputs } from "./resolve-outputs.js";
import { solve } from "./solver.js";

/** Attach outputs to a node and return it (typed-through helper for tests). */
function withOutputs<T extends Expr>(node: T, outputs: Output[]): T {
  node.meta = { ...node.meta, outputs };
  return node;
}

describe("resolveOutputs", () => {
  it("returns no scopes when no node carries outputs", () => {
    const expr = seq(lit("cmd"), str("input"));
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);
    expect(resolution.scopes).toEqual([]);
  });

  it("collects a literal-only output on the root sequence", () => {
    const expr = withOutputs(seq(lit("cmd")), [
      { name: "log", tokens: [{ kind: "literal", value: "run.log" }] },
    ]);
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);
    expect(resolution.scopes).toHaveLength(1);
    const scope = resolution.scopes[0]!;
    expect(result.bindings.get(scope.scope)?.node).toBe(expr);
    expect(scope.outputs[0]!.tokens).toEqual([{ kind: "literal", value: "run.log" }]);
  });

  it("resolves a token ref to the binding with that name", () => {
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
    const resolution = resolveOutputs(expr, result);
    const out = resolution.scopes[0]!.outputs[0]!;
    const inputBinding = [...result.bindings.values()].find(
      (b) => b.name === "input" && b.type.kind === "scalar",
    );
    expect(inputBinding).toBeDefined();
    expect(out.tokens[0]).toEqual({ kind: "ref", binding: inputBinding!.id });
    expect(out.tokens[1]).toEqual({ kind: "literal", value: ".out" });
  });

  it("a ref to an optional-typed binding produces a present atom in the output gate", () => {
    const inner = opt(seq(lit("--out"), path("output")));
    const expr = withOutputs(seq(lit("cmd"), inner), [
      { name: "out_path", tokens: [{ kind: "ref", target: nodeRef("output") }] },
    ]);
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);
    const scope = resolution.scopes[0]!;
    const out = scope.outputs[0]!;
    const scopeGate = result.bindings.get(scope.scope)?.gate ?? [];
    const gate = outputGate(scopeGate, out, result.bindings);
    expect(gate.some((a) => a.kind === "present")).toBe(true);
  });

  it("carries a `variant` atom on bindings inside an alternative arm", () => {
    const armA = seq(lit("--a"), path("a"));
    armA.meta = { name: "alpha" };
    const armB = seq(lit("--b"), path("b"));
    armB.meta = { name: "beta" };
    const expr = seq(lit("cmd"), alt(armA, armB));
    const result = solve(expr);
    const aBinding = [...result.bindings.values()].find((b) => b.name === "a");
    expect(aBinding).toBeDefined();
    expect(aBinding!.gate.some((a) => a.kind === "variant" && a.variant === "alpha")).toBe(true);
  });

  it("carries an `iter` atom on bindings inside a repeat", () => {
    const expr = seq(lit("cmd"), rep(path("input")));
    const result = solve(expr);
    const inputBinding = [...result.bindings.values()].find(
      (b) => b.name === "input" && b.type.kind === "scalar",
    );
    expect(inputBinding).toBeDefined();
    expect(inputBinding!.gate.some((a) => a.kind === "iter")).toBe(true);
  });

  it("propagates stripExtensions and fallback through ref tokens", () => {
    const expr = withOutputs(seq(lit("cmd"), path("input")), [
      {
        name: "out",
        tokens: [
          { kind: "ref", target: nodeRef("input"), stripExtensions: [".nii"], fallback: "default" },
        ],
      },
    ]);
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);
    expect(resolution.scopes[0]!.outputs[0]!.tokens[0]).toMatchObject({
      kind: "ref",
      stripExtensions: [".nii"],
      fallback: "default",
    });
  });

  it("reports an error for a dangling ref but still emits the output's remaining tokens", () => {
    const expr = withOutputs(seq(lit("cmd"), str("input")), [
      {
        name: "out",
        tokens: [
          { kind: "ref", target: nodeRef("does_not_exist") },
          { kind: "literal", value: ".log" },
        ],
      },
    ]);
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);
    expect(resolution.diagnostics.errors).toHaveLength(1);
    expect(resolution.scopes[0]!.outputs[0]!.tokens).toEqual([{ kind: "literal", value: ".log" }]);
  });

  it("preserves doc and mediaTypes on the resolved output", () => {
    const expr = withOutputs(seq(lit("cmd")), [
      {
        name: "out",
        doc: { title: "Output", description: "An output" },
        tokens: [{ kind: "literal", value: "run.log" }],
        mediaTypes: ["text/plain"],
      },
    ]);
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);
    const out = resolution.scopes[0]!.outputs[0]!;
    expect(out.doc).toEqual({ title: "Output", description: "An output" });
    expect(out.mediaTypes).toEqual(["text/plain"]);
  });

  it("buckets multiple outputs declared on the same node into one scope", () => {
    const root = withOutputs(seq(lit("cmd"), path("a"), path("b")), [
      { name: "out_a", tokens: [{ kind: "ref", target: nodeRef("a") }] },
      { name: "out_b", tokens: [{ kind: "ref", target: nodeRef("b") }] },
    ]);
    const result = solve(root);
    const resolution = resolveOutputs(root, result);
    expect(resolution.scopes).toHaveLength(1);
    expect(resolution.scopes[0]!.outputs.map((o) => o.name)).toEqual(["out_a", "out_b"]);
  });
});
