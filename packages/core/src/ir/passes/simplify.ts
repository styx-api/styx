import type { NodeMeta } from "../meta.js";
import type { Expr } from "../node.js";
import { PassStatus, type Pass, type PassResult } from "./pass.js";

/**
 * Merge two `NodeMeta` when collapsing a wrapper layer (the child is the
 * inner/surviving node). Name, doc fields and defaultValue take the innermost
 * value; `outputs` from both layers are concatenated so an output attached to
 * a collapsed wrapper survives on whatever node absorbs it.
 */
function mergeMeta(parent?: NodeMeta, child?: NodeMeta): NodeMeta | undefined {
  if (!parent && !child) return undefined;
  if (!parent) return child;
  if (!child) return parent;

  const merged: NodeMeta = {};

  const name = child.name ?? parent.name;
  if (name !== undefined) merged.name = name;

  const defaultValue = child.defaultValue ?? parent.defaultValue;
  if (defaultValue !== undefined) merged.defaultValue = defaultValue;

  if (parent.doc || child.doc) {
    merged.doc = {
      title: child.doc?.title ?? parent.doc?.title,
      description: child.doc?.description ?? parent.doc?.description,
      authors: [...(parent.doc?.authors ?? []), ...(child.doc?.authors ?? [])],
      literature: [...(parent.doc?.literature ?? []), ...(child.doc?.literature ?? [])],
      urls: [...(parent.doc?.urls ?? []), ...(child.doc?.urls ?? [])],
      comment: child.doc?.comment ?? parent.doc?.comment,
    };
  }

  const outputs = [...(parent.outputs ?? []), ...(child.outputs ?? [])];
  if (outputs.length > 0) merged.outputs = outputs;

  return merged;
}

/**
 * Simplify passes:
 * - optional(optional(T)) -> optional(T)
 * - repeat(repeat(T)) -> repeat(T) with merged constraints
 * - seq(T) -> T, alt(T) -> T (singleton unwrapping)
 * - seq(lit("a"), lit("b")) -> seq(lit("ab")) (merge consecutive literals)
 *
 * Every collapse that drops a wrapper layer merges that layer's `NodeMeta`
 * into the surviving node via `mergeMeta`, so names and attached outputs are
 * never lost.
 */
export const simplify: Pass = {
  name: "simplify",
  apply(expr: Expr): PassResult {
    let changed = false;

    function visit(node: Expr): Expr {
      switch (node.kind) {
        case "optional": {
          const inner = visit(node.attrs.node);

          // optional(optional(T)) -> optional(T)
          if (inner.kind === "optional") {
            changed = true;
            return {
              ...node,
              attrs: { node: inner.attrs.node },
              meta: mergeMeta(node.meta, inner.meta),
            };
          }

          return { ...node, attrs: { node: inner } };
        }

        case "repeat": {
          const inner = visit(node.attrs.node);

          // repeat(repeat(T)) -> repeat(T) with merged constraints
          if (inner.kind === "repeat") {
            changed = true;
            return {
              ...node,
              attrs: {
                node: inner.attrs.node,
                join: node.attrs.join ?? inner.attrs.join,
                countMin: Math.max(node.attrs.countMin ?? 0, inner.attrs.countMin ?? 0),
                countMax:
                  node.attrs.countMax === undefined || inner.attrs.countMax === undefined
                    ? undefined
                    : Math.min(node.attrs.countMax, inner.attrs.countMax),
              },
              meta: mergeMeta(node.meta, inner.meta),
            };
          }

          return { ...node, attrs: { ...node.attrs, node: inner } };
        }

        case "sequence": {
          const children = node.attrs.nodes.map(visit);

          // Merge consecutive literals (only with empty/no join, no metadata)
          const nodes: Expr[] = [];
          for (const child of children) {
            const prev = nodes[nodes.length - 1];
            if (
              prev?.kind === "literal" &&
              child.kind === "literal" &&
              !prev.meta &&
              !child.meta &&
              (node.attrs.join === "" || node.attrs.join === undefined)
            ) {
              changed = true;
              prev.attrs.str += child.attrs.str;
            } else {
              nodes.push(child);
            }
          }

          // seq(T) -> T, carrying the seq's meta down onto the child.
          if (nodes.length === 1) {
            const child = nodes[0]!;
            changed = true;
            const mergedMeta = mergeMeta(node.meta, child.meta);
            return mergedMeta ? { ...child, meta: mergedMeta } : child;
          }

          return { ...node, attrs: { ...node.attrs, nodes } };
        }

        case "alternative": {
          const alts = node.attrs.alts.map(visit);

          // alt(T) -> T. Only when the alt carries no metadata of its own
          // (otherwise the collapse would orphan it).
          if (alts.length === 1 && !node.meta) {
            changed = true;
            return alts[0]!;
          }

          return { ...node, attrs: { ...node.attrs, alts } };
        }

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
