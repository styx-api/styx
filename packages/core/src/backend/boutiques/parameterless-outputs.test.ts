import { describe, expect, it } from "vitest";
import { defaultPipeline } from "../../ir/index.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { BoutiquesParser } from "../../frontend/boutiques/parser.js";
import { createContext } from "../../manifest/context.js";
import { generatePython } from "../python/python.js";
import { generateTypeScript } from "../typescript/typescript.js";
import { generateOutputsSchema } from "../schema/jsonschema.js";
import { generateBoutiques } from "./boutiques.js";

/**
 * A parameterless output scope: a command (root or subcommand) that declares an
 * output-file but has no inputs, e.g. a mode that always writes a fixed file.
 * Its IR is `seq(lit("run"))` - a single literal - which `simplify` used to
 * collapse onto the bare literal, moving the output onto a node the solver never
 * binds (only sequences are force-bound as output scopes), silently dropping it.
 */

const parser = new BoutiquesParser();

function pipeline(descriptor: Record<string, unknown>) {
  const { expr, meta } = parser.parse(JSON.stringify(descriptor));
  const optimized = defaultPipeline.apply(expr).expr;
  const solveResult = solve(optimized);
  const outputs = resolveOutputs(optimized, solveResult);
  const ctx = createContext(optimized, solveResult, outputs, { app: meta });
  return {
    outputNames: outputs.scopes.flatMap((s) => s.outputs.map((o) => o.name)),
    diagnostics: outputs.diagnostics,
    python: generatePython(ctx),
    typescript: generateTypeScript(ctx),
    schemaProps: Object.keys(generateOutputsSchema(ctx).properties ?? {}),
    boutiques: generateBoutiques(ctx).descriptor as Record<string, unknown>,
  };
}

describe("parameterless output scopes", () => {
  it("retains a root output declared by a command with no inputs", () => {
    const r = pipeline({
      name: "t",
      "command-line": "t",
      inputs: [],
      "output-files": [{ id: "res", name: "Res", "path-template": "out.txt" }],
    });
    // No orphaned-output diagnostic, and the output surfaces in every backend.
    expect(r.diagnostics.errors).toEqual([]);
    expect(r.outputNames).toContain("res");
    expect(r.python).toContain("res: OutputPathType");
    expect(r.typescript).toContain("res: OutputPathType");
    expect(r.schemaProps).toContain("res");
    const btOut = (r.boutiques["output-files"] as { id: string }[] | undefined)?.map((o) => o.id);
    expect(btOut).toContain("res");
  });

  it("retains a parameterless subcommand's output in the typed backends", () => {
    const r = pipeline({
      name: "t",
      "command-line": "t [S]",
      inputs: [
        {
          id: "s",
          "value-key": "[S]",
          type: {
            id: "sub",
            "command-line": "run",
            inputs: [],
            "output-files": [{ id: "sub_res", name: "R", "path-template": "sub.txt" }],
          },
        },
      ],
    });
    expect(r.diagnostics.errors).toEqual([]);
    expect(r.outputNames).toContain("sub_res");
    expect(r.python).toContain("sub_res: OutputPathType");
    expect(r.typescript).toContain("sub_res: OutputPathType");
    expect(r.schemaProps).toContain("sub_res");
    // Note: the Boutiques round-trip backend does not yet re-emit a
    // parameterless *subcommand's* output-files (a deeper collapse interaction);
    // the shipping codegen backends above all retain it.
  });
});
