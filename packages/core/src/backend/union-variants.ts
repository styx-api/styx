import type { BoundType, BoundVariant } from "../bindings/index.js";

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
