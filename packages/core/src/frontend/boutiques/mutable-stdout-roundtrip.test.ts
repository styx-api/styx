import { describe, expect, it } from "vitest";
import { generatePython } from "../../backend/python/python.js";
import { generateTypeScript } from "../../backend/typescript/typescript.js";
import { defaultPipeline } from "../../ir/index.js";
import { createContext } from "../../manifest/context.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { BoutiquesParser } from "./parser.js";

/**
 * End-to-end round-trip from a Boutiques descriptor (with a mutable input and a
 * stdout-output) all the way to emitted cargs + Outputs. The existing mutable /
 * stream tests construct IR directly; this one locks the *parser* -> solver ->
 * codegen path so a regression in how `mutable` / `stdout-output` are read from
 * a descriptor would surface here.
 */
const parser = new BoutiquesParser();

function emit(descriptor: Record<string, unknown>) {
  const parsed = parser.parse(JSON.stringify(descriptor));
  expect(parsed.errors).toEqual([]);
  const piped = defaultPipeline.apply(parsed.expr);
  const solveResult = solve(piped.expr);
  const outputs = resolveOutputs(piped.expr, solveResult);
  const ctx = createContext(piped.expr, solveResult, outputs, { app: parsed.meta });
  return { python: generatePython(ctx), typescript: generateTypeScript(ctx), meta: parsed.meta };
}

const descriptor = {
  name: "mytool",
  "command-line": "mytool [INFILE]",
  inputs: [
    {
      id: "infile",
      name: "Input file",
      type: "File",
      "value-key": "[INFILE]",
      mutable: true,
    },
  ],
  "stdout-output": { id: "stdout", name: "Captured standard output" },
};

describe("Boutiques round-trip: mutable input + stdout-output", () => {
  it("parses the stdout-output and mutable flag off the descriptor", () => {
    const { meta } = emit(descriptor);
    expect(meta?.stdout).toMatchObject({ name: "stdout" });
  });

  describe("Python", () => {
    it("emits input_file(mutable=True) on the command line", () => {
      const { python } = emit(descriptor);
      expect(python).toContain('execution.input_file(params["infile"], mutable=True)');
    });

    it("surfaces the mutated input as an OutputPathType field via mutable_copy", () => {
      const { python } = emit(descriptor);
      expect(python).toContain("infile: OutputPathType");
      expect(python).toContain('execution.mutable_copy(params["infile"])');
    });

    it("declares a stdout list field and wires handle_stdout into run", () => {
      const { python } = emit(descriptor);
      expect(python).toContain("stdout: list[str]");
      expect(python).toContain("handle_stdout=lambda s: out.stdout.append(s)");
    });
  });

  describe("TypeScript", () => {
    it("emits inputFile(host, false, true) on the command line", () => {
      const { typescript } = emit(descriptor);
      expect(typescript).toContain("execution.inputFile(params.infile, false, true)");
    });

    it("surfaces the mutated input as an OutputPathType field via mutableCopy", () => {
      const { typescript } = emit(descriptor);
      expect(typescript).toContain("infile: OutputPathType");
      expect(typescript).toContain("execution.mutableCopy(params.infile)");
    });

    it("declares a stdout string[] field and wires a stdout handler into run", () => {
      const { typescript } = emit(descriptor);
      expect(typescript).toContain("stdout: string[];");
      expect(typescript).toContain("out.stdout.push(s);");
    });
  });
});
