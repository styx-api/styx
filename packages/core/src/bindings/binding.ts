import type { Expr } from "../ir/index.js";
import type { GateAtom } from "./resolved-output.js";
import type { BoundType } from "./types.js";

export type BindingId = string;

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
