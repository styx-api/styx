import type { BoundType } from "../../bindings/index.js";

// A valid TS identifier can be an unquoted object key; anything else (e.g. a
// wire key like `4d_input`) must be quoted. Kept local to avoid a cycle with
// emit.ts (which imports this module).
const TS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function objKey(key: string): string {
  return TS_IDENT_RE.test(key) ? key : JSON.stringify(key);
}

export function mapType(type: BoundType, resolve: (type: BoundType) => string | undefined): string {
  switch (type.kind) {
    case "scalar":
      return { int: "number", float: "number", str: "string", path: "InputPathType" }[type.scalar];
    case "bool":
      return "boolean";
    case "count":
      return "number";
    case "literal":
      return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value);
    case "optional":
      // The solver has no nullable type: `optional` means "omittable" (the key
      // may be absent), never "the value may be null". Omittability is expressed
      // structurally at the field level (`?:` on the interface key, NotRequired
      // in Python); the value type itself is just the inner type. So in any
      // value position (nested list/union arm, validator messages) we render the
      // inner type with no `| null | undefined`.
      return mapType(type.inner, resolve);
    case "list": {
      const inner = mapType(type.item, resolve);
      return inner.includes("|") ? `Array<${inner}>` : `${inner}[]`;
    }
    case "struct": {
      const name = resolve(type);
      if (name) return name;
      const fields = Object.entries(type.fields)
        .filter(([, v]) => v.kind !== "literal")
        .map(([k, v]) => `${objKey(k)}: ${mapType(v, resolve)}`)
        .join("; ");
      return `{ ${fields} }`;
    }
    case "union": {
      const name = resolve(type);
      if (name) return name;
      return type.variants.map((v) => mapType(v.type, resolve)).join(" | ");
    }
  }
}

/** Render a JS default value as a TypeScript literal (signatures, `?? default`). */
export function renderTsLiteral(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NaN";
  return JSON.stringify(value);
}
