import type { Binding, OutputDiagnostic, OutputValidationResult } from "../bindings/index.js";
import type { Expr } from "../ir/index.js";
import { effectiveOutputName } from "../ir/index.js";
import { collectOutputHosts, indexTree, type NodeIndex } from "./resolve-outputs.js";

/**
 * Post-solve validation for outputs attached to IR nodes.
 *
 * Current checks:
 * 1. Every token-ref name resolves to a known binding.
 *
 * Future checks (not yet implemented): ref bindings should sit within the
 * host's subtree (out-of-scope refs are ill-formed); a host inside a literal
 * arm of an alternative loses its discriminator (the arm has no binding).
 */
export function validateOutputs(
  root: Expr,
  resolve: (n: Expr) => Binding | undefined,
  index?: NodeIndex,
): OutputValidationResult {
  const errors: OutputDiagnostic[] = [];
  const warnings: OutputDiagnostic[] = [];

  const hosts = collectOutputHosts(root);
  if (hosts.length === 0) return { errors, warnings };
  const idx = index ?? indexTree(root, resolve);

  hosts.forEach(({ output }, i) => {
    const name = effectiveOutputName(output, i);
    for (const token of output.tokens) {
      if (token.kind !== "ref") continue;
      if (!idx.bindingByName.has(token.target.name)) {
        errors.push({
          output: name,
          level: "error",
          message: `token ref '${token.target.name}' has no binding with that name (frontend produced an inconsistent output spec)`,
        });
      }
    }
  });

  return { errors, warnings };
}
