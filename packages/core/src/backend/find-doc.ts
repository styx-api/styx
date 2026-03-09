import type { BoundType } from "../bindings/index.js";
import type { Expr } from "../ir/index.js";

/**
 * Find a description from an IR node, traversing through wrapper nodes.
 *
 * The parser's `wrapNode` hoists doc metadata to the outermost wrapper node,
 * but the solver's simplify pass can collapse sequences, burying descriptions
 * deeper in the tree.
 *
 * This traversal is type-aware: it only enters sequences when the corresponding
 * BoundType is not a struct. Struct sequences have their own field collection
 * call, so entering them would steal nested struct children's descriptions.
 *
 * @param node - The IR node to search for a description.
 * @param fieldType - The BoundType of the field, used to determine traversal boundaries.
 */
export function findDoc(node: Expr, fieldType: BoundType): string | undefined {
  if (node.meta?.doc?.description) return node.meta.doc.description;
  switch (node.kind) {
    case "optional":
      return findDoc(node.attrs.node, fieldType.kind === "optional" ? fieldType.inner : fieldType);
    case "repeat":
      return findDoc(node.attrs.node, fieldType.kind === "list" ? fieldType.item : fieldType);
    case "sequence": {
      // Only traverse into sequences that were collapsed (non-struct field types).
      // Struct sequences have their own collectFieldInfo call for their children.
      if (fieldType.kind === "struct") return undefined;
      for (const child of node.attrs.nodes) {
        const doc = findDoc(child, fieldType);
        if (doc) return doc;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
