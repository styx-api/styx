import type { Binding, BindingId, BoundType, SolveResult } from "../bindings/index.js";
import { createRegistry } from "../bindings/index.js";
import type { Expr, Literal } from "../ir/index.js";
import { indexTree, resolveOutputs } from "./resolve-outputs.js";
import { validateOutputs } from "./validate-outputs.js";

export interface SolveOptions {
  namingStrategy?: NamingStrategy;
}

export interface NamingStrategy {
  getName: (node: Expr, path: string[]) => string;
  generateId: () => BindingId;
}

// Shared helper for deep name search
function findDeepName(node: Expr): string | undefined {
  if (node.meta?.name) return node.meta.name;

  if (node.kind === "optional" || node.kind === "repeat") {
    return findDeepName(node.attrs.node);
  }

  if (node.kind === "sequence") {
    return node.attrs.nodes
      .filter((n) => n.kind !== "literal")
      .map(findDeepName)
      .find(Boolean);
  }

  return undefined;
}

export function defaultNamingStrategy(): NamingStrategy {
  let counter = 0;

  return {
    getName: (node, path) => findDeepName(node) ?? path[path.length - 1] ?? `param_${counter++}`,
    generateId: () => `binding_${counter++}`,
  };
}

// Helper to check if alternative should collapse to bool
function isBooleanLiteralPair(variants: Array<{ type: BoundType }>): boolean {
  if (variants.length !== 2 || !variants.every((v) => v.type.kind === "literal")) {
    return false;
  }
  const [a, b] = variants.map((v) => (v.type.kind === "literal" ? v.type.value : null));
  return (
    (a === 0 && b === 1) ||
    (a === 1 && b === 0) ||
    (a === "0" && b === "1") ||
    (a === "1" && b === "0") ||
    (a === "false" && b === "true") ||
    (a === "true" && b === "false")
  );
}

// Helper to create literal bound type from IR literal
function literalFromNode(node: Literal): BoundType {
  const str = node.attrs.str;
  const num = Number(str);
  const isCleanInt = Number.isInteger(num) && !Number.isNaN(num) && String(num) === str;
  return { kind: "literal", value: isCleanInt ? num : str };
}

/**
 * Name to give the single wrapped field when a non-struct variant gets boxed
 * into a discriminated struct. For a sequence arm the wrapped value is the
 * inner parameter (`seq(lit("convert"), path{src})` -> `src`), so look past the
 * arm's own (variant) name; otherwise use the value's own deep name.
 */
function innerParamName(armNode: Expr): string {
  if (armNode.kind === "sequence") {
    const inner = armNode.attrs.nodes
      .filter((n) => n.kind !== "literal")
      .map(findDeepName)
      .find(Boolean);
    if (inner) return inner;
  }
  return findDeepName(armNode) ?? "value";
}

/**
 * Discriminated form of a variant's type: literal variants discriminate by
 * value (returned unchanged); struct variants get an `@type` field prepended;
 * anything else is boxed into `{ "@type": <name>, <field>: <type> }`. Pure -
 * never mutates `type`.
 */
function taggedVariantType(name: string, type: BoundType, armNode: Expr): BoundType {
  if (type.kind === "literal") return type;
  const tag: BoundType = { kind: "literal", value: name };
  if (type.kind === "struct") return { kind: "struct", fields: { "@type": tag, ...type.fields } };
  return { kind: "struct", fields: { "@type": tag, [innerParamName(armNode)]: type } };
}

export function solve(expr: Expr, options?: SolveOptions): SolveResult {
  const strategy = options?.namingStrategy ?? defaultNamingStrategy();
  const registry = createRegistry();
  const nodeToBinding = new WeakMap<Expr, Binding>();

  function createBinding(node: Expr, name: string, type: BoundType): Binding {
    const binding: Binding = { id: strategy.generateId(), node, name, type };
    registry.set(binding.id, binding);
    nodeToBinding.set(node, binding);
    return binding;
  }

  function solveNode(node: Expr, path: string[]): BoundType | null {
    const name = strategy.getName(node, path);

    switch (node.kind) {
      case "literal":
        return null;

      case "optional": {
        const inner = solveNode(node.attrs.node, [...path, name]);
        if (inner === null) {
          const type: BoundType = { kind: "bool" };
          createBinding(node, name, type);
          return type;
        }
        const type: BoundType = { kind: "optional", inner };
        createBinding(node, name, type);
        return type;
      }

      case "repeat": {
        const inner = solveNode(node.attrs.node, [...path, name]);
        if (inner === null) {
          const type: BoundType = { kind: "count" };
          createBinding(node, name, type);
          return type;
        }
        const type: BoundType = { kind: "list", item: inner };
        createBinding(node, name, type);
        return type;
      }

      case "sequence": {
        const fields: Record<string, BoundType> = {};
        for (const child of node.attrs.nodes) {
          const childName = strategy.getName(child, path);
          const childType = solveNode(child, [...path, childName]);
          if (childType !== null) fields[childName] = childType;
        }
        if (Object.keys(fields).length === 0) return null;
        if (Object.keys(fields).length === 1) return Object.values(fields)[0]!;
        const type: BoundType = { kind: "struct", fields };
        createBinding(node, name, type);
        return type;
      }

      case "alternative": {
        // Solve all variants
        const variants = node.attrs.alts.map((alt, i) => {
          const childType =
            solveNode(alt, [...path, `variant_${i}`]) ??
            (alt.kind === "literal" ? literalFromNode(alt) : { kind: "bool" as const });

          const name =
            alt.meta?.name ??
            (alt.kind === "literal"
              ? alt.attrs.str.replace(/^-+/, "")
              : `variant_${i}`);

          return { name, type: childType, node: alt };
        });

        // Pattern: boolean pair -> bool
        if (isBooleanLiteralPair(variants)) {
          const type: BoundType = { kind: "bool" };
          createBinding(node, name, type);
          return type;
        }

        // Discriminate each variant. When an arm carries its own binding (a
        // multi-field struct), retype it so that binding and the union agree;
        // collapsed single-field arms keep their inner binding and the boxed
        // form lives only in the union's `variants`.
        for (const v of variants) {
          v.type = taggedVariantType(v.name, v.type, v.node);
          const armBinding = nodeToBinding.get(v.node);
          if (armBinding) armBinding.type = v.type;
        }

        const type: BoundType = {
          kind: "union",
          variants: variants.map(({ name, type }) => ({ name, type })),
        };
        createBinding(node, name, type);
        return type;
      }

      case "int":
      case "float":
      case "str":
      case "path": {
        const type: BoundType = { kind: "scalar", scalar: node.kind };
        createBinding(node, name, type);
        return type;
      }
    }
  }

  const rootType = solveNode(expr, []);

  // Ensure a root binding always exists, even when the sequence collapsed
  // (0 fields -> empty struct, 1 field that's not already a struct -> wrap in single-field struct)
  if (!nodeToBinding.has(expr) && expr.kind === "sequence") {
    const name = strategy.getName(expr, []);
    if (rootType === null) {
      createBinding(expr, name, { kind: "struct", fields: {} });
    } else if (rootType.kind === "struct") {
      // Already a struct (e.g. joined seq with 2+ fields) - use it directly
      createBinding(expr, name, rootType);
    } else {
      // Single scalar/optional/list field was collapsed - wrap it in a struct
      const childName = expr.attrs.nodes
        .map((child) => nodeToBinding.get(child))
        .find(Boolean)?.name;
      if (childName) {
        createBinding(expr, name, { kind: "struct", fields: { [childName]: rootType } });
      }
    }
  }

  const resolve = (node: Expr) => nodeToBinding.get(node);
  // Outputs live on `NodeMeta.outputs` of the nodes that own them; build the
  // index once and share it between resolution and validation.
  const index = indexTree(expr, resolve);
  const outputs = resolveOutputs(expr, resolve, index);
  const outputDiagnostics = validateOutputs(expr, resolve, index);
  return { bindings: registry, resolve, outputs, outputDiagnostics };
}
