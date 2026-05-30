import type {
  Binding,
  BindingId,
  BoundType,
  OutputDiagnostic,
  OutputScope,
  OutputValidationResult,
  ResolvedOutput,
  ResolvedToken,
  SolveResult,
} from "../bindings/index.js";
import type { Expr, Output } from "../ir/index.js";
import { effectiveOutputName } from "../ir/index.js";

export interface OutputResolution {
  scopes: OutputScope[];
  diagnostics: OutputValidationResult;
}

/**
 * Per-binding map keyed by `Binding.name`. Frontends attach outputs to the
 * declaring struct, so refs name fields visible in that scope (the resolver
 * accepts a single global name index because optimization can move bindings
 * around but never duplicates names within a scope).
 */
interface NameIndex {
  byName: Map<string, Binding>;
}

/**
 * Whether a binding resolves to a value that can be interpolated into an output
 * path token. Scalars/bool/count/literals (and optional/list wrappers of them)
 * carry a concrete value; structs and complex unions do not.
 *
 * This drives the name-tie preference below: an unnamed multi-field struct
 * inherits its first field's name (`findDeepName`), so a struct and its scalar
 * field can share a name. An output ref always means the value, so the
 * interpolable binding must win regardless of which sits shallower.
 */
function isInterpolable(type: BoundType): boolean {
  switch (type.kind) {
    case "optional":
      return isInterpolable(type.inner);
    case "list":
      return isInterpolable(type.item);
    case "struct":
      return false;
    case "union":
      // Pure-enum unions are interpolable (the value is a literal); a union with
      // any struct variant is not.
      return type.variants.every((v) => isInterpolable(v.type));
    default:
      return true;
  }
}

function indexBindingsByName(root: Expr, resolve: (n: Expr) => Binding | undefined): NameIndex {
  const byNameDepth = new Map<string, { binding: Binding; depth: number }>();
  function walk(node: Expr, depth: number): void {
    const binding = resolve(node);
    if (binding && depth > 0) {
      const existing = byNameDepth.get(binding.name);
      if (!existing || preferCandidate({ binding, depth }, existing)) {
        byNameDepth.set(binding.name, { binding, depth });
      }
    }
    switch (node.kind) {
      case "sequence":
        for (const child of node.attrs.nodes) walk(child, depth + 1);
        break;
      case "optional":
      case "repeat":
        walk(node.attrs.node, depth + 1);
        break;
      case "alternative":
        for (const alt of node.attrs.alts) walk(alt, depth + 1);
        break;
    }
  }
  walk(root, 0);
  const byName = new Map<string, Binding>();
  for (const [name, { binding }] of byNameDepth) byName.set(name, binding);
  return { byName };
}

/**
 * Decide whether `cand` should replace `existing` for a shared name. An
 * interpolable binding always beats a structured one (the struct/scalar name
 * collision); otherwise the shallowest binding wins, as before.
 */
function preferCandidate(
  cand: { binding: Binding; depth: number },
  existing: { binding: Binding; depth: number },
): boolean {
  const candLeaf = isInterpolable(cand.binding.type);
  const exLeaf = isInterpolable(existing.binding.type);
  if (candLeaf !== exLeaf) return candLeaf;
  return cand.depth < existing.depth;
}

/**
 * Walk the IR collecting `(node, outputs)` pairs in tree order. Outputs attach
 * to struct/sequence nodes by frontend convention.
 */
function collectScopes(root: Expr): { node: Expr; outputs: Output[] }[] {
  const out: { node: Expr; outputs: Output[] }[] = [];
  function walk(node: Expr): void {
    if (node.meta?.outputs?.length) out.push({ node, outputs: node.meta.outputs });
    switch (node.kind) {
      case "sequence":
        for (const child of node.attrs.nodes) walk(child);
        break;
      case "optional":
      case "repeat":
        walk(node.attrs.node);
        break;
      case "alternative":
        for (const alt of node.attrs.alts) walk(alt);
        break;
    }
  }
  walk(root);
  return out;
}

function resolveOne(
  output: Output,
  index: number,
  names: NameIndex,
): { resolved: ResolvedOutput; errors: OutputDiagnostic[] } {
  const errors: OutputDiagnostic[] = [];
  const name = effectiveOutputName(output, index);
  const tokens: ResolvedToken[] = [];
  for (const token of output.tokens) {
    if (token.kind === "literal") {
      tokens.push({ kind: "literal", value: token.value });
      continue;
    }
    const binding = names.byName.get(token.target.name);
    if (!binding) {
      errors.push({
        output: name,
        level: "error",
        message: `token ref '${token.target.name}' has no binding with that name (frontend produced an inconsistent output spec)`,
      });
      continue;
    }
    tokens.push({
      kind: "ref",
      binding: binding.id,
      ...(token.stripExtensions && { stripExtensions: token.stripExtensions }),
      ...(token.fallback !== undefined && { fallback: token.fallback }),
    });
  }
  const resolved: ResolvedOutput = {
    name,
    ...(output.doc && { doc: output.doc }),
    tokens,
    ...(output.mediaTypes && { mediaTypes: output.mediaTypes }),
  };
  return { resolved, errors };
}

/**
 * Translate each `NodeMeta.outputs` entry against the binding registry,
 * grouped by the declaring struct binding (the "scope"). The solver forces a
 * binding on every output-carrying sequence, so an output without a scope
 * binding indicates a frontend bug (outputs attached to a non-sequence
 * node) - it is reported as a diagnostic and dropped.
 */
export function resolveOutputs(root: Expr, solved: SolveResult): OutputResolution {
  const names = indexBindingsByName(root, solved.resolve);
  const collected = collectScopes(root);

  const byScope = new Map<BindingId, OutputScope>();
  const errors: OutputDiagnostic[] = [];
  const warnings: OutputDiagnostic[] = [];

  let outputIndex = 0;
  for (const { node, outputs } of collected) {
    const scopeBinding = solved.resolve(node);
    if (!scopeBinding) {
      for (const output of outputs) {
        const name = effectiveOutputName(output, outputIndex++);
        errors.push({
          output: name,
          level: "error",
          message: `output '${name}' is attached to a node without a binding (frontends should attach outputs to struct sequences)`,
        });
      }
      continue;
    }
    let bucket = byScope.get(scopeBinding.id);
    if (!bucket) {
      bucket = { scope: scopeBinding.id, outputs: [] };
      byScope.set(scopeBinding.id, bucket);
    }
    for (const output of outputs) {
      const { resolved, errors: outErrors } = resolveOne(output, outputIndex++, names);
      errors.push(...outErrors);
      bucket.outputs.push(resolved);
    }
  }

  return {
    scopes: Array.from(byScope.values()),
    diagnostics: { errors, warnings },
  };
}
