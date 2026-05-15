import type {
  BindingRegistry,
  GateAtom,
  OutputScope,
  ResolvedOutput,
  ResolvedToken,
} from "../bindings/index.js";
import { outputGate } from "../bindings/index.js";

// Re-export the core helper so backends have a single entry point.
export { outputGate };

/**
 * Compact consecutive literal tokens. Backends that emit string concatenation
 * benefit from a shorter token stream; backends that template each token
 * individually can ignore this and use `output.tokens` directly.
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
 * One output ready for codegen. `gate` is the wrapper sequence (outermost
 * first); the backend renders each atom as the appropriate scope-introducing
 * statement, then emits the path expression inside the innermost layer.
 */
export interface OutputEmitPlan {
  name: string;
  gate: GateAtom[];
  tokens: ResolvedToken[];
  resolved: ResolvedOutput;
}

export function planOutput(
  scopeGate: GateAtom[],
  output: ResolvedOutput,
  bindings: BindingRegistry,
): OutputEmitPlan {
  return {
    name: output.name,
    gate: outputGate(scopeGate, output, bindings),
    tokens: compactTokens(output.tokens),
    resolved: output,
  };
}

/**
 * Does the output have any conditional wrapper? Equivalent to "is at least one
 * atom a `present` or `variant`?". `iter` alone means the output emits a list
 * and is not conditionally absent.
 */
export function isGated(plan: OutputEmitPlan): boolean {
  return plan.gate.some((a) => a.kind === "present" || a.kind === "variant");
}

/** Does the output iterate (emit zero-or-more values)? */
export function isIterated(plan: OutputEmitPlan): boolean {
  return plan.gate.some((a) => a.kind === "iter");
}

/**
 * Convenience for backends emitting all outputs of a scope at once. The caller
 * provides the scope's gate (typically `bindings.get(scope.scope)?.gate ?? []`).
 */
export function planScope(
  scope: OutputScope,
  scopeGate: GateAtom[],
  bindings: BindingRegistry,
): OutputEmitPlan[] {
  return scope.outputs.map((output) => planOutput(scopeGate, output, bindings));
}
