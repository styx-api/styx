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
  /**
   * A synthetic name for a genuine (surviving) anonymous struct - one with no
   * `meta.name` of its own. Unlike `getName`, which would steal the struct's
   * first field name (via `findDeepName`) and collide with that field, this
   * returns a `structN` guaranteed not to clash with any of the struct's own
   * field keys.
   */
  freshStructName: (fields: Record<string, BoundType>) => string;
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
  let structCounter = 0;

  return {
    getName: (node, path) => findDeepName(node) ?? path[path.length - 1] ?? `param_${counter++}`,
    generateId: () => `binding_${counter++}`,
    freshStructName: (fields) => {
      let candidate: string;
      do {
        candidate = `struct${++structCounter}`;
      } while (Object.hasOwn(fields, candidate));
      return candidate;
    },
  };
}

// Helper to check if alternative should collapse to bool
function isBooleanLiteralPair(variants: Array<{ type: BoundType }>): boolean {
  if (variants.length !== 2 || !variants.every((v) => v.type.kind === "literal")) {
    return false;
  }
  const [a, b] = variants.map((v) => (v.type.kind === "literal" ? v.type.value : null));
  // `literalFromNode` canonicalizes clean-int literals, so "0"/"1" arrive as the
  // numbers 0/1 (never strings); only "false"/"true" survive as strings.
  return (
    (a === 0 && b === 1) ||
    (a === 1 && b === 0) ||
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
        // The binding behind each field key, so a rare synthetic-name clash can be
        // repaired by renaming whichever colliding party is the auto-named struct.
        const fieldBindings = new Map<string, Binding | undefined>();
        // Track the single binding-bearing child so the collapse check below can
        // inspect its node kind (only meaningful when exactly one field exists).
        let soleFieldChild: Expr | undefined;

        // A synthetic `structN` (see the genuine-struct branch below) is minted
        // here, after the upstream id-dedup pass, so it is the only name that can
        // still clash with a sibling field. When it does, re-mint the *struct*
        // (never an author-named field) against the taken keys so no parameter is
        // silently overwritten. Two synthetic structs never collide (the counter
        // is monotonic), so at most one colliding party is ever an auto-struct.
        const isAutoStruct = (b: Binding | undefined): b is Binding =>
          !!b && b.type.kind === "struct" && !b.node.meta?.name;
        const remint = (b: Binding, taken: Record<string, BoundType>): string => {
          const own = b.type.kind === "struct" ? b.type.fields : {};
          b.name = strategy.freshStructName({ ...taken, ...own });
          return b.name;
        };

        for (const child of node.attrs.nodes) {
          const childName = strategy.getName(child, path);
          const childType = solveNode(child, [...path, childName], gate);
          if (childType === null) continue;
          // Key the field by the child's *registered* binding name, not the
          // pre-computed `childName`. They are identical for every case except a
          // surviving anonymous struct, whose binding the branch below renamed to
          // a synthetic `structN` (see `freshStructName`). Backends look up
          // `structType.fields[binding.name]` (collect-field-info,
          // resolve-field-binding), so the key must track the binding name.
          // Collapsed children register no binding on `child`, so fall back to
          // `childName` - which already equals the buried binding's name.
          const childBinding = nodeToBinding.get(child);
          let fieldKey = childBinding?.name ?? childName;

          if (Object.hasOwn(fields, fieldKey)) {
            if (isAutoStruct(childBinding)) {
              fieldKey = remint(childBinding, fields);
            } else if (isAutoStruct(fieldBindings.get(fieldKey))) {
              // The sibling already holding the key is the auto-struct: move it.
              const existing = fieldBindings.get(fieldKey)!;
              const moved = remint(existing, fields);
              fields[moved] = fields[fieldKey]!;
              fieldBindings.set(moved, existing);
              delete fields[fieldKey];
              fieldBindings.delete(fieldKey);
            }
            // Neither party is an auto-struct: a genuine duplicate author id,
            // which the upstream dedup pass owns (pre-existing overwrite).
          }

          fields[fieldKey] = childType;
          fieldBindings.set(fieldKey, childBinding);
          soleFieldChild = child;
        }
        // A sequence that carries `meta.outputs` must always produce a binding,
        // even when it would otherwise collapse - that binding is the scope key
        // for the outputs declared on it. Empty- and single-field collapses
        // would otherwise leave the scope unbound and the outputs orphaned.
        const hasOutputs = node.meta?.outputs && node.meta.outputs.length > 0;
        if (Object.keys(fields).length === 0) {
          if (hasOutputs) {
            const type: BoundType = { kind: "struct", fields: {} };
            const structName = node.meta?.name ?? strategy.freshStructName(type.fields);
            createBinding(node, structName, type, gate);
            return type;
          }
          return null;
        }
        // Collapse a single-field sequence to that field - e.g. `-x <val>`
        // (`seq(lit("-x"), str)`) becomes just the value, so the flag and its
        // one value read as a single optional/required parameter.
        //
        // EXCEPTION: when the field comes from an `optional` child, the
        // sequence's own literal (e.g. `-whole-file`) can be present while the
        // optional sub-field (e.g. `-demean`) is absent. Collapsing would
        // conflate those two independent optional states and drop the sub-field
        // (it would have no struct to live on). Keep such a sequence a struct so
        // the sub-field stays addressable. A `repeat`/scalar/alternative child
        // is tied 1:1 to the flag's presence, so collapsing those stays correct.
        if (
          Object.keys(fields).length === 1 &&
          !hasOutputs &&
          soleFieldChild?.kind !== "optional"
        ) {
          return Object.values(fields)[0]!;
        }
        // A genuine multi-field anonymous struct must not reuse `name`: for an
        // unnamed aggregate, `getName` derives the name from the first field
        // (via `findDeepName`), which then collides with that very field
        // (`params.X.X`). A named set keeps its `meta.name`; only truly
        // anonymous aggregates get a synthetic `structN` that cannot clash with
        // any of their own field keys.
        const structName = node.meta?.name ?? strategy.freshStructName(fields);
        const type: BoundType = { kind: "struct", fields };
        createBinding(node, structName, type, gate);
        return type;
      }

      case "alternative": {
        const id = preallocate();
        // Resolve each arm's variant name first so child gates can carry it.
        // `variantTag` (the sub-command id) is preferred over `name`: a
        // single-field sub-command collapses onto its inner field, whose `name`
        // wins, so `name` alone would derive the tag from the inner field's id
        // (two distinct sub-commands wrapping a same-named field would collide).
        const armNames = node.attrs.alts.map((alt, i) => {
          if (alt.meta?.variantTag) return alt.meta.variantTag;
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
