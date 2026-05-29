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
import { emitJsDoc, tsPropAccess } from "./emit.js";
import { mapType } from "./typemap.js";

/**
 * Emit a `<tool>Validate(params)` function that walks the solved root
 * `BoundType` and throws `StyxValidationError` on invalid input. Hand-rolled
 * (no runtime deps): `typeof`/`Array.isArray` stand in for Python's
 * `isinstance`. Mirrors the Python backend's validation behavior, inlined into
 * a single function.
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
  emitJsDoc(cb, "Validate the parameters. Throws StyxValidationError if the parameters are invalid.");
  cb.line(`export function ${funcName}(params: ${paramsType}): void {`);
  cb.indent(() => emitRoot(e, rootType, rootNode));
  cb.line("}");
}

function emitRoot(e: Emit, rootType: BoundType, rootNode: Expr): void {
  if (rootType.kind === "struct") {
    block(e, `typeof params !== "object" || params === null`, () =>
      raise(e, "Params object has the wrong type"),
    );
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
  if (fieldType.kind === "literal") return;

  const access = tsPropAccess(base, name);
  const expected = expectedType(e, fieldType);
  const valueType = fieldType.kind === "optional" ? fieldType.inner : fieldType;

  // Optionals and defaulted fields/flags accept null (null = "use default"), so
  // gate the body instead of requiring presence.
  if (fieldType.kind === "optional" || hasDefault) {
    e.cb.line(`if (${access} != null) {`);
    e.cb.indent(() => emitValue(e, valueType, node, name, access, expected));
    e.cb.line("}");
  } else {
    block(e, `${access} == null`, () => raise(e, "`" + name + "` must not be null"));
    emitValue(e, valueType, node, name, access, expected);
  }
}

/** Validate a known-present value at `access` against `type`. */
function emitValue(
  e: Emit,
  type: BoundType,
  node: Expr | undefined,
  wireKey: string,
  access: string,
  expected: string,
): void {
  switch (type.kind) {
    case "optional":
      emitValue(e, type.inner, node, wireKey, access, expected);
      return;
    case "literal":
      return;
    case "scalar":
      switch (type.scalar) {
        case "str":
        case "path":
          checkType(e, `typeof ${access} !== "string"`, wireKey, expected);
          return;
        case "int":
        case "float":
          checkType(e, `typeof ${access} !== "number"`, wireKey, expected);
          emitRange(e, node, wireKey, access);
          return;
      }
      return;
    case "bool":
      checkType(e, `typeof ${access} !== "boolean"`, wireKey, expected);
      return;
    case "count":
      checkType(e, `typeof ${access} !== "number"`, wireKey, expected);
      return;
    case "list": {
      checkType(e, `!Array.isArray(${access})`, wireKey, expected);
      emitListLength(e, node, wireKey, access);
      const itemNode = findRepeatNode(node)?.attrs.node;
      const elem = e.scope.add("el");
      e.cb.line(`for (const ${elem} of ${access}) {`);
      e.cb.indent(() => emitValue(e, type.item, itemNode, wireKey, elem, expected));
      e.cb.line("}");
      return;
    }
    case "struct": {
      block(e, `typeof ${access} !== "object" || ${access} === null`, () =>
        raise(e, "Params object has the wrong type"),
      );
      for (const f of structFields(e.ctx, type, node)) {
        emitField(e, f.name, f.type, f.node, f.hasDefault, access);
      }
      return;
    }
    case "union":
      emitUnion(e, type, node, wireKey, access);
      return;
  }
}

function emitUnion(
  e: Emit,
  unionType: Extract<BoundType, { kind: "union" }>,
  node: Expr | undefined,
  wireKey: string,
  access: string,
): void {
  // All-literal variants are an enum/choice (no `@type` discriminator).
  if (unionType.variants.every((v) => v.type.kind === "literal")) {
    const values = unionType.variants.map(
      (v) => (v.type as Extract<BoundType, { kind: "literal" }>).value,
    );
    const allStr = values.every((x) => typeof x === "string");
    checkType(e, `typeof ${access} !== ${allStr ? '"string"' : '"number"'}`, wireKey, expectedType(e, unionType));
    const rendered = values.map(renderLiteral);
    // `.includes` (not a `!==`-chain): the value is typed as a closed literal
    // union, and TS flags an exhaustive `!==`-chain as TS2367 (always false).
    block(e, `![${rendered.join(", ")}].includes(${access})`, () =>
      raise(e, "Parameter `" + wireKey + "` must be one of [" + rendered.join(", ") + "]"),
    );
    return;
  }

  block(e, `typeof ${access} !== "object" || ${access} === null`, () =>
    raise(e, "Params object has the wrong type"),
  );
  block(e, `!("@type" in ${access})`, () => raise(e, "Params object is missing `@type`"));

  const names = unionType.variants
    .map((v) => v.name)
    .filter((n): n is string => n !== undefined);
  const rendered = names.map((n) => JSON.stringify(n));
  // `.includes` rather than a `!==`-chain: the discriminant is a closed literal
  // union and an exhaustive chain is rejected by TS as TS2367. `.includes` also
  // leaves the union un-narrowed, so the per-variant dispatch below narrows it.
  block(e, `![${rendered.join(", ")}].includes(${access}["@type"])`, () =>
    raise(e, "Parameter `" + wireKey + "`s `@type` must be one of [" + rendered.join(", ") + "]"),
  );

  // Dispatch with `switch` (mirroring the cargs builder): a `switch` narrows
  // each `case` correctly, whereas an `if`/`else if` chain on `===` accumulates
  // narrowing and TS rejects later arms. The `.includes` membership check above
  // already throws on an unknown `@type`, so no `default` arm is needed.
  const altNode = findAlternativeNode(node);
  e.cb.line(`switch (${access}["@type"]) {`);
  e.cb.indent(() => {
    unionType.variants.forEach((variant, i) => {
      e.cb.line(`case ${JSON.stringify(variant.name ?? "")}: {`);
      e.cb.indent(() => {
        const variantType = variant.type;
        if (variantType.kind === "struct") {
          const fields = structFields(e.ctx, variantType, altNode?.attrs.alts[i]).filter(
            (f) => f.type.kind !== "literal",
          );
          for (const f of fields) emitField(e, f.name, f.type, f.node, f.hasDefault, access);
        }
        e.cb.line("break;");
      });
      e.cb.line("}");
    });
  });
  e.cb.line("}");
}

function checkType(e: Emit, condition: string, wireKey: string, expected: string): void {
  block(e, condition, () =>
    raise(e, "`" + wireKey + "` has the wrong type (expected " + expected + ")"),
  );
}

function emitRange(e: Emit, node: Expr | undefined, wireKey: string, access: string): void {
  const term = findRangeNode(node);
  if (!term) return;
  const { minValue, maxValue } = term.attrs;
  if (minValue !== undefined && maxValue !== undefined) {
    block(e, `!(${tsNum(minValue)} <= ${access} && ${access} <= ${tsNum(maxValue)})`, () =>
      raise(e, `Parameter \`${wireKey}\` must be between ${minValue} and ${maxValue} (inclusive)`),
    );
  } else if (minValue !== undefined) {
    block(e, `${access} < ${tsNum(minValue)}`, () =>
      raise(e, `Parameter \`${wireKey}\` must be at least ${minValue}`),
    );
  } else if (maxValue !== undefined) {
    block(e, `${access} > ${tsNum(maxValue)}`, () =>
      raise(e, `Parameter \`${wireKey}\` must be at most ${maxValue}`),
    );
  }
}

function emitListLength(e: Emit, node: Expr | undefined, wireKey: string, access: string): void {
  const rep = findRepeatNode(node);
  if (!rep) return;
  const { countMin, countMax } = rep.attrs;
  if (countMin !== undefined && countMax !== undefined) {
    block(e, `!(${countMin} <= ${access}.length && ${access}.length <= ${countMax})`, () =>
      raise(
        e,
        `Parameter \`${wireKey}\` must contain between ${countMin} and ${countMax} elements (inclusive)`,
      ),
    );
  } else if (countMin !== undefined) {
    block(e, `${access}.length < ${countMin}`, () =>
      raise(e, `Parameter \`${wireKey}\` must contain at least ${countMin} ${plural("element", countMin)}`),
    );
  } else if (countMax !== undefined) {
    block(e, `${access}.length > ${countMax}`, () =>
      raise(e, `Parameter \`${wireKey}\` must contain at most ${countMax} ${plural("element", countMax)}`),
    );
  }
}

// -- Emit helpers --

/** Emit `if (<cond>) { <body> }`. */
function block(e: Emit, condition: string, body: () => void): void {
  e.cb.line(`if (${condition}) {`);
  e.cb.indent(body);
  e.cb.line("}");
}

function raise(e: Emit, message: string): void {
  e.cb.line(`throw new StyxValidationError(${JSON.stringify(message)});`);
}

function expectedType(e: Emit, type: BoundType): string {
  return mapType(type, e.resolve);
}

function renderLiteral(value: string | number): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function tsNum(n: number): string {
  return Number.isFinite(n) ? String(n) : "NaN";
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
