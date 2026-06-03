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
      // The solver has no nullable type: `optional` means "omittable" (the key
      // may be absent), never "the value may be None". Omittability is expressed
      // structurally at the field level (`typing.NotRequired[...]`); the value
      // type itself is just the inner type. So in any value position (nested
      // list/union arm, validator messages) we render the inner type with no
      // `| None`.
      return mapType(type.inner, resolve);
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

/** Render a JS default value as a Python literal (signatures, `.get(k, default)`). */
export function renderPyLiteral(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "float('nan')";
  return pyStr(value);
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

/** Options controlling how `renderAccess` renders an access path. */
export interface RenderAccessOptions {
  /**
   * Render the LAST segment - if it is a `field` - as `base.get(key)` instead of
   * `base[key]`. Used when binding the value of an optional field to a narrowed
   * local: the params factory omits optional-without-default keys entirely (they
   * are `typing.NotRequired`), so a bare subscript would raise `KeyError`. `.get()`
   * yields `None` for an absent key, matching the present-and-None case. (Unlike
   * JS, where `obj[missing]` is `undefined`, Python subscript on a missing key
   * raises - so the structurally-mirrored TS walk needs this read in Python.)
   */
  finalFieldGet?: boolean;
  /**
   * Render the LAST segment - if it is a `field` - as `base.get(key, <default>)`,
   * supplying a fallback value for an absent key. Used for fields that carry a
   * Boutiques default and are read unconditionally (e.g. an output-basename like
   * `maskfile="img_bet"`): the field is `NotRequired`, so a bare subscript would
   * raise `KeyError`, and a bare `.get()` would yield `None` (wrong - the default
   * must be substituted). The string is an already-rendered Python literal.
   * Takes precedence over `finalFieldGet`.
   */
  finalFieldDefault?: string;
  /**
   * Prefix substitutions: maps a rendered access prefix (e.g. `params["cfg"]`) to
   * a local variable name. After each segment is appended, if the rendered prefix
   * so far matches a key, it is replaced by the local. This lets reads of an
   * optional field (and anything nested under it) resolve to the `.get()`-narrowed
   * local bound by the enclosing presence guard - one lookup, absent-safe, and
   * mypy can narrow it (a re-subscript or a fresh `.get()` cannot be narrowed).
   */
  subst?: ReadonlyMap<string, string>;
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
  options: RenderAccessOptions = {},
): string {
  const { finalFieldGet = false, finalFieldDefault, subst } = options;
  let cur = "params";
  path.forEach((seg, i) => {
    if (seg.kind !== "field") {
      cur = lookupLoopVar(seg.binding);
    } else {
      const isLast = i === path.length - 1;
      if (isLast && finalFieldDefault !== undefined) {
        cur = `${cur}.get(${pyStr(seg.name)}, ${finalFieldDefault})`;
      } else if (isLast && finalFieldGet) {
        cur = `${cur}.get(${pyStr(seg.name)})`;
      } else {
        cur = `${cur}[${pyStr(seg.name)}]`;
      }
    }
    // Swap in a narrowed local if this prefix was bound by an enclosing guard.
    const sub = subst?.get(cur);
    if (sub !== undefined) cur = sub;
  });
  return cur;
}
