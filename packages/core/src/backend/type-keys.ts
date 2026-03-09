import type { BoundType } from "../bindings/index.js";

/** Stable identity key for a struct type (based on field names). */
export function structKey(type: Extract<BoundType, { kind: "struct" }>): string {
  return `struct:${Object.keys(type.fields).join(",")}`;
}

/** Stable identity key for a union type (based on variant names). */
export function unionKey(type: Extract<BoundType, { kind: "union" }>): string {
  return `union:${type.variants.map((v) => v.name ?? "?").join(",")}`;
}

/** Returns a stable identity key for struct/union types, undefined for others. */
export function typeKey(type: BoundType): string | undefined {
  if (type.kind === "struct") return structKey(type);
  if (type.kind === "union") return unionKey(type);
  return undefined;
}
