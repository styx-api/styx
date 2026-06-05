import type { BoundType } from "../bindings/index.js";

/**
 * Per-language rendering hooks for the call-site snippet renderer. The recursive
 * structure (struct -> object literal, union -> picked variant, list -> array)
 * is language-agnostic; only leaf-literal syntax, object keys, and indentation
 * differ, and those are supplied here.
 */
export interface SnippetDialect {
  /** One indentation level (e.g. `"    "` for Python, `"  "` for TypeScript). */
  indentUnit: string;
  /** Render a string value as a host literal (quoted). */
  string(value: string): string;
  /** Render a boolean value as a host literal (`True`/`true`). */
  boolean(value: boolean): string;
  /** Render a number value as a host literal. */
  number(value: number): string;
  /** Host literal for a null/None value. */
  null: string;
  /** Render an object-literal key from a wire key, quoting when not a bare identifier. */
  objKey(wireKey: string): string;
}

/** Options shared by both language renderers. */
export interface SnippetOptions {
  /**
   * Module the package is imported from (e.g. `"niwrap"`). Defaults to the
   * project name on the context. When unset and no project name is available,
   * Python falls back to a bare `import <pkg>` and TypeScript omits the import.
   */
  packageRoot?: string;
  /** Whether to prepend an import line. Defaults to `true`. */
  includeImport?: boolean;
}

/** Is `value` a plain (non-array) object usable as a struct/union config? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip transparent `optional` wrappers down to the underlying value type. */
function unwrap(type: BoundType): BoundType {
  return type.kind === "optional" ? unwrap(type.inner) : type;
}

/** Render a leaf primitive (string/number/bool/null) by its JS runtime type. */
function renderPrimitive(value: unknown, d: SnippetDialect): string {
  if (value === null || value === undefined) return d.null;
  switch (typeof value) {
    case "string":
      return d.string(value);
    case "boolean":
      return d.boolean(value);
    case "number":
      return d.number(value);
    default:
      // Bigint / unexpected: fall back to a quoted string form.
      return d.string(String(value));
  }
}

/** The `@type` discriminator value carried by a struct type, if any. */
function structAtType(type: Extract<BoundType, { kind: "struct" }>): string | undefined {
  const field = type.fields["@type"];
  return field && field.kind === "literal" ? String(field.value) : undefined;
}

/**
 * Render a struct config as a host object literal (Python dict / TS object).
 * Keys are the Boutiques wire names (the generated TypedDict / interface keys) -
 * nested structs have no constructor function in the generated code, so callers
 * build them as plain object literals.
 *
 * `@type` is emitted from the struct's literal discriminator field when present
 * (union variants carry a required, load-bearing `@type`); for the root call the
 * tag is injected via `injectAtType` (the root's `@type` is derived from
 * `pkg/appId`, not stored as a field). Non-`@type` literal fields have no
 * runtime representation and are skipped.
 */
export function renderStructLiteral(
  value: unknown,
  type: Extract<BoundType, { kind: "struct" }>,
  indent: string,
  d: SnippetDialect,
  injectAtType?: string,
): string {
  const obj = isRecord(value) ? value : {};
  const inner = indent + d.indentUnit;
  const lines: string[] = [];

  const atType = structAtType(type) ?? injectAtType;
  if (atType !== undefined) {
    lines.push(`${inner}${d.objKey("@type")}: ${d.string(atType)},`);
  }

  for (const [wireKey, fieldType] of Object.entries(type.fields)) {
    if (wireKey === "@type") continue;
    if (fieldType.kind === "literal") continue; // no runtime representation
    if (!(wireKey in obj)) continue; // omitted optional / absent field
    lines.push(`${inner}${d.objKey(wireKey)}: ${renderValue(obj[wireKey], fieldType, inner, d)},`);
  }

  if (lines.length === 0) return "{}";
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/**
 * Render a union config. An object value with an `@type` is matched to the
 * struct variant whose discriminator equals that tag and rendered as that
 * variant's object literal; a primitive value (a bare literal/scalar variant,
 * e.g. a mixed union's `"Linear"` const arm) is rendered directly.
 */
function renderUnion(
  value: unknown,
  type: Extract<BoundType, { kind: "union" }>,
  indent: string,
  d: SnippetDialect,
): string {
  if (isRecord(value)) {
    const tag = value["@type"];
    const match = type.variants.find(
      (v) => v.type.kind === "struct" && structAtType(v.type) === String(tag),
    );
    if (match && match.type.kind === "struct") {
      return renderStructLiteral(value, match.type, indent, d);
    }
    // Unknown/missing tag: fall back to the sole struct variant if there is one,
    // otherwise emit an empty object. (Well-formed configs always match.)
    const onlyStruct = type.variants.filter((v) => v.type.kind === "struct");
    if (onlyStruct.length === 1 && onlyStruct[0]!.type.kind === "struct") {
      return renderStructLiteral(value, onlyStruct[0]!.type, indent, d);
    }
    return "{}";
  }
  return renderPrimitive(value, d);
}

/**
 * Render a list config. A list of structs/unions renders multi-line (one object
 * literal per element); a list of primitives renders inline (`[1, 2, 3]`).
 */
function renderList(value: unknown, item: BoundType, indent: string, d: SnippetDialect): string {
  if (!Array.isArray(value) || value.length === 0) return "[]";
  const it = unwrap(item);
  if (it.kind === "struct" || it.kind === "union") {
    const inner = indent + d.indentUnit;
    const elems = value.map((el) => `${inner}${renderValue(el, it, inner, d)},`);
    return `[\n${elems.join("\n")}\n${indent}]`;
  }
  return `[${value.map((el) => renderValue(el, it, indent, d)).join(", ")}]`;
}

/**
 * Render a config value to a host-language expression, guided by its BoundType.
 *
 * `indent` is the leading whitespace of the line the value starts on; multi-line
 * forms (object/array literals) place their members one level deeper and close
 * back at `indent`. The renderer follows the BoundType tree for shape and reads
 * the parallel config object for values, so unknown / absent keys are simply
 * omitted (a partial config produces a partial snippet).
 */
export function renderValue(
  value: unknown,
  type: BoundType,
  indent: string,
  d: SnippetDialect,
): string {
  const t = unwrap(type);
  switch (t.kind) {
    case "struct":
      return renderStructLiteral(value, t, indent, d);
    case "union":
      return renderUnion(value, t, indent, d);
    case "list":
      return renderList(value, t.item, indent, d);
    default:
      return renderPrimitive(value, d);
  }
}
