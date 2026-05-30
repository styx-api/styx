import type { Expr } from "../ir/index.js";
import type { GateAtom } from "./resolved-output.js";
import type { BoundType } from "./types.js";

export type BindingId = string;

/**
 * One step in a binding's access path relative to top-level `params`.
 *
 * - `field`: descend into a named field of the enclosing struct scope. Renders
 *   as `params.name` (TS) / `params["name"]` (Python).
 * - `iter`: the access base resets to the per-element loop variable bound to
 *   `binding` (a `repeat`-of-list). The renderer substitutes the active loop
 *   variable at emit time (from the `iter` gate atom's loop, or the
 *   arg-builder's local loop), so segments after an `iter` build off the
 *   element rather than off `params`.
 *
 * There is deliberately no `variant` or `directValue` segment: complex-union
 * variant fields are plain `field` segments off the union's own path (the
 * `@type` discriminant lives in `GateAtom`, not the access path), and the
 * solver's wrapper collapses (`optional<scalar>`, scalar lists) are expressed
 * by a binding simply inheriting its parent wrapper's path.
 */
export type AccessSegment = { kind: "field"; name: string } | { kind: "iter"; binding: BindingId };

/**
 * A binding's location relative to top-level `params`, as a structured segment
 * sequence. Computed once by the solver (`assignAccessPaths`) and rendered by
 * each backend's `renderAccess`, so the arg-builder and outputs emitter share
 * one source of truth instead of each re-deriving paths.
 */
export type AccessPath = AccessSegment[];

export interface Binding {
  id: BindingId;
  node: Expr;
  name: string;
  type: BoundType;
  /**
   * Wrapper layers on the path from the root to this binding, root-to-leaf.
   * Captures the optional/repeat/alternative ancestors as `present`/`iter`/
   * `variant` atoms. Backends nest wrappers in array order; "is this binding
   * conditionally active?" reduces to `gate.length > 0`.
   */
  gate: GateAtom[];
  /**
   * Access path relative to top-level `params`, assigned by the solver's
   * `assignAccessPaths` pass after types settle. Backends render it via
   * `renderAccess` rather than re-walking the IR to recompute where this
   * binding lives.
   */
  access: AccessPath;
}

export type BindingRegistry = Map<BindingId, Binding>;

export type OutputDiagnosticLevel = "error" | "warning";

export interface OutputDiagnostic {
  output: string;
  message: string;
  level: OutputDiagnosticLevel;
}

export interface OutputValidationResult {
  errors: OutputDiagnostic[];
  warnings: OutputDiagnostic[];
}

export interface SolveResult {
  bindings: BindingRegistry;
  resolve: (node: Expr) => Binding | undefined;
}

export function createRegistry(): BindingRegistry {
  return new Map();
}
