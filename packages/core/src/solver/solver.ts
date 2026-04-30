import type { Binding, BindingId, BoundType, SolveResult } from "../bindings/index.js";
import { createRegistry } from "../bindings/index.js";
import type { Expr } from "../ir/index.js";

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

// Helper to inject discriminator into variant
function tagVariant(variant: { name: string; type: BoundType; node: Expr }): void {
  if (variant.type.kind === "literal") return;

  const tag: BoundType = { kind: "literal", value: variant.name };

  if (variant.type.kind === "struct") {
    variant.type.fields = { "@type": tag, ...variant.type.fields };
  } else {
    const fieldName = findDeepName(variant.node) || "value";
    variant.type = {
      kind: "struct",
      fields: { "@type": tag, [fieldName]: variant.type },
    };
  }
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

        // Pattern: all literals -> literal union
        const allLiterals = variants.every((v) => v.type.kind === "literal");
        if (!allLiterals) {
          // Complex union -> inject discriminators
          variants.forEach(tagVariant);
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

  return { bindings: registry, resolve: (node) => nodeToBinding.get(node) };
}
