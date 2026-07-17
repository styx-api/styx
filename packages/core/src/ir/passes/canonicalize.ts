import type { Expr } from "../node.js";
import { PassStatus, type Pass, type PassResult } from "./pass.js";

/**
 * Canonicalize IR for consistent representation:
 * - Sort alternatives by kind, then name, then structure
 * - Deduplicate identical alternatives
 */
export const canonicalize: Pass = {
  name: "canonicalize",
  apply(expr: Expr): PassResult {
    let changed = false;

    function structuralHash(node: Expr): string {
      switch (node.kind) {
        case "literal":
          return `lit:${node.attrs.str}`;
        case "int":
          return `int:${node.attrs.minValue ?? ""}:${node.attrs.maxValue ?? ""}`;
        case "float":
          return `float:${node.attrs.minValue ?? ""}:${node.attrs.maxValue ?? ""}`;
        case "str":
          return "str";
        case "path":
          return `path:${node.attrs.resolveParent ?? ""}:${node.attrs.mutable ?? ""}`;
        case "optional":
          return `opt:${structuralHash(node.attrs.node)}`;
        case "repeat":
          return `rep:${node.attrs.join ?? ""}:${structuralHash(node.attrs.node)}`;
        case "sequence":
          return `seq:${node.attrs.join ?? ""}:${node.attrs.nodes.map(structuralHash).join(",")}`;
        case "alternative":
          return `alt:${node.attrs.alts.map(structuralHash).join(",")}`;
        default: {
          const _exhaustive: never = node;
          return "";
        }
      }
    }

    // Identity for dedup: structure plus the meta that makes two structurally
    // identical union arms semantically distinct - the variant tag (@type
    // discriminant), name, and attached outputs. Deduping on structure alone
    // would silently drop a distinct arm (e.g. two sub-commands with the same
    // inner shape but different @type), making its variant unreachable.
    function identityKey(node: Expr): string {
      const m = node.meta;
      const metaKey = m
        ? [m.name ?? "", m.variantTag ?? "", m.outputs ? JSON.stringify(m.outputs) : ""].join("|")
        : "";
      return `${structuralHash(node)}#${metaKey}`;
    }

    function sortKey(node: Expr): string {
      const name = node.meta?.name ?? "";
      return `${node.kind}:${name}:${structuralHash(node)}`;
    }

    function visit(node: Expr): Expr {
      switch (node.kind) {
        case "alternative": {
          const children = node.attrs.alts.map(visit);

          // Sort alternatives
          const sorted = [...children].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

          // Deduplicate identical arms (structure + discriminating meta).
          const seen = new Set<string>();
          const alts: Expr[] = [];
          for (const child of sorted) {
            const key = identityKey(child);
            if (!seen.has(key)) {
              seen.add(key);
              alts.push(child);
            } else {
              changed = true;
            }
          }

          // Check if order changed
          if (
            alts.length !== children.length ||
            alts.some((alt, i) => identityKey(alt) !== identityKey(children[i]!))
          ) {
            changed = true;
          }

          return { ...node, attrs: { ...node.attrs, alts } };
        }

        case "sequence": {
          const nodes = node.attrs.nodes.map(visit);
          return { ...node, attrs: { ...node.attrs, nodes } };
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
