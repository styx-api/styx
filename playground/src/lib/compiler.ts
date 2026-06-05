import { compile, solve, resolveOutputs, createContext } from "@styx-api/core";
import type { ParseResult, SolveResult, CodegenContext } from "@styx-api/core";
import { buildPipeline, type PassConfig } from "./passes.js";

export interface SolvedParseResult {
  parseResult: ParseResult;
  solveResult: SolveResult;
  ctx: CodegenContext;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * One run of the compiler over a single descriptor. `parse` is always present
 * when the run succeeds; `solved` is guarded independently so that a solver
 * failure surfaces as a tab-level error without blanking the IR view.
 */
export interface Compilation {
  parse: ParseResult;
  solved: Result<SolvedParseResult>;
}

export type CompileOutcome =
  | { status: "empty" }
  | { status: "error"; error: string; timeMs: number }
  | { status: "ok"; compilation: Compilation; timeMs: number };

/** Parse + optimize + solve a descriptor, never throwing. */
export function runCompile(input: string, passes: PassConfig): CompileOutcome {
  if (!input) return { status: "empty" };

  const start = performance.now();
  try {
    const parseResult = compile(input);

    const pipeline = buildPipeline(passes);
    if (pipeline) {
      const passResult = pipeline.apply(parseResult.expr);
      parseResult.expr = passResult.expr;
      if (passResult.warnings) {
        parseResult.warnings.push(...passResult.warnings.map((w) => ({ message: w })));
      }
    }

    const solved = runSolve(parseResult);
    return { status: "ok", compilation: { parse: parseResult, solved }, timeMs: elapsed(start) };
  } catch (e) {
    return { status: "error", error: errMsg(e), timeMs: elapsed(start) };
  }
}

function runSolve(parseResult: ParseResult): Result<SolvedParseResult> {
  try {
    const solveResult = solve(parseResult.expr);
    const outputs = resolveOutputs(parseResult.expr, solveResult);
    const ctx = createContext(parseResult.expr, solveResult, outputs, { app: parseResult.meta });
    return { ok: true, value: { parseResult, solveResult, ctx } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

function elapsed(start: number): number {
  return performance.now() - start;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
