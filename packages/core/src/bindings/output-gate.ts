import type { BindingRegistry } from "./binding.js";
import type { GateAtom, ResolvedOutput } from "./resolved-output.js";

/**
 * The unified wrapper sequence for a single output: the scope's gate, then for
 * each ref token both the ref binding's path-gate and (if its type is itself
 * "thick" - nullable or iterable) a self-atom on the ref binding. Atoms are
 * deduped while preserving first-occurrence order.
 *
 * The self-atom encodes facts derivable from `Binding.type` alone:
 * - `optional`, `bool`, `count` -> `present(binding)` (value may be absent)
 * - `list` -> `iter(binding)` (iterate per element)
 *
 * `scopeGate` is the gate of the scope's struct binding (often `[]` at the
 * root). Backends nest wrappers in array order; the atom kind decides whether
 * it renders as a guard (`present` / `variant`) or a loop (`iter`).
 */
export function outputGate(
  scopeGate: GateAtom[],
  output: ResolvedOutput,
  bindings: BindingRegistry,
): GateAtom[] {
  const seen = new Set<string>();
  const result: GateAtom[] = [];
  const push = (atom: GateAtom): void => {
    const key = atomKey(atom);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(atom);
  };
  for (const atom of scopeGate) push(atom);
  for (const token of output.tokens) {
    if (token.kind !== "ref") continue;
    const refBinding = bindings.get(token.binding);
    if (!refBinding) continue;
    for (const atom of refBinding.gate) push(atom);
    const kind = refBinding.type.kind;
    if (kind === "optional" || kind === "bool" || kind === "count") {
      push({ kind: "present", binding: refBinding.id });
    } else if (kind === "list") {
      push({ kind: "iter", binding: refBinding.id });
    }
  }
  return result;
}

export function atomKey(atom: GateAtom): string {
  if (atom.kind === "variant") return `v:${atom.binding}:${atom.variant}`;
  return `${atom.kind[0]}:${atom.binding}`;
}
