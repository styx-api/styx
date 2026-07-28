import type { NodeMeta, Output } from "../meta.js";
import type { Expr } from "../node.js";
import { PassStatus, type Pass, type PassResult } from "./pass.js";

/**
 * Whether a child sequence's `NodeMeta` allows it to be inlined into its
 * parent. `outputs` are the one relocatable field: they identify an output
 * *scope*, and once the child's members become the parent's members the parent
 * is that scope, so the merge hoists them (see `visit`). Every other field is
 * bound to the node itself and has nowhere to land in the parent, so its
 * presence keeps the child a distinct node:
 * - `name`: the struct's identity (the solver binds a named struct field).
 * - `variantTag`: the union discriminator of a sub-command arm.
 * - `doc`: group documentation describing this child, not the parent.
 * - `defaultValue`: a value for this node, not for the parent.
 *
 * This is what lets an anonymous `set(...)` whose only meta is the outputs its
 * members declared (argtype bubbles a member `.output()` up to the enclosing
 * seq/set scope) merge into its parent instead of surviving as a struct.
 */
function isInlinable(meta: NodeMeta | undefined): boolean {
  if (!meta) return true;
  return (
    meta.name === undefined &&
    meta.variantTag === undefined &&
    meta.doc === undefined &&
    meta.defaultValue === undefined
  );
}

/** Add every `meta.name` bound anywhere in a subtree to `acc`. */
function collectNames(node: Expr, acc: (name: string) => void): void {
  if (node.meta?.name !== undefined) acc(node.meta.name);
  switch (node.kind) {
    case "sequence":
      for (const child of node.attrs.nodes) collectNames(child, acc);
      return;
    case "alternative":
      for (const child of node.attrs.alts) collectNames(child, acc);
      return;
    case "optional":
    case "repeat":
      collectNames(node.attrs.node, acc);
      return;
    default:
      return;
  }
}

/** The names bound more than once anywhere in `root` - i.e. the ambiguous ones. */
function duplicatedNames(root: Expr): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  collectNames(root, (name) => {
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  });
  return duplicated;
}

/** The names bound in a subtree. */
function namesIn(node: Expr): Set<string> {
  const names = new Set<string>();
  collectNames(node, (name) => names.add(name));
  return names;
}

/**
 * Flatten passes
 * - seq(a, seq(b, c)) -> seq(a, b, c)
 * - alt(a, alt(b, c)) -> alt(a, b, c)
 */
export const flatten: Pass = {
  name: "flatten",
  apply(expr: Expr): PassResult {
    let changed = false;
    const ambiguous = duplicatedNames(expr);

    function visit(node: Expr): Expr {
      switch (node.kind) {
        case "sequence": {
          const children = node.attrs.nodes.map(visit);
          const names = children.map(namesIn);
          const nodes: Expr[] = [];
          const hoisted: Output[] = [];

          /**
           * Inlining merges the child's namespace into the parent's, and moves
           * its outputs to a scope one level wider. Both are resolved by NAME
           * downstream - the solver keys struct fields by binding name, and
           * `resolveOutputs` prefers a binding inside the output's own scope
           * subtree - so the merge is only sound when it leaves every name
           * unambiguous. `dedupeSiblingNames` runs in the frontend, per scope,
           * long before this pass, so it never sees the namespace this merge
           * would create; without this check a collision silently drops one of
           * the two fields and re-points its argv slot at the survivor.
           */
          const isSafeToMerge = (child: Expr, index: number): boolean => {
            const outputs = child.meta?.outputs ?? [];
            // Nothing to gain from inlining a memberless child, and doing so
            // would strand its outputs on a sequence that `remove-empty` can
            // then drop out from under an `optional`/`repeat` wrapper.
            if (outputs.length > 0 && child.kind === "sequence" && child.attrs.nodes.length === 0) {
              return false;
            }
            const outside = new Set<string>();
            names.forEach((n, i) => {
              if (i !== index) for (const name of n) outside.add(name);
            });
            // A name bound on both sides of the merge would collide.
            for (const name of names[index]!) if (outside.has(name)) return false;
            // A hoisted output's ref resolves against the scope's subtree, which
            // the move widens to the parent's. That only changes which binding
            // it finds if the name is ambiguous - a name bound exactly once in
            // the tree resolves to the same node either way.
            for (const output of outputs) {
              for (const token of output.tokens) {
                if (token.kind === "ref" && outside.has(token.target.name)) {
                  if (ambiguous.has(token.target.name)) return false;
                }
              }
            }
            return true;
          };

          for (const [index, child] of children.entries()) {
            if (
              child.kind === "sequence" &&
              child.attrs.join === node.attrs.join &&
              isInlinable(child.meta) &&
              isSafeToMerge(child, index)
            ) {
              changed = true;
              nodes.push(...child.attrs.nodes);
              // The inlined child was the scope its outputs belonged to; this
              // sequence is now that scope, so they move here rather than
              // vanishing with the node.
              if (child.meta?.outputs) hoisted.push(...child.meta.outputs);
            } else {
              nodes.push(child);
            }
          }

          const flattened: Expr = { ...node, attrs: { ...node.attrs, nodes } };
          if (hoisted.length > 0) {
            flattened.meta = { ...node.meta, outputs: [...(node.meta?.outputs ?? []), ...hoisted] };
          }
          return flattened;
        }

        case "alternative": {
          const children = node.attrs.alts.map(visit);
          const alts: Expr[] = [];

          for (const child of children) {
            if (child.kind === "alternative" && !child.meta) {
              changed = true;
              alts.push(...child.attrs.alts);
            } else {
              alts.push(child);
            }
          }

          return { ...node, attrs: { ...node.attrs, alts } };
        }

        case "optional":
          return { ...node, attrs: { node: visit(node.attrs.node) } };

        case "repeat":
          return { ...node, attrs: { ...node.attrs, node: visit(node.attrs.node) } };

        case "literal":
        case "int":
        case "float":
        case "str":
        case "path":
          return node;

        default: {
          const _exhaustive: never = node;
          return node;
        }
      }
    }

    return {
      expr: visit(expr),
      status: changed ? PassStatus.Changed : PassStatus.Unchanged,
    };
  },
};
