import ts from "typescript";
import type { AppMeta, Expr } from "../../ir/index.js";
import { alt, float, int, lit, opt, path, rep, repJoin, seq, seqJoin } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { createContext } from "../../manifest/context.js";
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

export function generate(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  const solveResult = solve(expr);
  const outputs = resolveOutputs(expr, solveResult);
  const ctx = createContext(expr, solveResult, outputs, {
    app: options?.app,
    package: options?.package,
  });
  return generateTypeScript(ctx);
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

export function execute(
  expr: Expr,
  params: Record<string, unknown>,
  options?: { app?: AppMeta; package?: { name?: string } },
): string[] {
  const tsCode = generate(expr, options);

  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  let capturedArgs: string[] = [];
  const mockExecution = {
    inputFile: (p: unknown) => String(p),
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

  const exportedFn = Object.values(mod.exports).find((v) => typeof v === "function") as
    | ((params: Record<string, unknown>) => void)
    | undefined;
  if (!exportedFn) throw new Error("No exported function found in generated code");

  exportedFn(params);
  return capturedArgs;
}
