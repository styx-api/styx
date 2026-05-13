import { describe, expect, it } from "vitest";
import { alt, lit, nodeRef, opt, path, rep, seq, str } from "../ir/index.js";
import type { Expr, Output } from "../ir/index.js";
import { solve } from "./solver.js";

/** Attach outputs to a node and return it (typed-through helper for tests). */
function withOutputs<T extends Expr>(node: T, outputs: Output[]): T {
  node.meta = { ...node.meta, outputs };
  return node;
}

describe("resolveOutputs", () => {
  it("returns empty when no node carries outputs", () => {
    const result = solve(seq(lit("cmd"), str("input")));
    expect(result.outputs).toEqual([]);
  });

  it("resolves a literal-only output hosted on the root as always-emitted", () => {
    const expr = withOutputs(seq(lit("cmd")), [
      { name: "log", tokens: [{ kind: "literal", value: "run.log" }] },
    ]);
    const result = solve(expr);
    expect(result.outputs).toHaveLength(1);
    const out = result.outputs[0]!;
    expect(out.name).toBe("log");
    expect(out.tokens).toEqual([{ kind: "literal", value: "run.log" }]);
    expect(out.branchCondition).toEqual([[]]);
    expect(out.optional).toBe(false);
    expect(out.listScope).toEqual([]);
  });

  it("resolves a token ref to the outermost binding with that name", () => {
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
    const out = result.outputs[0]!;
    const inputBinding = [...result.bindings.values()].find(
      (b) => b.name === "input" && b.type.kind === "scalar",
    );
    expect(inputBinding).toBeDefined();
    expect(out.tokens[0]).toEqual({ kind: "ref", binding: inputBinding!.id });
    expect(out.tokens[1]).toEqual({ kind: "literal", value: ".out" });
    expect(out.branchCondition).toEqual([[]]);
    expect(out.optional).toBe(false);
  });

  it("includes an optional host as a 'present' atom in branchCondition", () => {
    const host = withOutputs(opt(seq(lit("--out"), path("output"))), [
      { name: "out_path", tokens: [{ kind: "ref", target: nodeRef("output") }] },
    ]);
    const result = solve(seq(lit("cmd"), host));
    const out = result.outputs[0]!;
    const optBinding = [...result.bindings.values()].find((b) => b.type.kind === "optional");
    expect(optBinding).toBeDefined();
    expect(out.branchCondition).toEqual([[{ kind: "present", binding: optBinding!.id }]]);
    expect(out.optional).toBe(true);
    // the token ref resolves to that same (outermost) binding
    expect(out.tokens[0]).toEqual({ kind: "ref", binding: optBinding!.id });
  });

  it("gates an output hosted inside an alternative arm on that arm being selected", () => {
    const armA = seq(lit("--a"), path("a"));
    armA.meta = {
      name: "alpha",
      outputs: [{ name: "out", tokens: [{ kind: "ref", target: nodeRef("a") }] }],
    };
    const armB = seq(lit("--b"), path("b"));
    armB.meta = { name: "beta" };
    const result = solve(seq(lit("cmd"), alt(armA, armB)));
    const out = result.outputs[0]!;
    const unionBinding = [...result.bindings.values()].find((b) => b.type.kind === "union");
    expect(unionBinding).toBeDefined();
    expect(out.branchCondition).toEqual([
      [{ kind: "variant", binding: unionBinding!.id, variant: "alpha" }],
    ]);
    expect(out.optional).toBe(true);
    const ref = out.tokens.find((t) => t.kind === "ref");
    expect(ref?.kind === "ref" && result.bindings.get(ref.binding)?.name).toBe("a");
  });

  it("includes a repeat host's binding in listScope, not branchCondition", () => {
    const host = withOutputs(rep(path("input")), [
      {
        name: "outs",
        tokens: [
          { kind: "ref", target: nodeRef("input") },
          { kind: "literal", value: ".out" },
        ],
      },
    ]);
    const result = solve(seq(lit("cmd"), host));
    const out = result.outputs[0]!;
    const listBinding = [...result.bindings.values()].find((b) => b.type.kind === "list");
    expect(listBinding).toBeDefined();
    expect(out.listScope).toEqual([listBinding!.id]);
    expect(out.branchCondition).toEqual([[]]);
    expect(out.optional).toBe(false);
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
    expect(result.outputs[0]!.tokens[0]).toMatchObject({
      kind: "ref",
      stripExtensions: [".nii"],
      fallback: "default",
    });
  });

  it("drops dangling token refs but still emits the output", () => {
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
    expect(result.outputs[0]!.tokens).toEqual([{ kind: "literal", value: ".log" }]);
  });

  it("respects Output.optional even when the host is ungated", () => {
    const expr = withOutputs(seq(lit("cmd")), [
      { name: "maybe_log", tokens: [{ kind: "literal", value: "run.log" }], optional: true },
    ]);
    const out = solve(expr).outputs[0]!;
    expect(out.optional).toBe(true);
    // ...but there's no structural gate, so the guard is empty
    expect(out.branchCondition).toEqual([[]]);
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
    const out = result.outputs[0]!;
    expect(out.doc).toEqual({ title: "Output", description: "An output" });
    expect(out.mediaTypes).toEqual(["text/plain"]);
  });

  it("collects multiple outputs from multiple hosts in tree-walk order", () => {
    const a = withOutputs(path("a"), [{ name: "out_a", tokens: [{ kind: "ref", target: nodeRef("a") }] }]);
    const b = withOutputs(path("b"), [{ name: "out_b", tokens: [{ kind: "ref", target: nodeRef("b") }] }]);
    const result = solve(seq(lit("cmd"), a, b));
    expect(result.outputs.map((o) => o.name)).toEqual(["out_a", "out_b"]);
  });
});
