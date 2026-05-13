import type { Expr } from "../node.js";

export enum PassStatus {
  Unchanged = "unchanged",
  Changed = "changed",
  ChangedNeedsRerun = "changed-needs-rerun",
}

export interface PassResult {
  expr: Expr;
  status: PassStatus;
  warnings?: string[];
}

export interface Pass {
  readonly name: string;
  apply(expr: Expr): PassResult;
}

export function compose(...passes: Pass[]): Pass {
  return {
    name: passes.map((p) => p.name).join(" → "),
    apply(expr: Expr): PassResult {
      let current = expr;
      let overallStatus = PassStatus.Unchanged;
      const warnings: string[] = [];

      for (const pass of passes) {
        const result = pass.apply(current);
        current = result.expr;

        if (result.status !== PassStatus.Unchanged) {
          overallStatus = result.status;
        }
        if (result.warnings) {
          warnings.push(...result.warnings);
        }
      }

      return {
        expr: current,
        status: overallStatus,
        ...(warnings.length > 0 && { warnings }),
      };
    },
  };
}

export function fixpoint(pass: Pass, maxIterations = 10): Pass {
  return {
    name: `fixpoint(${pass.name})`,
    apply(expr: Expr): PassResult {
      let current = expr;
      const allWarnings: string[] = [];

      for (let i = 0; i < maxIterations; ++i) {
        const result = pass.apply(current);

        if (result.warnings) {
          allWarnings.push(...result.warnings);
        }

        // Stop if unchanged or no rerun needed
        if (result.status !== PassStatus.ChangedNeedsRerun) {
          return {
            expr: result.expr,
            status:
              result.status === PassStatus.Unchanged ? PassStatus.Unchanged : PassStatus.Changed,
            ...(allWarnings.length > 0 && { warnings: allWarnings }),
          };
        }

        current = result.expr;
      }

      return {
        expr: current,
        status: PassStatus.Changed,
        warnings: [
          ...allWarnings,
          `${pass.name} did not converge after ${maxIterations} iterations`,
        ],
      };
    },
  };
}
