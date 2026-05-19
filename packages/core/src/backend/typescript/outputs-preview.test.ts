/**
 * Preview harness for the TS backend's outputs work. Logs generated code so
 * you can iterate on the codegen visually. Gated on `STYX_PREVIEW=1` to avoid
 * polluting normal test runs:
 *
 *   STYX_PREVIEW=1 npx vitest run outputs-preview --reporter=verbose
 *
 * Each fixture is a Boutiques descriptor exercising a distinct output shape
 * (literal-only, ref to required input, ref to optional input, list, variant).
 */
import { describe, it } from "vitest";
import { defaultPipeline } from "../../ir/index.js";
import { BoutiquesParser } from "../../frontend/boutiques/parser.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { createContext } from "../../manifest/context.js";
import { generateTypeScript } from "./typescript.js";

const parser = new BoutiquesParser();

function compile(descriptor: Record<string, unknown>): string {
  const { expr, meta } = parser.parse(JSON.stringify(descriptor));
  const optimized = defaultPipeline.apply(expr).expr;
  const solveResult = solve(optimized);
  const outputs = resolveOutputs(optimized, solveResult);
  const ctx = createContext(optimized, solveResult, outputs, { app: meta });
  return generateTypeScript(ctx);
}

function header(label: string): string {
  const bar = "=".repeat(80);
  return `\n${bar}\n${label}\n${bar}`;
}

const PREVIEW = process.env.STYX_PREVIEW === "1";

(PREVIEW ? describe : describe.skip)("outputs preview", () => {
  it("dumps: literal-only output", () => {
    const code = compile({
      name: "tool",
      id: "tool",
      "command-line": "tool [INPUT]",
      inputs: [{ id: "input", name: "Input", type: "File", "value-key": "[INPUT]" }],
      "output-files": [{ id: "log", "path-template": "run.log" }],
    });
    console.log(header("literal-only output"));
    console.log(code);
  });

  it("dumps: ref to required input", () => {
    const code = compile({
      name: "tool",
      id: "tool",
      "command-line": "tool [INPUT]",
      inputs: [{ id: "input", name: "Input", type: "File", "value-key": "[INPUT]" }],
      "output-files": [{ id: "out_file", "path-template": "[INPUT].out" }],
    });
    console.log(header("ref to required input"));
    console.log(code);
  });

  it("dumps: ref to optional input", () => {
    const code = compile({
      name: "tool",
      id: "tool",
      "command-line": "tool [INPUT]",
      inputs: [
        { id: "input", name: "Input", type: "File", "value-key": "[INPUT]", optional: true },
      ],
      "output-files": [{ id: "out_file", "path-template": "[INPUT].out" }],
    });
    console.log(header("ref to optional input"));
    console.log(code);
  });

  it("dumps: ref to list input", () => {
    const code = compile({
      name: "tool",
      id: "tool",
      "command-line": "tool [INPUTS]",
      inputs: [{ id: "inputs", name: "Inputs", type: "File", "value-key": "[INPUTS]", list: true }],
      "output-files": [{ id: "outs", "path-template": "[INPUTS].out" }],
    });
    console.log(header("ref to list input"));
    console.log(code);
  });

  it("dumps: output in alt arm", () => {
    const code = compile({
      name: "tool",
      id: "tool",
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
              "output-files": [{ id: "converted", "path-template": "[SRC].conv" }],
            },
            { id: "inspect", "command-line": "inspect", inputs: [] },
          ],
        },
      ],
    });
    console.log(header("output in alt arm"));
    console.log(code);
  });
});
