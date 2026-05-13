import type {
  Binding,
  BindingId,
  GateAtom,
  ResolvedOutput,
  ResolvedToken,
} from "../bindings/index.js";
import type { Expr, Output } from "../ir/index.js";
import { effectiveOutputName } from "../ir/index.js";

/**
 * An output paired with the IR node it is attached to. The host node is the
 * output's implicit trigger - the output emits when the host is active during
 * arg-walk.
 */
export interface OutputHost {
  host: Expr;
  output: Output;
}

export interface NodeIndex {
  /** node -> parent (root maps to null). */
  parent: Map<Expr, Expr | null>;
  /**
   * binding name -> the outermost (shallowest) binding carrying that name.
   * Skips the root binding, whose name may be the inner field's name due to
   * the solver's single-field-collapse fallback.
   */
  bindingByName: Map<string, Binding>;
}

/** Build a parent map and a name->binding index over the IR tree. */
export function indexTree(root: Expr, resolve: (n: Expr) => Binding | undefined): NodeIndex {
  const parent = new Map<Expr, Expr | null>();
  const byNameDepth = new Map<string, { binding: Binding; depth: number }>();

  function walk(node: Expr, p: Expr | null, depth: number): void {
    parent.set(node, p);

    const binding = resolve(node);
    if (binding && depth > 0) {
      const existing = byNameDepth.get(binding.name);
      if (!existing || depth < existing.depth) {
        byNameDepth.set(binding.name, { binding, depth });
      }
    }

    switch (node.kind) {
      case "sequence":
        for (const child of node.attrs.nodes) walk(child, node, depth + 1);
        break;
      case "optional":
      case "repeat":
        walk(node.attrs.node, node, depth + 1);
        break;
      case "alternative":
        for (const alt of node.attrs.alts) walk(alt, node, depth + 1);
        break;
    }
  }

  walk(root, null, 0);

  const bindingByName = new Map<string, Binding>();
  for (const [name, { binding }] of byNameDepth) bindingByName.set(name, binding);
  return { parent, bindingByName };
}

/** Collect every `(node, output)` pair in tree-walk order. */
export function collectOutputHosts(root: Expr): OutputHost[] {
  const hosts: OutputHost[] = [];

  function walk(node: Expr): void {
    if (node.meta?.outputs) {
      for (const output of node.meta.outputs) hosts.push({ host: node, output });
    }
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
  return hosts;
}

/**
 * Walk from an output's host node up to the root, collecting the conditions
 * that gate it: `optional`/`count` ancestors and selected-`alternative`-arm
 * ancestors become `GateAtom`s in `branchPath` (all must hold); `repeat`
 * ancestors that resolved to a `list` go into `listScope` (the output emits
 * once per iteration). The host node itself counts if it is one of those
 * wrappers.
 */
export function gateContext(
  host: Expr,
  parent: Map<Expr, Expr | null>,
  resolve: (n: Expr) => Binding | undefined,
): { branchPath: GateAtom[]; listScope: BindingId[] } {
  const branchPath: GateAtom[] = [];
  const listScope: BindingId[] = [];

  let node: Expr | null = host;
  let prev: Expr | null = null;
  while (node) {
    if (node.kind === "optional") {
      const b = resolve(node);
      if (b) branchPath.push({ kind: "present", binding: b.id });
    } else if (node.kind === "repeat") {
      const b = resolve(node);
      if (b) {
        // repeat(value) -> list (iterate); repeat(literal) -> count (gate on > 0)
        if (b.type.kind === "count") branchPath.push({ kind: "present", binding: b.id });
        else listScope.push(b.id);
      }
    } else if (node.kind === "alternative" && prev) {
      // Gate: "this union selected the arm containing the host." Variant order
      // matches arm order. Bool-pair alternatives resolve to `bool`, not
      // `union`, and carry no variant info - skip.
      const union = resolve(node);
      if (union?.type.kind === "union") {
        const i = node.attrs.alts.indexOf(prev);
        const variant = i >= 0 ? union.type.variants[i] : undefined;
        if (variant) {
          branchPath.push({ kind: "variant", binding: union.id, variant: variant.name ?? `variant_${i}` });
        }
      }
    }
    prev = node;
    node = parent.get(node) ?? null;
  }

  return { branchPath: branchPath.reverse(), listScope: listScope.reverse() };
}

/**
 * Resolve every output attached to nodes in the tree against the binding
 * registry. Best-effort: token refs with no resolvable binding are dropped
 * (the validator reports them); the output is still emitted with its remaining
 * tokens.
 */
export function resolveOutputs(
  root: Expr,
  resolve: (n: Expr) => Binding | undefined,
  index?: NodeIndex,
): ResolvedOutput[] {
  const hosts = collectOutputHosts(root);
  if (hosts.length === 0) return [];
  const idx = index ?? indexTree(root, resolve);
  return hosts.map(({ host, output }, i) => resolveOne(host, output, i, idx, resolve));
}

function resolveOne(
  host: Expr,
  output: Output,
  index: number,
  idx: NodeIndex,
  resolve: (n: Expr) => Binding | undefined,
): ResolvedOutput {
  const tokens: ResolvedToken[] = [];
  for (const token of output.tokens) {
    if (token.kind === "literal") {
      tokens.push({ kind: "literal", value: token.value });
      continue;
    }
    const binding = idx.bindingByName.get(token.target.name);
    if (!binding) continue; // dangling - validator catches
    tokens.push({
      kind: "ref",
      binding: binding.id,
      ...(token.stripExtensions && { stripExtensions: token.stripExtensions }),
      ...(token.fallback !== undefined && { fallback: token.fallback }),
    });
  }

  const { branchPath, listScope } = gateContext(host, idx.parent, resolve);
  const optional = (output.optional ?? false) || branchPath.length > 0;

  return {
    name: effectiveOutputName(output, index),
    ...(output.doc && { doc: output.doc }),
    tokens,
    branchCondition: [branchPath],
    listScope,
    optional,
    ...(output.mediaTypes && { mediaTypes: output.mediaTypes }),
  };
}
