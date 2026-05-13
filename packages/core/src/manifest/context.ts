import type { BindingRegistry, ResolvedOutput, SolveResult } from "../bindings/index.js";
import type { AppMeta, Expr } from "../ir/index.js";
import type { PackageMeta, ProjectMeta } from "./types.js";

export interface CodegenContext {
  expr: Expr;
  bindings: BindingRegistry;
  resolve: SolveResult["resolve"];
  outputs: ResolvedOutput[];
  app?: AppMeta;
  package?: PackageMeta;
  project?: ProjectMeta;
}

export function createContext(
  expr: Expr,
  solveResult: SolveResult,
  meta?: { app?: AppMeta; package?: PackageMeta; project?: ProjectMeta },
): CodegenContext {
  return {
    expr,
    bindings: solveResult.bindings,
    resolve: solveResult.resolve,
    outputs: solveResult.outputs,
    ...meta,
  };
}
