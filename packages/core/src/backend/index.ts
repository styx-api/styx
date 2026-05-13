export type { Backend, EmitError, EmitResult, EmitWarning, TypeMap } from "./backend.js";
export { BoutiquesBackend, generateBoutiques } from "./boutiques/index.js";
export { CodeBuilder } from "./code-builder.js";
export type { FieldInfo } from "./collect-field-info.js";
export { collectFieldInfo } from "./collect-field-info.js";
export type { NamedType } from "./collect-named-types.js";
export { collectNamedTypes, resolveTypeName } from "./collect-named-types.js";
export { findDoc } from "./find-doc.js";
export { findStructNode } from "./find-struct-node.js";
export { resolveFieldBinding } from "./resolve-field-binding.js";
export type {
  GuardClause,
  OutputCardinality,
  OutputEmitPlan,
  OutputGuard,
} from "./resolve-output-tokens.js";
export {
  compactTokens,
  outputCardinality,
  outputGuard,
  planOutput,
} from "./resolve-output-tokens.js";
export { Scope } from "./scope.js";
export type { JsonSchema } from "./schema/index.js";
export { generateSchema, JsonSchemaBackend } from "./schema/index.js";
export { camelCase, pascalCase, screamingSnakeCase, snakeCase } from "./string-case.js";
export { structKey, typeKey, unionKey } from "./type-keys.js";
export { generateTypeScript, TypeScriptBackend } from "./typescript/index.js";
