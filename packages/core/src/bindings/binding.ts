import type { Expr } from "../ir/index.js";
import type { ResolvedOutput } from "./resolved-output.js";
import type { BoundType } from "./types.js";

export type BindingId = string;

export interface Binding {
  id: BindingId;
  node: Expr;
  name: string;
  type: BoundType;
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
  outputs: ResolvedOutput[];
  /**
   * Each resolved output paired with the IR node it is attached to (its
   * implicit trigger). Backends use this to attribute outputs to the right
   * descriptor scope (root vs. an `alternative` arm) without re-walking the
   * tree.
   */
  outputHosts: Map<ResolvedOutput, Expr>;
  outputDiagnostics: OutputValidationResult;
}

export function createRegistry(): BindingRegistry {
  return new Map();
}
