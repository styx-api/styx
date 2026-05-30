import type { AccessPath, BindingId, BoundType } from "../../bindings/index.js";

/**
 * Map a BoundType to its Python type expression.
 *
 * `resolve` is the named-type resolver from `collectNamedTypes` - returns the
 * declared name for struct/union types so they can be referenced symbolically
 * rather than inlined.
 *
 * Python target: 3.10+ (uses `X | None`, `list[T]`, `int`/`str`/etc.).
 */
export function mapType(type: BoundType, resolve: (type: BoundType) => string | undefined): string {
  switch (type.kind) {
    case "scalar":
      return { int: "int", float: "float", str: "str", path: "InputPathType" }[type.scalar];
    case "bool":
      return "bool";
    case "count":
      return "int";
    case "literal":
      return typeof type.value === "string"
        ? `typing.Literal[${pyStr(type.value)}]`
        : `typing.Literal[${type.value}]`;
    case "optional":
      return `${mapType(type.inner, resolve)} | None`;
    case "list":
      return `list[${mapType(type.item, resolve)}]`;
    case "struct": {
      const name = resolve(type);
      if (name) return name;
      // Fallback: inline as Mapping[str, object]. Real struct types should always
      // resolve to a declared TypedDict.
      return "typing.Mapping[str, object]";
    }
    case "union": {
      const name = resolve(type);
      if (name) return name;
      return type.variants.map((v) => mapType(v.type, resolve)).join(" | ");
    }
  }
}

/** Python double-quoted string literal with minimal escaping. */
export function pyStr(value: string): string {
  // For any value containing control characters, JSON encoding produces a valid
  // Python double-quoted literal (with the same `\n`/`\t`/`\uXXXX` escapes).
  // Otherwise we hand-escape backslashes and double quotes only.
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return JSON.stringify(value);
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render a solver-assigned `AccessPath` to a Python expression. Starts from
 * `params`; each `field` segment subscripts a key, and each `iter` segment
 * resets the base to the loop variable bound to that repeat binding (resolved
 * via `lookupLoopVar`). Mirrors the TypeScript `renderAccess`.
 */
export function renderAccess(
  path: AccessPath,
  lookupLoopVar: (binding: BindingId) => string,
): string {
  let cur = "params";
  for (const seg of path) {
    cur = seg.kind === "field" ? `${cur}[${pyStr(seg.name)}]` : lookupLoopVar(seg.binding);
  }
  return cur;
}
