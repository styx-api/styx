// Re-export shared utilities for convenience. All logic lives in shared
// backend modules.

export { structKey, unionKey } from "../type-keys.js";
export type { NamedType } from "../collect-named-types.js";
export { collectNamedTypes, resolveTypeName } from "../collect-named-types.js";
export type { FieldInfo } from "../collect-field-info.js";
export { collectFieldInfo } from "../collect-field-info.js";
