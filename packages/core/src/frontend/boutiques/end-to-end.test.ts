import { describe, expect, it } from "vitest";
import { defaultPipeline } from "../../ir/index.js";
import { solve } from "../../solver/index.js";
import { BoutiquesParser } from "./parser.js";

const parser = new BoutiquesParser();

function pipeline(descriptor: Record<string, unknown>) {
  const parseResult = parser.parse(JSON.stringify(descriptor));
  expect(parseResult.errors).toEqual([]);
  const optimized = defaultPipeline.apply(parseResult.expr);
  const solveResult = solve(optimized.expr);
  return { parseResult, optimized: optimized.expr, solveResult };
}

describe("Boutiques end-to-end with output-files", () => {
  it("round-trips a simple [INPUT].out template through parse -> optimize -> solve", () => {
    const { solveResult } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [{ id: "input_file", name: "Input file", type: "File", "value-key": "[INPUT_FILE]" }],
      "output-files": [
        { id: "output_file", name: "Output file", "path-template": "[INPUT_FILE].out" },
      ],
    });

    expect(solveResult.outputDiagnostics.errors).toEqual([]);
    expect(solveResult.outputs).toHaveLength(1);

    const out = solveResult.outputs[0]!;
    expect(out.name).toBe("output_file");
    expect(out.tokens).toHaveLength(2);
    expect(out.tokens[0]?.kind).toBe("ref");
    expect(out.tokens[1]).toEqual({ kind: "literal", value: ".out" });

    if (out.tokens[0]?.kind === "ref") {
      expect(solveResult.bindings.get(out.tokens[0].binding)?.name).toBe("input_file");
    }
    // required input, hosted at/above no optional -> always emitted
    expect(out.branchCondition).toEqual([[]]);
    expect(out.optional).toBe(false);
    expect(out.listScope).toEqual([]);
  });

  it("preserves the referenced name across optimization (flagged input)", () => {
    const { solveResult } = pipeline({
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

    expect(solveResult.outputDiagnostics.errors).toEqual([]);
    const ref = solveResult.outputs[0]!.tokens.find((t) => t.kind === "ref");
    expect(ref).toBeDefined();
    if (ref?.kind === "ref") {
      expect(solveResult.bindings.get(ref.binding)?.name).toBe("input_file");
    }
  });

  it("marks the output optional when the referenced input is optional", () => {
    const { solveResult } = pipeline({
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

    expect(solveResult.outputDiagnostics.errors).toEqual([]);
    const out = solveResult.outputs[0]!;
    expect(out.optional).toBe(true);
    expect(out.branchCondition[0]?.length).toBeGreaterThan(0);
    // Boutiques substitutes an unset optional with "" -> fallback carried through.
    const ref = out.tokens.find((t) => t.kind === "ref");
    expect(ref).toMatchObject({ kind: "ref", fallback: "" });
  });

  it("propagates path-template-stripped-extensions onto ref tokens", () => {
    const { solveResult } = pipeline({
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
    expect(solveResult.outputs[0]?.tokens.find((t) => t.kind === "ref")).toMatchObject({
      kind: "ref",
      stripExtensions: [".nii", ".nii.gz"],
    });
  });

  it("marks the output optional when output-files[].optional is set", () => {
    const { solveResult } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [{ id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]" }],
      "output-files": [
        { id: "maybe", name: "Maybe", "path-template": "[INPUT_FILE].extra", optional: true },
      ],
    });
    expect(solveResult.outputDiagnostics.errors).toEqual([]);
    const out = solveResult.outputs[0]!;
    expect(out.optional).toBe(true);
    // input is required and not gated -> the guard is empty; optionality comes
    // purely from the Boutiques `optional` flag
    expect(out.branchCondition).toEqual([[]]);
  });

  it("hosts a subcommand output that spans two of the arm's inputs on the arm", () => {
    const { solveResult } = pipeline({
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
    expect(solveResult.outputDiagnostics.errors).toEqual([]);
    expect(solveResult.outputs.map((o) => o.name)).toEqual(["joined"]);
    const out = solveResult.outputs[0]!;
    // hosted on the `join` arm (LCA of A and B) -> gated on the `join` variant
    expect(out.optional).toBe(true);
    const atom = out.branchCondition[0]![0]!;
    expect(atom.kind).toBe("variant");
    if (atom.kind === "variant") expect(atom.variant).toBe("join");
    // both refs resolved
    expect(out.tokens.filter((t) => t.kind === "ref")).toHaveLength(2);
  });

  it("attaches a subcommand's output-files to nodes inside that arm", () => {
    const { solveResult } = pipeline({
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
              "output-files": [{ id: "converted", name: "Converted", "path-template": "[SRC].conv" }],
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

    expect(solveResult.outputDiagnostics.errors).toEqual([]);
    expect(solveResult.outputs.map((o) => o.name)).toEqual(["converted"]);
    const out = solveResult.outputs[0]!;
    const ref = out.tokens.find((t) => t.kind === "ref");
    expect(ref).toBeDefined();
    if (ref?.kind === "ref") {
      expect(solveResult.bindings.get(ref.binding)?.name).toBe("src");
    }
    // gated on the "convert" arm being selected
    expect(out.optional).toBe(true);
    expect(out.branchCondition).toHaveLength(1);
    expect(out.branchCondition[0]).toHaveLength(1);
    const atom = out.branchCondition[0]![0]!;
    expect(atom.kind).toBe("variant");
    if (atom.kind === "variant") {
      expect(atom.variant).toBe("convert");
      expect(solveResult.bindings.get(atom.binding)?.type.kind).toBe("union");
    }
  });

  it("emits no diagnostics for an internally consistent multi-ref output", () => {
    const { solveResult } = pipeline({
      name: "tool",
      "command-line": "tool [INPUT_FILE] [OUT]",
      inputs: [
        { id: "input_file", name: "Input", type: "File", "value-key": "[INPUT_FILE]" },
        { id: "out_path", name: "Out", type: "String", "value-key": "[OUT]" },
      ],
      "output-files": [{ id: "result", name: "Result", "path-template": "[OUT]/[INPUT_FILE].result" }],
    });
    expect(solveResult.outputDiagnostics.errors).toEqual([]);
    // two distinct inputs referenced -> hosted on the root, always emitted
    expect(solveResult.outputs[0]?.optional).toBe(false);
  });
});
