import type { Binding, BoundType } from "../bindings/index.js";
import type { Expr } from "../ir/index.js";
import type { CodegenContext } from "../manifest/index.js";

/**
 * Resolve a struct child node to its field binding, handling collapsed sequences.
 *
 * When the solver's simplify pass collapses `seq(lit("--flag"), terminal)` into
 * just the terminal, the binding ends up on the inner node while metadata (doc,
 * defaultValue) may remain on the outermost wrapper. This function recursively
 * descends through collapsed sequences to find the binding, tracking the outermost
 * node for metadata recovery.
 *
 * Uses type identity (`===`) to verify the binding matches the struct's field type,
 * preventing cross-nesting name collisions where an inner struct has a field with
 * the same name as the outer struct.
 */
export function resolveFieldBinding(
  node: Expr,
  ctx: CodegenContext,
  structType: Extract<BoundType, { kind: "struct" }>,
  outermost?: Expr,
): { binding: Binding; wrapperNode: Expr } | undefined {
  const wrapper = outermost ?? node;
  const binding = ctx.resolve(node);
  if (
    binding &&
    binding.name in structType.fields &&
    binding.type === structType.fields[binding.name]
  ) {
    return { binding, wrapperNode: wrapper };
  }
  // Recurse into collapsed sequences to find the binding deeper
  if (node.kind === "sequence") {
    for (const inner of node.attrs.nodes) {
      const result = resolveFieldBinding(inner, ctx, structType, wrapper);
      if (result) return result;
    }
  }
  return undefined;
}
