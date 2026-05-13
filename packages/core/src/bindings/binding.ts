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
  outputDiagnostics: OutputValidationResult;
}

export function createRegistry(): BindingRegistry {
  return new Map();
}
