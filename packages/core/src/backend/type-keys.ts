import type { BoundType } from "../bindings/index.js";

/**
 * Stable, fully structural identity key for any BoundType.
 *
 * Two types share a key iff they are structurally identical - same shape AND
 * same leaf types/literal values, recursively. This is what `collectNamedTypes`
 * dedups on: distinct nominal types must get distinct keys so each gets its own
 * generated name.
 *
 * Keying on field/variant *names* alone is too coarse: discriminated-union
 * variants that differ only by their `@type` literal (e.g. ANTs' `transform_*`
 * variants, all `{ "@type": <literal>, gradient_step: float }`) would collapse
 * to one identity, emitting `Transform = TransformRigid | TransformRigid | ...`
 * and breaking discriminated-union narrowing. Including the field types (and
 * thus the `@type` literal value) keeps them distinct.
 */
export function typeKey(type: BoundType): string {
  switch (type.kind) {
    case "scalar":
      return `scalar:${type.scalar}`;
    case "bool":
      return "bool";
    case "count":
      return "count";
    case "literal":
      // JSON.stringify disambiguates the value's type too (e.g. "2" vs 2).
      return `literal:${JSON.stringify(type.value)}`;
    case "optional":
      return `optional(${typeKey(type.inner)})`;
    case "list":
      return `list(${typeKey(type.item)})`;
    case "struct":
      return structKey(type);
    case "union":
      return unionKey(type);
  }
}

/** Stable identity key for a struct type (field names + field types). */
export function structKey(type: Extract<BoundType, { kind: "struct" }>): string {
  const fields = Object.entries(type.fields)
    .map(([name, fieldType]) => `${name}=${typeKey(fieldType)}`)
    .join(",");
  return `struct{${fields}}`;
}

/** Stable identity key for a union type (variant names + variant types). */
export function unionKey(type: Extract<BoundType, { kind: "union" }>): string {
  const variants = type.variants.map((v) => `${v.name ?? "?"}=${typeKey(v.type)}`).join("|");
  return `union[${variants}]`;
}
