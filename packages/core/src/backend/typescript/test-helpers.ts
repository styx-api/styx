import ts from "typescript";
import type { AppMeta, Expr } from "../../ir/index.js";
import { alt, float, int, lit, opt, path, rep, repJoin, seq, seqJoin } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { createContext } from "../../manifest/context.js";
import { computePublicNames, generateTypeScript } from "./typescript.js";

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

/** Generate the single-file TypeScript source for an expression. */
export function generate(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
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

function runGenerated(
  tsCode: string,
  params: Record<string, unknown>,
  wrapperExport: string,
): RunResult {
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

  const exportedFn = mod.exports[wrapperExport] as
    | ((params: Record<string, unknown>) => unknown)
    | undefined;
  if (!exportedFn) {
    throw new Error(`No \`${wrapperExport}\` function found in generated code`);
  }

  const outputs = exportedFn(params);
  return { args: capturedArgs, outputs };
}

/**
 * Pick the dict-style export to invoke from the test harness: prefer the
 * internal `<tool>Execute` (it takes a params object), falling back to the
 * user-facing `wrapper` name when there's no struct root (the wrapper IS
 * dict-style in that case).
 */
function executeExport(ctx: CodegenContext): string {
  const publicNames = computePublicNames(ctx.app?.id);
  const rootBinding = ctx.resolve(ctx.expr);
  // Mirror the codegen: only a real struct root produces the internal
  // `<tool>Execute`; otherwise the user-facing wrapper IS the dict-style fn.
  const rootIsStruct = rootBinding?.type.kind === "struct";
  return rootIsStruct ? publicNames.execute : publicNames.wrapper;
}

export function execute(
  expr: Expr,
  params: Record<string, unknown>,
  options?: { app?: AppMeta; package?: { name?: string } },
): string[] {
  const ctx = generateCtx(expr, options);
  return runGenerated(generateTypeScript(ctx), params, executeExport(ctx)).args;
}

export function executeWithOutputs(
  expr: Expr,
  params: Record<string, unknown>,
  options?: { app?: AppMeta; package?: { name?: string } },
): RunResult {
  const ctx = generateCtx(expr, options);
  return runGenerated(generateTypeScript(ctx), params, executeExport(ctx));
}
