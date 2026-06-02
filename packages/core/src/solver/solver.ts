import type { Binding, BindingId, BoundType, GateAtom, SolveResult } from "../bindings/index.js";
import { createRegistry } from "../bindings/index.js";
import type { Expr, Literal } from "../ir/index.js";
import { assignAccessPaths } from "./assign-access.js";

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

  // Wrapper bindings (optional/repeat/alternative) need an id BEFORE recursing
  // into children so the child's `gate` can reference it. Pre-allocate the id
  // here, then materialize the binding with its computed type after the
  // recursion settles.
  function preallocate(): BindingId {
    return strategy.generateId();
  }

  function registerBinding(
    id: BindingId,
    node: Expr,
    name: string,
    type: BoundType,
    gate: GateAtom[],
  ): Binding {
    // `access` is filled by `assignAccessPaths` once all types have settled
    // (sequence collapse-vs-struct and union arm retyping are only known after
    // the full recursion). Start empty so the field is always present.
    const binding: Binding = { id, node, name, type, gate, access: [] };
    registry.set(id, binding);
    nodeToBinding.set(node, binding);
    return binding;
  }

  function createBinding(node: Expr, name: string, type: BoundType, gate: GateAtom[]): Binding {
    return registerBinding(strategy.generateId(), node, name, type, gate);
  }

  function solveNode(node: Expr, path: string[], gate: GateAtom[]): BoundType | null {
    const name = strategy.getName(node, path);

    switch (node.kind) {
      case "literal":
        return null;

      case "optional": {
        const id = preallocate();
        const childGate = [...gate, { kind: "present" as const, binding: id }];
        const inner = solveNode(node.attrs.node, [...path, name], childGate);
        const type: BoundType = inner === null ? { kind: "bool" } : { kind: "optional", inner };
        registerBinding(id, node, name, type, gate);
        return type;
      }

      case "repeat": {
        const id = preallocate();
        // We don't yet know if the inner collapses to a count (no inner
        // binding -> repeat-of-literal) or to a list. Optimistically tag the
        // child gate as `iter`; if the inner is null we replace the wrapper
        // type with `count` and the iter atom never reaches a real binding
        // (no inner binding consumes the gate).
        const childGate = [...gate, { kind: "iter" as const, binding: id }];
        const inner = solveNode(node.attrs.node, [...path, name], childGate);
        const type: BoundType = inner === null ? { kind: "count" } : { kind: "list", item: inner };
        registerBinding(id, node, name, type, gate);
        return type;
      }

      case "sequence": {
        const fields: Record<string, BoundType> = {};
        for (const child of node.attrs.nodes) {
          const childName = strategy.getName(child, path);
          const childType = solveNode(child, [...path, childName], gate);
          if (childType !== null) fields[childName] = childType;
        }
        // A sequence that carries `meta.outputs` must always produce a binding,
        // even when it would otherwise collapse - that binding is the scope key
        // for the outputs declared on it. Empty- and single-field collapses
        // would otherwise leave the scope unbound and the outputs orphaned.
        const hasOutputs = node.meta?.outputs && node.meta.outputs.length > 0;
        if (Object.keys(fields).length === 0) {
          if (hasOutputs) {
            const type: BoundType = { kind: "struct", fields: {} };
            createBinding(node, name, type, gate);
            return type;
          }
          return null;
        }
        if (Object.keys(fields).length === 1 && !hasOutputs) {
          return Object.values(fields)[0]!;
        }
        const type: BoundType = { kind: "struct", fields };
        createBinding(node, name, type, gate);
        return type;
      }

      case "alternative": {
        const id = preallocate();
        // Resolve each arm's variant name first so child gates can carry it.
        const armNames = node.attrs.alts.map((alt, i) => {
          if (alt.meta?.name) return alt.meta.name;
          if (alt.kind === "literal") return alt.attrs.str.replace(/^-+/, "");
          return `variant_${i}`;
        });

        const variants = node.attrs.alts.map((alt, i) => {
          const variantName = armNames[i]!;
          const childGate = [
            ...gate,
            { kind: "variant" as const, binding: id, variant: variantName },
          ];
          const childType =
            solveNode(alt, [...path, `variant_${i}`], childGate) ??
            (alt.kind === "literal" ? literalFromNode(alt) : { kind: "bool" as const });
          return { name: variantName, type: childType, node: alt };
        });

        // Pattern: boolean pair -> bool. The pre-allocated variant atoms in
        // child gates are unreached (literal arms produce no bindings).
        if (isBooleanLiteralPair(variants)) {
          const type: BoundType = { kind: "bool" };
          registerBinding(id, node, name, type, gate);
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
        registerBinding(id, node, name, type, gate);
        return type;
      }

      case "int":
      case "float":
      case "str":
      case "path": {
        const type: BoundType = { kind: "scalar", scalar: node.kind };
        createBinding(node, name, type, gate);
        return type;
      }
    }
  }

  const rootType = solveNode(expr, [], []);

  // Ensure a root binding always exists, even when the sequence collapsed
  // (0 fields -> empty struct, 1 field that's not already a struct -> wrap in single-field struct)
  if (!nodeToBinding.has(expr) && expr.kind === "sequence") {
    const name = strategy.getName(expr, []);
    if (rootType === null) {
      createBinding(expr, name, { kind: "struct", fields: {} }, []);
    } else if (rootType.kind === "struct") {
      // Already a struct (e.g. joined seq with 2+ fields) - use it directly
      createBinding(expr, name, rootType, []);
    } else {
      // Single scalar/optional/list field was collapsed - wrap it in a struct.
      // The field's binding may not be a direct child: a nested sequence that
      // collapsed (e.g. one preserved by flatten to keep its `meta.doc`) leaves
      // the binding buried one or more levels down. Search through collapsed
      // sequences for it. Using `binding.name` as the field name keeps the
      // struct field aligned with the access path the backends render
      // (`params.<binding.name>`).
      const findCollapsedBinding = (node: Expr): Binding | undefined => {
        const b = nodeToBinding.get(node);
        if (b) return b;
        // Only sequences collapse without leaving a binding; optional/repeat/
        // alternative always register one, so no need to descend into them.
        if (node.kind === "sequence") {
          for (const child of node.attrs.nodes) {
            const found = findCollapsedBinding(child);
            if (found) return found;
          }
        }
        return undefined;
      };
      const childName = expr.attrs.nodes.map(findCollapsedBinding).find(Boolean)?.name;
      if (childName) {
        createBinding(expr, name, { kind: "struct", fields: { [childName]: rootType } }, []);
      }
    }
  }

  const resolve = (node: Expr) => nodeToBinding.get(node);

  // Now that every binding's type has settled (sequence collapse, union arm
  // retyping, root fixup), walk the IR once more to attach each binding's
  // access path relative to top-level `params`. Backends render these paths
  // instead of re-deriving them.
  assignAccessPaths(expr, resolve);

  return { bindings: registry, resolve };
}
