import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultPipeline } from "../../ir/index.js";
import { createContext } from "../../manifest/context.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { generatePython } from "../../backend/python/python.js";
import { generateTypeScript } from "../../backend/typescript/typescript.js";
import { generateSchema } from "../../backend/schema/jsonschema.js";
import { ArgtypeParser } from "./parser-frontend.js";

const parser = new ArgtypeParser();

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

function run(source: string) {
  const parseResult = parser.parse(source);
  expect(parseResult.errors).toEqual([]);
  const optimized = defaultPipeline.apply(parseResult.expr);
  const solveResult = solve(optimized.expr);
  const outputs = resolveOutputs(optimized.expr, solveResult);
  expect(outputs.diagnostics.errors).toEqual([]);
  const ctx = createContext(optimized.expr, solveResult, outputs, {
    app: parseResult.meta ?? { id: "tool" },
    package: { name: "pkg" },
  });
  return { parseResult, ctx, outputs };
}

describe("argtype end-to-end: bet", () => {
  it("compiles bet.argtype through to TypeScript and Python", () => {
    const { parseResult, ctx, outputs } = run(fixture("bet.argtype"));

    // Frontmatter -> AppMeta.
    expect(parseResult.meta?.id).toBe("bet");
    expect(parseResult.meta?.version).toBe("6.0.4");

    const ts = generateTypeScript(ctx);
    const py = generatePython(ctx);
    const schema = generateSchema(ctx) as Record<string, unknown>;

    // Core parameters survive into the typed interface.
    for (const field of ["infile", "maskfile", "fractional_intensity", "center_of_gravity"]) {
      expect(ts).toContain(field);
      expect(py).toContain(field);
    }

    // The output-file declarations are collected and resolved.
    const allOutputs = outputs.scopes.flatMap((s) => s.outputs);
    const outNames = allOutputs.map((o) => o.name);
    expect(outNames).toContain("outfile");
    expect(outNames).toContain("binary_mask");

    // The `{maskfile}_mask.nii.gz` template resolves to a ref to the maskfile
    // binding plus the literal suffix - not just present-by-name.
    const binaryMask = allOutputs.find((o) => o.name === "binary_mask")!;
    expect(binaryMask.tokens).toHaveLength(2);
    expect(binaryMask.tokens[0]?.kind).toBe("ref");
    expect(binaryMask.tokens[1]).toEqual({ kind: "literal", value: "_mask.nii.gz" });
    if (binaryMask.tokens[0]?.kind === "ref") {
      expect(ctx.bindings.get(binaryMask.tokens[0].binding)?.name).toBe("maskfile");
    }

    // Sanity: generated code is non-trivial and references the executable.
    expect(ts.length).toBeGreaterThan(200);
    expect(ts).toContain("bet");
    expect(schema).toBeTruthy();
  });

  it("models the 3-coordinate center as a fixed-count list", () => {
    const { ctx } = run(`tool: set(
      opt("--center", center: rep(float).count(3)),
      input: path,
    )`);
    const ts = generateTypeScript(ctx);
    expect(ts).toContain("center");
  });
});
