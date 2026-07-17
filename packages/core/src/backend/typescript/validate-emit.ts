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
  emitJsDoc(
    cb,
    `Validate untrusted parameters. Throws StyxValidationError if \`params\` is not a valid ${paramsType}; narrows it to ${paramsType} on success.`,
  );
  // Assertion signature over untyped input: a boundary guard usable on a parsed
  // dict / config blob, not just an already-typed value. The body walks `params`
  // dynamically, so the parameter is `any` (the assertion still narrows callers).
  cb.line(`export function ${funcName}(params: any): asserts params is ${paramsType} {`);
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
      // Report the element type (e.g. `int`), not the list type (`int[]`).
      e.cb.indent(() =>
        emitValue(e, type.item, itemNode, wireKey, elem, expectedType(e, type.item)),
      );
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
  const litVariants = unionType.variants.filter((v) => v.type.kind === "literal");
  const hasStruct = unionType.variants.some((v) => v.type.kind === "struct");

  // Pure enum/choice: no struct variants, just literal values (no `@type`).
  if (!hasStruct) {
    const values = litVariants.map(
      (v) => (v.type as Extract<BoundType, { kind: "literal" }>).value,
    );
    const allStr = values.every((x) => typeof x === "string");
    checkType(
      e,
      `typeof ${access} !== ${allStr ? '"string"' : '"number"'}`,
      wireKey,
      expectedType(e, unionType),
    );
    emitLiteralMembership(e, values, wireKey, access);
    return;
  }

  const altNode = findAlternativeNode(node);
  // Struct variants with their indices; throws if two share an `@type` (a
  // duplicate-tagged variant is unreachable and a mypy `comparison-overlap` in
  // the Python mirror - frontends must dodge duplicate tags before codegen).
  // The index keeps each arm aligned with the IR `alts`.
  const structVars = structVariants(unionType);
  const emitStructArm = (): void => {
    // `access` is known to be an object here.
    block(e, `!("@type" in ${access})`, () => raise(e, "Params object is missing `@type`"));
    const names = structVars
      .map(({ variant }) => variant.name)
      .filter((n): n is string => n !== undefined)
      .map((n) => JSON.stringify(n));
    // `.includes` rather than a `!==`-chain: the discriminant is a closed literal
    // union and an exhaustive chain is rejected by TS as TS2367. It also leaves
    // the union un-narrowed, so the `switch` dispatch below narrows it.
    block(e, `![${names.join(", ")}].includes(${access}["@type"])`, () =>
      raise(e, "Parameter `" + wireKey + "`s `@type` must be one of [" + names.join(", ") + "]"),
    );
    // `switch` (mirroring the cargs builder): each `case` narrows correctly,
    // whereas an `if`/`else if` chain on `===` accumulates narrowing and TS
    // rejects later arms.
    e.cb.line(`switch (${access}["@type"]) {`);
    e.cb.indent(() => {
      structVars.forEach(({ variant, i }) => {
        const vt = variant.type as Extract<BoundType, { kind: "struct" }>;
        e.cb.line(`case ${JSON.stringify(variant.name ?? "")}: {`);
        e.cb.indent(() => {
          const fields = structFields(e.ctx, vt, altNode?.attrs.alts[i]).filter(
            (f) => f.type.kind !== "literal",
          );
          for (const f of fields) emitField(e, f.name, f.type, f.node, f.hasDefault, access);
          e.cb.line("break;");
        });
        e.cb.line("}");
      });
    });
    e.cb.line("}");
  };

  // Pure discriminated union: every variant is a struct with an `@type`.
  if (litVariants.length === 0) {
    block(e, `typeof ${access} !== "object" || ${access} === null`, () =>
      raise(e, "Params object has the wrong type"),
    );
    emitStructArm();
    return;
  }

  // Mixed union: a value is either a struct (dict with `@type`) or a bare
  // literal. Branch on the runtime shape - `typeof === "object"` narrows to the
  // struct members, the `else` to the literal members.
  e.cb.line(`if (typeof ${access} === "object" && ${access} !== null) {`);
  e.cb.indent(emitStructArm);
  e.cb.line(`} else {`);
  e.cb.indent(() => {
    const values = litVariants.map(
      (v) => (v.type as Extract<BoundType, { kind: "literal" }>).value,
    );
    emitLiteralMembership(e, values, wireKey, access);
  });
  e.cb.line("}");
}

/** Emit a `.includes`-based membership check over literal values. */
function emitLiteralMembership(
  e: Emit,
  values: (string | number)[],
  wireKey: string,
  access: string,
): void {
  const rendered = values.map(renderLiteral);
  block(e, `![${rendered.join(", ")}].includes(${access})`, () =>
    raise(e, "Parameter `" + wireKey + "` must be one of [" + rendered.join(", ") + "]"),
  );
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
      raise(
        e,
        `Parameter \`${wireKey}\` must contain at least ${countMin} ${plural("element", countMin)}`,
      ),
    );
  } else if (countMax !== undefined) {
    block(e, `${access}.length > ${countMax}`, () =>
      raise(
        e,
        `Parameter \`${wireKey}\` must contain at most ${countMax} ${plural("element", countMax)}`,
      ),
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
