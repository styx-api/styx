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
 * One wrapper layer on a binding's path from the root. Atoms are stored
 * root-to-leaf in `Binding.gate`; backends nest wrappers in array order.
 *
 * - `present`: the binding is inside the active branch of `binding` (a non-null
 *   `optional`, `true` for a `bool`, `> 0` for a `count`). Reads as a boolean
 *   guard at codegen.
 * - `variant`: the binding is inside the `variant` arm of the union bound by
 *   `binding`. Reads as a discriminator check.
 * - `iter`: the binding is inside a `repeat` whose value is a `list`. Reads as
 *   a per-element loop variable bound to `binding`.
 */
export type GateAtom =
  | { kind: "present"; binding: BindingId }
  | { kind: "variant"; binding: BindingId; variant: string }
  | { kind: "iter"; binding: BindingId };

/**
 * Output specification translated against the binding registry. Pure template
 * data: a name and a token sequence. Per-output gating is derived at codegen
 * time from the declaring scope's gate plus each ref binding's gate.
 */
export interface ResolvedOutput {
  name: string;
  doc?: Documentation;
  tokens: ResolvedToken[];
  mediaTypes?: MediaTypeIdentifier[];
}

/**
 * Outputs declared on one struct binding, grouped under that scope. The
 * solver guarantees a binding on every output-carrying sequence (forcing a
 * struct binding even when it would otherwise collapse), so the scope is
 * always a real BindingId. Per-output gating derives from the scope binding's
 * `gate` plus each ref binding's `gate`.
 */
export interface OutputScope {
  scope: BindingId;
  outputs: ResolvedOutput[];
}
