import type { Documentation, MediaTypeIdentifier } from "../ir/types.js";
import type { BindingId } from "./binding.js";

/**
 * Resolved token in an output path template. Refs point at solved bindings;
 * literals are emitted verbatim.
 */
export type ResolvedToken =
  | { kind: "literal"; value: string }
  | {
      kind: "ref";
      binding: BindingId;
      stripExtensions?: string[];
      fallback?: string;
    };

/**
 * One condition that must hold for an output to fire.
 *
 * - `present`: the bound parameter is "active" - non-null for an `optional`,
 *   `true` for a `bool`, `> 0` for a `count`. The backend reads the predicate
 *   off `bindings.get(binding).type.kind`.
 * - `variant`: the union bound by `binding` selected the variant named
 *   `variant` (the output is hosted inside that alternative arm).
 */
export type GateAtom =
  | { kind: "present"; binding: BindingId }
  | { kind: "variant"; binding: BindingId; variant: string };

/**
 * Output specification translated against the binding registry.
 *
 * - `branchCondition`: disjunction (outer) of conjunctions (inner) of
 *   `GateAtom`s. An output attached to a single host node has exactly one
 *   disjunct - the host's branch path; the disjunctive shape is kept so
 *   several hosts producing the same output can be merged later.
 * - `listScope`: repeat-ancestor (`list`) bindings of the host. The output
 *   emits once per iteration of the innermost listed binding.
 * - `optional`: true when the branch path is non-empty (the host is gated).
 */
export interface ResolvedOutput {
  name: string;
  doc?: Documentation;
  tokens: ResolvedToken[];
  branchCondition: GateAtom[][];
  listScope: BindingId[];
  optional: boolean;
  mediaTypes?: MediaTypeIdentifier[];
}
