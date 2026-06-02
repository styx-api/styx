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

  it("resolves a ref to the scalar field, not the same-named enclosing struct", () => {
    // An unnamed multi-field struct inherits its first field's name via
    // findDeepName, so the struct binding and the `file` scalar both get the
    // name "file". A ref must resolve to the interpolable scalar (whose access
    // is the loop var + field), not the struct (whose access is the bare loop
    // var), even though the struct sits shallower.
    const fileNode = path("file");
    const expr = withOutputs(seq(lit("cmd"), rep(seq(fileNode, str("id")), "items")), [
      {
        name: "out",
        tokens: [
          { kind: "ref", target: nodeRef("file") },
          { kind: "literal", value: ".out" },
        ],
      },
    ]);
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);
    const out = resolution.scopes[0]!.outputs[0]!;
    const fileBinding = result.resolve(fileNode)!;
    expect(fileBinding.type.kind).toBe("scalar");
    expect(out.tokens[0]).toEqual({ kind: "ref", binding: fileBinding.id });
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

  it("resolves a per-arm output ref to its own arm's same-named binding", () => {
    // ants DenoiseImage shape: a union whose two arms both declare a field
    // named `out` and an output referencing it. A global name index would
    // collapse the two `out` bindings into one, so the first arm's output would
    // pick up the second arm's variant gate - producing a contradictory
    // `variant alpha && variant beta` gate that types to `never` in TS.
    const armA = withOutputs(seq(lit("--a"), str("out")), [
      { name: "out_file", tokens: [{ kind: "ref", target: nodeRef("out") }] },
    ]);
    armA.meta = { ...armA.meta, name: "alpha" };
    const armB = withOutputs(seq(lit("--b"), str("out"), opt(str("extra"))), [
      { name: "out_file", tokens: [{ kind: "ref", target: nodeRef("out") }] },
    ]);
    armB.meta = { ...armB.meta, name: "beta" };
    const expr = seq(lit("cmd"), alt(armA, armB));
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);

    // Two scopes (one per arm), each output gated by exactly its own variant.
    expect(resolution.scopes).toHaveLength(2);
    for (const scope of resolution.scopes) {
      const scopeGate = result.bindings.get(scope.scope)?.gate ?? [];
      const armVariant = scopeGate.find((a) => a.kind === "variant");
      expect(armVariant).toBeDefined();
      const out = scope.outputs[0]!;
      const gate = outputGate(scopeGate, out, result.bindings);
      const variants = gate.filter((a) => a.kind === "variant");
      // Exactly one variant atom, matching this arm's - not a mix of both.
      expect(variants).toHaveLength(1);
      expect(variants[0]).toEqual(armVariant);
      // The ref binding is the one declared in this arm's subtree.
      const refToken = out.tokens.find((t) => t.kind === "ref")!;
      const refBinding = result.bindings.get(refToken.binding!)!;
      expect(
        refBinding.gate.some((a) => a.kind === "variant" && a.variant === armVariant!.variant),
      ).toBe(true);
    }
  });

  it("resolves an output ref on a collapsed bare-scalar arm to that arm's boxed binding", () => {
    // Exact ants DenoiseImage shape: one arm is a bare scalar (no flag), so it
    // collapses and the solver boxes its lone field's binding ONTO the arm node
    // itself (the scope node). The arm's output ref must resolve to that
    // depth-0 binding - whose access path is the field and whose gate is the
    // arm's variant - not to the other arm's same-named field.
    // The bare-scalar arm's variant name coincides with its field name (as in
    // DenoiseImage, where both are `correctedOutputFileName`).
    const armA = str("out");
    armA.meta = {
      name: "out",
      outputs: [{ name: "out_file", tokens: [{ kind: "ref", target: nodeRef("out") }] }],
    };
    const armB = withOutputs(seq(lit("--b"), str("out"), opt(str("extra"))), [
      { name: "out_file", tokens: [{ kind: "ref", target: nodeRef("out") }] },
    ]);
    armB.meta = { ...armB.meta, name: "beta" };
    const expr = seq(lit("cmd"), alt(armA, armB));
    const result = solve(expr);
    const resolution = resolveOutputs(expr, result);

    expect(resolution.scopes).toHaveLength(2);
    for (const scope of resolution.scopes) {
      const scopeGate = result.bindings.get(scope.scope)?.gate ?? [];
      const armVariant = scopeGate.find((a) => a.kind === "variant");
      expect(armVariant).toBeDefined();
      const out = scope.outputs[0]!;
      const gate = outputGate(scopeGate, out, result.bindings);
      // Exactly one variant atom - the arm's own - not a contradictory mix.
      expect(gate.filter((a) => a.kind === "variant")).toHaveLength(1);
      expect(gate.find((a) => a.kind === "variant")).toEqual(armVariant);
    }
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
