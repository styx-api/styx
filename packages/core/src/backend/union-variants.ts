import type { BindingRegistry, BoundType, BoundVariant, GateAtom } from "../bindings/index.js";

/**
 * Whether a union is "mixed": it has at least one non-struct (bare-literal) arm
 * alongside its struct variants (e.g. ants `n4_correction = Literal[0] | N4On`).
 *
 * The `@type` discriminator only exists on the struct arms, so indexing
 * `value["@type"]` on the union value is unsound (a type error, and a runtime
 * KeyError if the literal arm is ever hit) until the value is narrowed to a
 * struct at runtime. Backends that dispatch on `@type` must first emit a shape
 * guard (Python `isinstance(value, dict)`, TS `typeof value === "object"`) when
 * this is true; a pure-struct union (every arm a struct) needs no guard.
 */
export function unionIsMixed(unionType: Extract<BoundType, { kind: "union" }>): boolean {
  return unionType.variants.some((v) => v.type.kind !== "struct");
}

/**
 * The union type bound by a `variant` gate atom, if the atom's binding resolves
 * to a union - used by the outputs emitters to decide whether the variant gate
 * needs a mixed-union shape guard before its `@type` check. Returns `undefined`
 * for a well-formed non-union (defensive; a variant atom should always name a
 * union binding).
 */
export function variantAtomUnion(
  atom: Extract<GateAtom, { kind: "variant" }>,
  bindings: BindingRegistry,
): Extract<BoundType, { kind: "union" }> | undefined {
  return resolveUnion(bindings.get(atom.binding)?.type);
}

function resolveUnion(
  type: BoundType | undefined,
): Extract<BoundType, { kind: "union" }> | undefined {
  if (!type) return undefined;
  // An `optional<union>` binding can carry a variant gate (the optional wrapper
  // and the union collapse onto one access path); unwrap to reach the union.
  if (type.kind === "optional") return resolveUnion(type.inner);
  if (type.kind === "union") return type;
  return undefined;
}

/** A union's struct variant paired with its index into the union's `variants`
 * array (which stays parallel to the IR `alts` and the per-arm results a caller
 * builds, so the index must be threaded through). */
export interface IndexedStructVariant {
  variant: BoundVariant;
  i: number;
}

/**
 * The struct variants of a union, each with its index into `variants`.
 *
 * A discriminated union dispatches on a unique `@type`, so two struct variants
 * sharing a tag are a malformed union: the second is unreachable at runtime and
 * emits a dead branch (a mypy `comparison-overlap` in the Python backend's
 * `if`/`elif` chain). Producing well-formed, unique-tagged unions is a frontend
 * responsibility - the Boutiques frontend dodges duplicate sub-command ids
 * (`orient` -> `orient_2`). This asserts that invariant at the backend boundary
 * and throws if it is violated, rather than silently emitting a dead branch.
 */
export function structVariants(
  unionType: Extract<BoundType, { kind: "union" }>,
): IndexedStructVariant[] {
  const seen = new Set<string>();
  const out: IndexedStructVariant[] = [];
  unionType.variants.forEach((variant, i) => {
    if (variant.type.kind !== "struct") return;
    const tag = variant.name ?? "";
    if (seen.has(tag)) {
      throw new Error(
        `duplicate union variant @type ${JSON.stringify(tag)}: a discriminated ` +
          `union dispatches on a unique @type, so a second variant with the same ` +
          `tag is unreachable. Frontends must dodge duplicate variant tags before ` +
          `codegen (the Boutiques frontend renames duplicate sub-command ids).`,
      );
    }
    seen.add(tag);
    out.push({ variant, i });
  });
  return out;
}
