import { describe, expect, it } from "vitest";
import { outputGate } from "../../bindings/index.js";
import { defaultPipeline } from "../../ir/index.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { BoutiquesParser } from "./parser.js";

const parser = new BoutiquesParser();

function pipeline(descriptor: Record<string, unknown>) {
  const parseResult = parser.parse(JSON.stringify(descriptor));
  expect(parseResult.errors).toEqual([]);
  const optimized = defaultPipeline.apply(parseResult.expr);
  const solveResult = solve(optimized.expr);
  const resolution = resolveOutputs(optimized.expr, solveResult);
  return { parseResult, optimized: optimized.expr, solveResult, resolution };
}

function singleOutput(resolution: ReturnType<typeof resolveOutputs>) {
  const flat = resolution.scopes.flatMap((s) => s.outputs);
  return flat[0];
}

describe("Boutiques end-to-end with output-files", () => {
  it("round-trips a simple [INPUT].out template through parse -> optimize -> solve", () => {
    const { solveResult, resolution } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [{ id: "input_file", name: "Input file", type: "File", "value-key": "[INPUT_FILE]" }],
      "output-files": [
        { id: "output_file", name: "Output file", "path-template": "[INPUT_FILE].out" },
      ],
    });

    expect(resolution.diagnostics.errors).toEqual([]);
    const out = singleOutput(resolution)!;
    expect(out.name).toBe("output_file");
    expect(out.tokens).toHaveLength(2);
    expect(out.tokens[0]?.kind).toBe("ref");
    expect(out.tokens[1]).toEqual({ kind: "literal", value: ".out" });

    if (out.tokens[0]?.kind === "ref") {
      const refBinding = solveResult.bindings.get(out.tokens[0].binding);
      expect(refBinding?.name).toBe("input_file");
      expect(refBinding?.gate).toEqual([]);
    }
  });

  it("preserves the referenced name across optimization (flagged input)", () => {
    const { solveResult, resolution } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [
        {
          id: "input_file",
          name: "Input file",
          type: "File",
          "value-key": "[INPUT_FILE]",
          "command-line-flag": "--in",
        },
      ],
      "output-files": [{ id: "out", name: "Output", "path-template": "[INPUT_FILE].log" }],
    });

    expect(resolution.diagnostics.errors).toEqual([]);
    const ref = singleOutput(resolution)!.tokens.find((t) => t.kind === "ref");
    expect(ref).toBeDefined();
    if (ref?.kind === "ref") {
      expect(solveResult.bindings.get(ref.binding)?.name).toBe("input_file");
    }
  });

  it("an output referencing an optional input is gated via a `present` atom", () => {
    const { solveResult, resolution } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [
        {
          id: "input_file",
          name: "Input file",
          type: "File",
          "value-key": "[INPUT_FILE]",
          optional: true,
        },
      ],
      "output-files": [{ id: "out", name: "Output", "path-template": "[INPUT_FILE].out" }],
    });

    expect(resolution.diagnostics.errors).toEqual([]);
    const out = singleOutput(resolution)!;
    const ref = out.tokens.find((t) => t.kind === "ref");
    expect(ref).toMatchObject({ kind: "ref", fallback: "" });
    const scope = resolution.scopes[0]!;
    const scopeGate = solveResult.bindings.get(scope.scope)?.gate ?? [];
    const gate = outputGate(scopeGate, out, solveResult.bindings);
    expect(gate.some((a) => a.kind === "present")).toBe(true);
  });

  it("propagates path-template-stripped-extensions onto ref tokens", () => {
    const { resolution } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [{ id: "input_file", name: "Input file", type: "File", "value-key": "[INPUT_FILE]" }],
      "output-files": [
        {
          id: "out",
          name: "Output",
          "path-template": "[INPUT_FILE].out",
          "path-template-stripped-extensions": [".nii", ".nii.gz"],
        },
      ],
    });
    const out = singleOutput(resolution)!;
    expect(out.tokens.find((t) => t.kind === "ref")).toMatchObject({
      kind: "ref",
      stripExtensions: [".nii", ".nii.gz"],
    });
  });

  it("ignores the `optional: true` hint on output-files (re-derived at emit time)", () => {
    const { solveResult, resolution } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [{ id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]" }],
      "output-files": [
        { id: "maybe", name: "Maybe", "path-template": "[INPUT_FILE].extra", optional: true },
      ],
    });
    expect(resolution.diagnostics.errors).toEqual([]);
    const out = singleOutput(resolution)!;
    // The input is required, so the ref binding has no gate; the (dropped) hint
    // would have made it optional, but we re-derive structural optionality only.
    const ref = out.tokens.find((t) => t.kind === "ref");
    if (ref?.kind === "ref") {
      expect(solveResult.bindings.get(ref.binding)?.gate).toEqual([]);
    }
  });

  it("subcommand inputs carry a `variant` atom for the arm that selects them", () => {
    const { solveResult, resolution } = pipeline({
      name: "tool",
      "command-line": "tool [SUBCMD]",
      inputs: [
        {
          id: "subcmd",
          "value-key": "[SUBCMD]",
          type: [
            {
              id: "join",
              "command-line": "join [A] [B]",
              inputs: [
                { id: "a", "value-key": "[A]", type: "File" },
                { id: "b", "value-key": "[B]", type: "File" },
              ],
              "output-files": [{ id: "joined", name: "Joined", "path-template": "[A]_[B].out" }],
            },
            {
              id: "noop",
              "command-line": "noop",
              inputs: [],
            },
          ],
        },
      ],
    });
    expect(resolution.diagnostics.errors).toEqual([]);
    const out = singleOutput(resolution)!;
    expect(out.name).toBe("joined");
    expect(out.tokens.filter((t) => t.kind === "ref")).toHaveLength(2);
    const ref = out.tokens.find((t) => t.kind === "ref");
    if (ref?.kind === "ref") {
      const refBinding = solveResult.bindings.get(ref.binding)!;
      const variant = refBinding.gate.find((a) => a.kind === "variant");
      expect(variant).toBeDefined();
      if (variant?.kind === "variant") expect(variant.variant).toBe("join");
    }
  });

  it("attaches a subcommand's output-files to nodes inside that arm", () => {
    const { solveResult, resolution } = pipeline({
      name: "tool",
      "command-line": "tool [SUBCMD]",
      inputs: [
        {
          id: "subcmd",
          "value-key": "[SUBCMD]",
          type: [
            {
              id: "convert",
              "command-line": "convert [SRC]",
              inputs: [{ id: "src", "value-key": "[SRC]", type: "File" }],
              "output-files": [
                { id: "converted", name: "Converted", "path-template": "[SRC].conv" },
              ],
            },
            {
              id: "inspect",
              "command-line": "inspect [TARGET]",
              inputs: [{ id: "target", "value-key": "[TARGET]", type: "File" }],
            },
          ],
        },
      ],
    });

    expect(resolution.diagnostics.errors).toEqual([]);
    const out = singleOutput(resolution)!;
    expect(out.name).toBe("converted");
    const ref = out.tokens.find((t) => t.kind === "ref");
    if (ref?.kind === "ref") {
      const refBinding = solveResult.bindings.get(ref.binding)!;
      expect(refBinding.name).toBe("src");
      const variant = refBinding.gate.find((a) => a.kind === "variant");
      expect(variant).toBeDefined();
      if (variant?.kind === "variant") expect(variant.variant).toBe("convert");
    }
  });

  it("emits no diagnostics for an internally consistent multi-ref output", () => {
    const { resolution } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE] [OUT]",
      inputs: [
        { id: "input_file", name: "Input", type: "File", "value-key": "[INPUT_FILE]" },
        { id: "out_path", name: "Out", type: "String", "value-key": "[OUT]" },
      ],
      "output-files": [
        { id: "result", name: "Result", "path-template": "[OUT]/[INPUT_FILE].result" },
      ],
    });
    expect(resolution.diagnostics.errors).toEqual([]);
  });
});
