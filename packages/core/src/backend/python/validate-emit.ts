import type { BoundType } from "../../bindings/index.js";
import type { Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import type { CodeBuilder } from "../code-builder.js";
import type { Scope } from "../scope.js";
import {
  findAlternativeNode,
  findRangeNode,
  findRepeatNode,
  structFields,
} from "../validate-walk.js";
import { structVariants } from "../union-variants.js";
import { emitDocstring } from "./emit.js";
import { mapType, pyStr } from "./typemap.js";

/**
 * Emit a `<tool>_validate(params)` function that walks the solved root
 * `BoundType` and raises `StyxValidationError` on invalid input. Mirrors the
 * runtime validation v1 niwrap emits, but as a single inlined function (the v2
 * backends inline `_cargs`/`_outputs` too, rather than v1's per-struct
 * dispatch).
 *
 * Constraints checked: presence (required fields), `isinstance`, int/float
 * range, list length, union `@type` membership + per-variant recursion, and
 * nested struct recursion.
 */

type Resolve = (t: BoundType) => string | undefined;

interface Emit {
  ctx: CodegenContext;
  resolve: Resolve;
  /** Per-function scope for generated locals (loop vars), reserving `params`. */
  scope: Scope;
  cb: CodeBuilder;
}

export function emitValidate(
  ctx: CodegenContext,
  rootType: BoundType,
  rootNode: Expr,
  paramsType: string,
  funcName: string,
  resolve: Resolve,
  scope: Scope,
  cb: CodeBuilder,
): void {
  const e: Emit = { ctx, resolve, scope: scope.child(["params"]), cb };
  cb.line(`def ${funcName}(params: ${paramsType}) -> None:`);
  cb.indent(() => {
    emitDocstring(
      cb,
      "Validate parameters. Raises StyxValidationError if the parameters are invalid.",
    );
    emitRoot(e, rootType, rootNode);
  });
}

function emitRoot(e: Emit, rootType: BoundType, rootNode: Expr): void {
  if (rootType.kind === "struct") {
    e.cb.line("if params is None or not isinstance(params, dict):");
    e.cb.indent(() => raise(e, wrongObjectTypeMsg("params")));
    for (const f of structFields(e.ctx, rootType, rootNode)) {
      emitField(e, f.name, f.type, f.node, f.hasDefault, "params");
    }
  } else if (rootType.kind === "union") {
    emitUnion(e, rootType, rootNode, "params", "params");
  } else {
    emitValue(e, rootType, rootNode, "params", "params", expectedType(e, rootType));
  }
}

/** Validate one struct field, handling required-presence vs optional gating. */
function emitField(
  e: Emit,
  name: string,
  fieldType: BoundType,
  node: Expr | undefined,
  hasDefault: boolean,
  base: string,
): void {
  // `@type` and other fixed literals have no user-supplied runtime value.
  if (fieldType.kind === "literal") return;

  const getExpr = `${base}.get(${pyStr(name)}, None)`;
  const idxExpr = `${base}[${pyStr(name)}]`;
  const expected = expectedType(e, fieldType);
  const valueType = fieldType.kind === "optional" ? fieldType.inner : fieldType;

  // Optionals and defaulted fields/flags accept None (None = "use default"), so
  // gate the body instead of requiring presence.
  if (fieldType.kind === "optional" || hasDefault) {
    e.cb.line(`if ${getExpr} is not None:`);
    e.cb.indent(() => emitValue(e, valueType, node, name, idxExpr, expected));
  } else {
    e.cb.line(`if ${getExpr} is None:`);
    e.cb.indent(() => raise(e, str("`" + name + "` must not be None")));
    emitValue(e, valueType, node, name, idxExpr, expected);
  }
}

/** Validate a known-non-null value at `valueExpr` against `type`. */
function emitValue(
  e: Emit,
  type: BoundType,
  node: Expr | undefined,
  wireKey: string,
  valueExpr: string,
  expected: string,
): void {
  switch (type.kind) {
    case "optional":
      emitValue(e, type.inner, node, wireKey, valueExpr, expected);
      return;
    case "literal":
      return;
    case "scalar":
      switch (type.scalar) {
        case "str":
          checkType(e, valueExpr, "str", wireKey, expected);
          return;
        case "int":
          checkType(e, valueExpr, "int", wireKey, expected);
          emitRange(e, node, wireKey, valueExpr);
          return;
        case "float":
          checkType(e, valueExpr, "(float, int)", wireKey, expected);
          emitRange(e, node, wireKey, valueExpr);
          return;
        case "path":
          checkType(e, valueExpr, "(pathlib.Path, str)", wireKey, expected);
          return;
      }
      return;
    case "bool":
      checkType(e, valueExpr, "bool", wireKey, expected);
      return;
    case "count":
      checkType(e, valueExpr, "int", wireKey, expected);
      return;
    case "list": {
      checkType(e, valueExpr, "list", wireKey, expected);
      emitListLength(e, node, wireKey, valueExpr);
      const itemNode = findRepeatNode(node)?.attrs.node;
      const elem = e.scope.add("e");
      e.cb.line(`for ${elem} in ${valueExpr}:`);
      e.cb.indent(() => emitValue(e, type.item, itemNode, wireKey, elem, expected));
      return;
    }
    case "struct": {
      e.cb.line(`if not isinstance(${valueExpr}, dict):`);
      e.cb.indent(() => raise(e, wrongObjectTypeMsg(valueExpr)));
      for (const f of structFields(e.ctx, type, node)) {
        emitField(e, f.name, f.type, f.node, f.hasDefault, valueExpr);
      }
      return;
    }
    case "union":
      emitUnion(e, type, node, wireKey, valueExpr);
      return;
  }
}

function emitUnion(
  e: Emit,
  unionType: Extract<BoundType, { kind: "union" }>,
  node: Expr | undefined,
  wireKey: string,
  valueExpr: string,
): void {
  const litVariants = unionType.variants.filter((v) => v.type.kind === "literal");
  const hasStruct = unionType.variants.some((v) => v.type.kind === "struct");

  // Pure enum/choice: no struct variants, just literal values (no `@type`).
  if (!hasStruct) {
    const values = litVariants.map(
      (v) => (v.type as Extract<BoundType, { kind: "literal" }>).value,
    );
    const allStr = values.every((x) => typeof x === "string");
    checkType(e, valueExpr, allStr ? "str" : "(float, int)", wireKey, expectedType(e, unionType));
    emitLiteralMembership(e, values, wireKey, valueExpr);
    return;
  }

  const altNode = findAlternativeNode(node);
  // Struct variants with their indices; throws if two share an `@type` (a
  // duplicate-tagged variant is unreachable and a mypy `comparison-overlap` -
  // frontends must dodge duplicate tags before codegen). The index keeps each
  // arm aligned with the IR `alts`.
  const structVars = structVariants(unionType);
  const emitStructArm = (): void => {
    // `valueExpr` is known to be a dict here.
    e.cb.line(`if "@type" not in ${valueExpr}:`);
    e.cb.indent(() => raise(e, str("Params object is missing `@type`")));
    const names = structVars
      .map(({ variant }) => variant.name)
      .filter((n): n is string => n !== undefined)
      .map((n) => pyStr(n))
      .join(", ");
    e.cb.line(`if ${valueExpr}["@type"] not in [${names}]:`);
    e.cb.indent(() =>
      raise(e, str("Parameter `" + wireKey + "`s `@type` must be one of [" + names + "]")),
    );
    structVars.forEach(({ variant, i }, k) => {
      const vt = variant.type as Extract<BoundType, { kind: "struct" }>;
      const keyword = k === 0 ? "if" : "elif";
      e.cb.line(`${keyword} ${valueExpr}["@type"] == ${pyStr(variant.name ?? "")}:`);
      e.cb.indent(() => {
        const fields = structFields(e.ctx, vt, altNode?.attrs.alts[i]).filter(
          (f) => f.type.kind !== "literal",
        );
        if (fields.length === 0) {
          e.cb.line("pass");
        } else {
          for (const f of fields) emitField(e, f.name, f.type, f.node, f.hasDefault, valueExpr);
        }
      });
    });
  };

  // Pure discriminated union: every variant is a struct with an `@type`.
  if (litVariants.length === 0) {
    e.cb.line(`if not isinstance(${valueExpr}, dict):`);
    e.cb.indent(() => raise(e, wrongObjectTypeMsg(valueExpr)));
    emitStructArm();
    return;
  }

  // Mixed union: a value is either a struct (dict with `@type`) or a bare
  // literal. Branch on the runtime shape.
  e.cb.line(`if isinstance(${valueExpr}, dict):`);
  e.cb.indent(emitStructArm);
  e.cb.line("else:");
  e.cb.indent(() => {
    const values = litVariants.map(
      (v) => (v.type as Extract<BoundType, { kind: "literal" }>).value,
    );
    emitLiteralMembership(e, values, wireKey, valueExpr);
  });
}

/** Emit a `not in [...]` membership check over literal values. */
function emitLiteralMembership(
  e: Emit,
  values: (string | number)[],
  wireKey: string,
  valueExpr: string,
): void {
  const rendered = values.map((x) => (typeof x === "string" ? pyStr(x) : pyNum(x))).join(", ");
  e.cb.line(`if ${valueExpr} not in [${rendered}]:`);
  e.cb.indent(() => raise(e, str("Parameter `" + wireKey + "` must be one of [" + rendered + "]")));
}

function checkType(
  e: Emit,
  valueExpr: string,
  pyType: string,
  wireKey: string,
  expected: string,
): void {
  e.cb.line(`if not isinstance(${valueExpr}, ${pyType}):`);
  e.cb.indent(() => raise(e, wrongTypeMsg(wireKey, valueExpr, expected)));
}

function emitRange(e: Emit, node: Expr | undefined, wireKey: string, valueExpr: string): void {
  const term = findRangeNode(node);
  if (!term) return;
  const { minValue, maxValue } = term.attrs;
  if (minValue !== undefined && maxValue !== undefined) {
    e.cb.line(`if not (${pyNum(minValue)} <= ${valueExpr} <= ${pyNum(maxValue)}):`);
    e.cb.indent(() =>
      raise(
        e,
        str(`Parameter \`${wireKey}\` must be between ${minValue} and ${maxValue} (inclusive)`),
      ),
    );
  } else if (minValue !== undefined) {
    e.cb.line(`if ${valueExpr} < ${pyNum(minValue)}:`);
    e.cb.indent(() => raise(e, str(`Parameter \`${wireKey}\` must be at least ${minValue}`)));
  } else if (maxValue !== undefined) {
    e.cb.line(`if ${valueExpr} > ${pyNum(maxValue)}:`);
    e.cb.indent(() => raise(e, str(`Parameter \`${wireKey}\` must be at most ${maxValue}`)));
  }
}

function emitListLength(e: Emit, node: Expr | undefined, wireKey: string, valueExpr: string): void {
  const rep = findRepeatNode(node);
  if (!rep) return;
  const { countMin, countMax } = rep.attrs;
  if (countMin !== undefined && countMax !== undefined) {
    e.cb.line(`if not (${countMin} <= len(${valueExpr}) <= ${countMax}):`);
    e.cb.indent(() =>
      raise(
        e,
        str(
          `Parameter \`${wireKey}\` must contain between ${countMin} and ${countMax} elements (inclusive)`,
        ),
      ),
    );
  } else if (countMin !== undefined) {
    e.cb.line(`if len(${valueExpr}) < ${countMin}:`);
    e.cb.indent(() =>
      raise(
        e,
        str(
          `Parameter \`${wireKey}\` must contain at least ${countMin} ${plural("element", countMin)}`,
        ),
      ),
    );
  } else if (countMax !== undefined) {
    e.cb.line(`if len(${valueExpr}) > ${countMax}:`);
    e.cb.indent(() =>
      raise(
        e,
        str(
          `Parameter \`${wireKey}\` must contain at most ${countMax} ${plural("element", countMax)}`,
        ),
      ),
    );
  }
}

// -- Message + literal rendering --

function raise(e: Emit, messageExpr: string): void {
  e.cb.line(`raise StyxValidationError(${messageExpr})`);
}

/** A plain double-quoted Python string message. */
function str(text: string): string {
  return pyStr(text);
}

/** A single-quoted f-string "wrong type" message referencing the runtime type. */
function wrongTypeMsg(wireKey: string, valueExpr: string, expected: string): string {
  return `f'\`${wireKey}\` has the wrong type: Received \`{type(${valueExpr})}\` expected \`${expected}\`'`;
}

/** The generic "Params object has the wrong type" f-string message. */
function wrongObjectTypeMsg(valueExpr: string): string {
  return `f'Params object has the wrong type \\'{type(${valueExpr})}\\''`;
}

function expectedType(e: Emit, type: BoundType): string {
  return mapType(type, e.resolve);
}

function pyNum(n: number): string {
  return Number.isFinite(n) ? String(n) : "float('nan')";
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
