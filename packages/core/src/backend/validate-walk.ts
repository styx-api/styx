import type { BoundType } from "../bindings/index.js";
import type { Expr, Float, Int, Repeat } from "../ir/index.js";
import type { CodegenContext } from "../manifest/index.js";
import { collectFieldInfo } from "./collect-field-info.js";
import { findStructNode } from "./find-struct-node.js";
import { resolveFieldBinding } from "./resolve-field-binding.js";

/**
 * Shared, language-agnostic tree-walk helpers for validation emit.
 *
 * Validation walks the solved root `BoundType` for the data shape, but the
 * runtime constraints it checks (int/float range, list length) live on the
 * underlying IR nodes, not the `BoundType`. These helpers bridge the two: they
 * map a struct's fields to their IR binding nodes and locate the IR node that
 * carries a given constraint within a field's subtree.
 */

/** A struct field paired with its BoundType and (when resolvable) its IR node. */
export interface FieldEntry {
  name: string;
  type: BoundType;
  /** The IR node the field's binding was solved from. `undefined` if it could
   * not be resolved (constraint lookups then degrade gracefully). */
  node: Expr | undefined;
  /**
   * Whether the field has a default value. Such fields (and flags) accept
   * `None`/`null` to mean "use the default", so validation gates them like
   * optionals rather than requiring presence - matching v1 niwrap.
   */
  hasDefault: boolean;
}

/**
 * Enumerate a struct type's fields in declaration order, each paired with the
 * IR node its binding resolved from. `searchRoot` is the IR subtree known to
 * contain the struct (the root expr for the top-level struct, or a field /
 * union-arm node for nested ones).
 */
export function structFields(
  ctx: CodegenContext,
  structType: Extract<BoundType, { kind: "struct" }>,
  searchRoot: Expr | undefined,
): FieldEntry[] {
  const nodeByName = new Map<string, Expr>();
  if (searchRoot) {
    const structNode = findStructNode(searchRoot, ctx, structType);
    if (structNode) {
      for (const child of structNode.attrs.nodes) {
        const match = resolveFieldBinding(child, ctx, structType);
        if (match) nodeByName.set(match.binding.name, match.binding.node);
      }
    }
  }
  const fieldInfo = collectFieldInfo(ctx, structType);
  return Object.entries(structType.fields).map(([name, type]) => ({
    name,
    type,
    node: nodeByName.get(name),
    hasDefault: fieldInfo.get(name)?.defaultValue !== undefined,
  }));
}

/**
 * Depth-first search for the first node satisfying `pred`, descending through
 * the transparent structural wrappers the solver may bury a binding under
 * (sequence/optional/repeat/alternative).
 */
export function findNode(
  node: Expr | undefined,
  pred: (n: Expr) => boolean,
): Expr | undefined {
  if (!node) return undefined;
  if (pred(node)) return node;
  switch (node.kind) {
    case "sequence":
      for (const child of node.attrs.nodes) {
        const r = findNode(child, pred);
        if (r) return r;
      }
      return undefined;
    case "optional":
      return findNode(node.attrs.node, pred);
    case "repeat":
      return findNode(node.attrs.node, pred);
    case "alternative":
      for (const alt of node.attrs.alts) {
        const r = findNode(alt, pred);
        if (r) return r;
      }
      return undefined;
    default:
      return undefined;
  }
}

/** Locate the int/float node carrying a scalar field's numeric range. */
export function findRangeNode(node: Expr | undefined): Int | Float | undefined {
  const found = findNode(node, (n) => n.kind === "int" || n.kind === "float");
  return found as Int | Float | undefined;
}

/** Locate the repeat node carrying a list field's length bounds and item. */
export function findRepeatNode(node: Expr | undefined): Repeat | undefined {
  const found = findNode(node, (n) => n.kind === "repeat");
  return found as Repeat | undefined;
}

/** Locate the alternative node backing a union field, to map arms to variants. */
export function findAlternativeNode(
  node: Expr | undefined,
): Extract<Expr, { kind: "alternative" }> | undefined {
  const found = findNode(node, (n) => n.kind === "alternative");
  return found as Extract<Expr, { kind: "alternative" }> | undefined;
}
