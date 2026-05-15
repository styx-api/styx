import type { AppMeta, Expr } from "../../ir/index.js";
import { alt, float, int, lit, opt, path, rep, repJoin, seq, seqJoin } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { createContext } from "../../manifest/context.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import type { GeneratedPython } from "./python.js";
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

/**
 * For tests that assert against generated source: returns the concatenation
 * of `_core.py` and `__init__.py` separated by a marker. Most substring
 * assertions just want "is this string anywhere in the output", and that's
 * preserved across both files this way.
 */
export function generate(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  const { core, init } = generateBoth(expr, options);
  return `${core}\n# ----- __init__.py -----\n${init}`;
}

export function generateCore(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  return generateBoth(expr, options).core;
}

export function generateInit(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): string {
  return generateBoth(expr, options).init;
}

export function generateBoth(
  expr: Expr,
  options?: { app?: AppMeta; package?: { name?: string } },
): GeneratedPython {
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
