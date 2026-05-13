import type { BindingId, GateAtom, ResolvedOutput, ResolvedToken } from "../bindings/index.js";

/**
 * Cardinality of a resolved output: how many path values it produces and
 * whether the user must handle a null/missing case.
 *
 * - `always`: exactly one path, never null. Type as `path`.
 * - `optional`: zero or one path. Type as `path | null`.
 * - `list`: zero or more paths (per listScope iteration). Type as `path[]`.
 * - `list-optional`: zero or more paths but the whole output may be skipped.
 *   Type as `path[] | null`.
 */
export type OutputCardinality = "always" | "optional" | "list" | "list-optional";

/** Compute cardinality from `listScope` and `optional` on a ResolvedOutput. */
export function outputCardinality(resolved: ResolvedOutput): OutputCardinality {
  const isList = resolved.listScope.length > 0;
  if (isList && resolved.optional) return "list-optional";
  if (isList) return "list";
  if (resolved.optional) return "optional";
  return "always";
}

/**
 * Guard expression controlling whether the output emits.
 *
 * `always` means the output emits unconditionally (no gating ancestors).
 * `any-of` is a disjunction of conjunctions: emit if any clause's atoms all
 * hold. Each `GateAtom` is either `present` (the bound parameter is non-null /
 * `true` / `> 0`, per its binding's type) or `variant` (a union selected a
 * particular arm).
 */
export type OutputGuard =
  | { kind: "always" }
  | { kind: "any-of"; clauses: GuardClause[] };

export interface GuardClause {
  /** All of these conditions must hold for this clause to fire. */
  atoms: GateAtom[];
}

/**
 * Reduce `branchCondition` to a guard expression. An empty branchCondition or
 * a single empty path collapses to `always`; otherwise we keep the disjunction
 * of conjunctions.
 */
export function outputGuard(resolved: ResolvedOutput): OutputGuard {
  const bc = resolved.branchCondition;
  if (bc.length === 0) return { kind: "always" };
  if (bc.length === 1 && bc[0]!.length === 0) return { kind: "always" };
  return {
    kind: "any-of",
    clauses: bc.map((atoms) => ({ atoms })),
  };
}

/**
 * Merge consecutive literal tokens. Backends that emit string concatenation
 * benefit from a shorter token stream; backends that template each token
 * individually can ignore this and use `resolved.tokens` directly.
 */
export function compactTokens(tokens: ResolvedToken[]): ResolvedToken[] {
  const out: ResolvedToken[] = [];
  for (const tok of tokens) {
    const last = out[out.length - 1];
    if (tok.kind === "literal" && last && last.kind === "literal") {
      out[out.length - 1] = { kind: "literal", value: last.value + tok.value };
    } else {
      out.push(tok);
    }
  }
  return out;
}

/**
 * Single point of entry: convert a ResolvedOutput to a plan whose fields map
 * directly to the codegen patterns described in `memory/design_outputs.md`.
 *
 * Backends typically need:
 * - `cardinality` to decide the field type (`path | null` vs `path[]`, etc.).
 * - `guard` to render the if-condition gating the output assignment.
 * - `listScope` to render the for-loop when iterating per repeat-binding.
 * - `tokens` to render the path expression. Refs with a `fallback` should be
 *   emitted as `ref ?? fallback` (or the language equivalent) so unreachable
 *   refs naturally resolve to their fallback at runtime.
 */
export interface OutputEmitPlan {
  name: string;
  cardinality: OutputCardinality;
  guard: OutputGuard;
  listScope: BindingId[];
  tokens: ResolvedToken[];
  resolved: ResolvedOutput;
}

export function planOutput(resolved: ResolvedOutput): OutputEmitPlan {
  return {
    name: resolved.name,
    cardinality: outputCardinality(resolved),
    guard: outputGuard(resolved),
    listScope: resolved.listScope,
    tokens: compactTokens(resolved.tokens),
    resolved,
  };
}
