import type { BoundType } from "../bindings/index.js";
import type { CodegenContext } from "../manifest/index.js";
import { findDoc } from "./find-doc.js";
import { findStructNode } from "./find-struct-node.js";
import { resolveFieldBinding } from "./resolve-field-binding.js";

/**
 * Metadata extracted for each field of a struct type.
 *
 * `doc` is the field's description, recovered from wrapper nodes via `findDoc`.
 * `defaultValue` is pulled from the wrapper or binding node's metadata.
 */
export interface FieldInfo {
  doc?: string;
  defaultValue?: string | number | boolean;
}

/**
 * Collect field metadata (doc, defaultValue) for each field of a struct type.
 *
 * Walks the IR tree to find the sequence node containing the struct's fields,
 * then resolves each child to its field binding. Metadata is recovered from both
 * the wrapper node (where the parser hoists doc) and the binding node (where the
 * solver places the binding after sequence collapse).
 */
export function collectFieldInfo(
  ctx: CodegenContext,
  structType: Extract<BoundType, { kind: "struct" }>,
): Map<string, FieldInfo> {
  const info = new Map<string, FieldInfo>();

  const structNode = findStructNode(ctx.expr, ctx, structType);
  if (!structNode) return info;

  for (const child of structNode.attrs.nodes) {
    const match = resolveFieldBinding(child, ctx, structType);
    if (!match) continue;
    const { binding, wrapperNode } = match;
    const fieldInfo: FieldInfo = {};
    const fieldType = structType.fields[binding.name]!;
    // Check wrapper node first (doc may be hoisted there), then binding node
    const doc = findDoc(wrapperNode, fieldType) ?? findDoc(binding.node, fieldType);
    if (doc) fieldInfo.doc = doc;
    const defaultValue = wrapperNode.meta?.defaultValue ?? binding.node.meta?.defaultValue;
    if (defaultValue !== undefined) fieldInfo.defaultValue = defaultValue;
    info.set(binding.name, fieldInfo);
  }

  return info;
}
