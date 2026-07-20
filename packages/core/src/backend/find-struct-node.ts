import type { BoundType } from "../bindings/index.js";
import type { Expr } from "../ir/index.js";
import type { CodegenContext } from "../manifest/index.js";
import { resolveFieldBinding } from "./resolve-field-binding.js";

/**
 * Find the sequence node whose child bindings match a struct type's fields.
 *
 * Traverses through optional, repeat, and alternative wrappers to find the
 * sequence that directly contains the struct's field bindings. This is necessary
 * because the solver may collapse `seq(lit("--flag"), terminal)` into the terminal,
 * burying bindings deeper in the tree.
 *
 * Uses a two-phase check for sequences:
 * 1. Direct binding check (`ctx.resolve`) - matches when bindings are on immediate children
 * 2. Recursive binding check (`resolveFieldBinding`) - matches when solver collapsed
 *    a seq(lit, terminal) and the binding is buried deeper
 *
 * Phase 1 is tried first to avoid falsely matching an outer sequence when an inner
 * sequence is the actual struct owner (e.g. `seq(lit("--flag"), seq(field1, field2))`).
 */
export function findStructNode(
  node: Expr,
  ctx: CodegenContext,
  structType: Extract<BoundType, { kind: "struct" }>,
): Extract<Expr, { kind: "sequence" }> | undefined {
  // An empty struct (no fields) has no field bindings to match, but it is still a
  // real scope: a parameterless output-bearing command like `seq(lit("run"))`
  // with an output-file. Its scope node is simply the sequence carrying it, so a
  // backend can emit the (field-less) command line and its outputs.
  if (node.kind === "sequence" && Object.keys(structType.fields).length === 0) {
    return node;
  }
  switch (node.kind) {
    case "sequence": {
      // Phase 1: Check if any direct child has a binding matching a struct field
      for (const child of node.attrs.nodes) {
        const binding = ctx.resolve(child);
        if (
          binding &&
          binding.name in structType.fields &&
          binding.type === structType.fields[binding.name]
        ) {
          return node;
        }
      }
      // Recurse into child nodes first (prefer deeper matches)
      for (const child of node.attrs.nodes) {
        const result = findStructNode(child, ctx, structType);
        if (result) return result;
      }
      // Phase 2: Check via resolveFieldBinding for collapsed sequences
      // where bindings are buried inside collapsed seq(lit, terminal)
      for (const child of node.attrs.nodes) {
        if (resolveFieldBinding(child, ctx, structType)) return node;
      }
      return undefined;
    }
    case "optional":
      return findStructNode(node.attrs.node, ctx, structType);
    case "repeat":
      return findStructNode(node.attrs.node, ctx, structType);
    case "alternative": {
      for (const alt of node.attrs.alts) {
        const result = findStructNode(alt, ctx, structType);
        if (result) return result;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
