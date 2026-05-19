import type { AppMeta, Expr } from "../../ir/index.js";
import { alt, float, int, lit, opt, path, rep, repJoin, seq, seqJoin } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { createContext } from "../../manifest/context.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { generatePython } from "./python.js";

// Re-export IR builders for test convenience.
export { alt, float, int, lit, opt, path, rep, repJoin, seq, seqJoin };

/** str() with optional doc shorthand: str("name", "description") */
export function str(name?: string, doc?: string): Expr {
  if (!name) return { kind: "str", attrs: {} };
  return { kind: "str", attrs: {}, meta: { name, doc: doc ? { description: doc } : undefined } };
}

export function namedAlt(name: string, ...alts: Expr[]): Expr {
  return { kind: "alternative", attrs: { alts }, meta: { name } };
}

/** Generate the single-file Python source for an expression. */
export function generate(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  return generatePython(generateCtx(expr, options));
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
