import type {
  BindingRegistry,
  OutputScope,
  OutputValidationResult,
  SolveResult,
} from "../bindings/index.js";
import type { AppMeta, Expr } from "../ir/index.js";
import type { OutputResolution } from "../solver/index.js";
import type { PackageMeta, ProjectMeta } from "./types.js";

export interface CodegenContext {
  expr: Expr;
  bindings: BindingRegistry;
  resolve: SolveResult["resolve"];
  outputScopes: OutputScope[];
  outputDiagnostics: OutputValidationResult;
  app?: AppMeta;
  package?: PackageMeta;
  project?: ProjectMeta;
}

export function createContext(
  expr: Expr,
  solveResult: SolveResult,
  outputs: OutputResolution,
  meta?: { app?: AppMeta; package?: PackageMeta; project?: ProjectMeta },
): CodegenContext {
  return {
    expr,
    bindings: solveResult.bindings,
    resolve: solveResult.resolve,
    outputScopes: outputs.scopes,
    outputDiagnostics: outputs.diagnostics,
    ...meta,
  };
}
