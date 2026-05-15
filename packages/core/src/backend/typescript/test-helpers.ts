import ts from "typescript";
import type { AppMeta, Expr } from "../../ir/index.js";
import { alt, float, int, lit, opt, path, rep, repJoin, seq, seqJoin } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { createContext } from "../../manifest/context.js";
import type { GeneratedTypeScript } from "./typescript.js";
import { generateTypeScript } from "./typescript.js";

// Re-export IR builders for test convenience
export { alt, float, int, lit, opt, path, rep, repJoin, seq, seqJoin };

// -- Test-only helpers --

/** str() with optional doc shorthand: str("name", "description") */
export function str(name?: string, doc?: string): Expr {
  if (!name) return { kind: "str", attrs: {} };
  return { kind: "str", attrs: {}, meta: { name, doc: doc ? { description: doc } : undefined } };
}

export function namedAlt(name: string, ...alts: Expr[]): Expr {
  return { kind: "alternative", attrs: { alts }, meta: { name } };
}

// -- Generate helpers --

/**
 * For tests asserting against generated source: returns the concatenation of
 * `core.ts` and `index.ts` separated by a marker. Most substring assertions
 * just want "is this string anywhere in the output", and that's preserved
 * across both files this way.
 */
export function generate(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  const { core, index } = generateBoth(expr, options);
  return `${core}\n// ----- index.ts -----\n${index}`;
}

export function generateCore(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  return generateBoth(expr, options).core;
}

export function generateIndex(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  return generateBoth(expr, options).index;
}

export function generateBoth(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): GeneratedTypeScript {
  return generateTypeScript(generateCtx(expr, options));
}

export function generateCtx(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): CodegenContext {
  const solveResult = solve(expr);
  const outputs = resolveOutputs(expr, solveResult);
  return createContext(expr, solveResult, outputs, {
    app: options?.app,
    package: options?.package,
  });
}

// -- Execution helper: generate, transpile, run, verify args --

interface RunResult {
  args: string[];
  outputs: unknown;
}

function runGenerated(tsCode: string, params: Record<string, unknown>): RunResult {
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  let capturedArgs: string[] = [];
  const mockExecution = {
    inputFile: (p: unknown) => String(p),
    outputFile: (p: unknown) => String(p),
    params: () => {},
    run: (args: string[]) => {
      capturedArgs = args;
    },
  };
  const mockStyxdefs = {
    getGlobalRunner: () => ({
      startExecution: () => mockExecution,
    }),
  };

  const mod = { exports: {} as Record<string, unknown> };
  const fn = new Function("require", "module", "exports", jsCode);
  fn(
    (name: string) => {
      if (name === "styxdefs") return mockStyxdefs;
      throw new Error(`Unexpected require: ${name}`);
    },
    mod,
    mod.exports,
  );

  // The wrapper is the `run` function in the core module. Pick it explicitly
  // rather than guessing by position - all six swap items are exported and
  // ordering would be brittle.
  const exportedFn = mod.exports["run"] as
    | ((params: Record<string, unknown>) => unknown)
    | undefined;
  if (!exportedFn) throw new Error("No `run` function found in generated code");

  const outputs = exportedFn(params);
  return { args: capturedArgs, outputs };
}

export function execute(
  expr: Expr,
  params: Record<string, unknown>,
  options?: { app?: AppMeta; package?: { name?: string } },
): string[] {
  // Execution exercises just the core file - the index file is purely for
  // public re-exports and adds no behavior.
  return runGenerated(generateCore(expr, options), params).args;
}

export function executeWithOutputs(
  expr: Expr,
  params: Record<string, unknown>,
  options?: { app?: AppMeta; package?: { name?: string } },
): RunResult {
  return runGenerated(generateCore(expr, options), params);
}
