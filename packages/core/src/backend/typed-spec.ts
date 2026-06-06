import type { BoundType } from "../bindings/index.js";
import type { Expr, ScalarKind } from "../ir/index.js";
import type { CodegenContext } from "../manifest/index.js";
import { collectFieldInfo } from "./collect-field-info.js";
import type { OutputField, StreamField } from "./collect-output-fields.js";
import { collectOutputFields, streamFields } from "./collect-output-fields.js";
import { appModuleName, buildEmitModel, pyId } from "./python/index.js";
import { findNode, findRangeNode, findRepeatNode, structFields } from "./validate-walk.js";

/**
 * A flat, rich projection of a tool's solved tree, for Python-ecosystem
 * "declarative spec" backends (nipype, pydra) that DELEGATE EXECUTION to the
 * already-generated styx Python wrapper rather than re-implementing arg-building
 * or output-path templates.
 *
 * The model intentionally reuses the Python backend's naming (`buildEmitModel`'s
 * `sigEntries` and `computePublicNames`-derived handles): both consumers call the
 * Python wrapper by its exact scrubbed kwarg names, so deriving those names from
 * the very function that defines the wrapper signature makes a name mismatch
 * impossible by construction.
 *
 * The hard semantics (argv construction, output filename resolution) stay in the
 * Python backend; this model carries only the *types* the spec frameworks need.
 */

export type TypedParamKind =
  | "int"
  | "float"
  | "str"
  | "path"
  | "bool"
  | "count"
  | "enum"
  | "list"
  | "struct"
  | "union";

/** Lighter descriptor for a list's element type. */
export interface TypedParamItem {
  kind: TypedParamKind;
  scalarKind?: ScalarKind;
  choices?: (string | number)[];
  mediaTypes?: string[];
}

/** One user-facing parameter of the styx kwarg wrapper, with its rich type. */
export interface TypedParam {
  /** EXACT scrubbed kwarg name the styx Python wrapper exposes. */
  hostName: string;
  /** styx field (wire) name. */
  wireKey: string;
  kind: TypedParamKind;
  scalarKind?: ScalarKind;
  /** True iff the BoundType is `optional` (the key may be absent). */
  optional: boolean;
  /** True iff the field carries an explicit default value (includes flags). */
  hasDefault: boolean;
  /** Required and never defaulted: must always be supplied. */
  mandatory: boolean;
  default?: string | number | boolean;
  doc?: string;
  /** Numeric range for int/float fields. */
  range?: { min?: number; max?: number };
  /** Cardinality bounds for list fields. */
  listBounds?: { min?: number; max?: number };
  /** Allowed values for enum (union-of-literal) fields. */
  choices?: (string | number)[];
  /** Media types declared on a file (path) field. */
  mediaTypes?: string[];
  /** Element descriptor for list fields. */
  itemType?: TypedParamItem;
}

/** The delegation surface in the co-generated styx Python module. */
export interface DelegationTarget {
  /** styx Python module file stem (without extension). */
  moduleName: string;
  /** Kwarg wrapper function name (e.g. `bet`). */
  wrapperFn: string;
  /** Outputs dataclass name (e.g. `BetOutputs`). */
  outputsClass: string;
}

/** Flat, typed projection consumed by the nipype/pydra backends. */
export interface TypedSpec {
  /**
   * False when the solver collapsed the root to a non-struct (no kwarg surface).
   * Such tools cannot be wrapped by a flat kwarg spec; consumers degrade/skip.
   */
  rootIsStruct: boolean;
  params: TypedParam[];
  outputs: OutputField[];
  streams: StreamField[];
  delegation: DelegationTarget;
}

/** Project a tool's solved tree into the flat typed spec for delegation backends. */
export function buildTypedSpec(ctx: CodegenContext): TypedSpec {
  const model = buildEmitModel(ctx);
  const delegation: DelegationTarget = {
    moduleName: appModuleName(ctx.app),
    wrapperFn: model.names.wrapper,
    outputsClass: model.names.outputs,
  };
  // Output ids use the Python backend's own sanitizer so they match the
  // dataclass attributes the wrapper returns (consumers read `result.<id>`).
  const outputs = collectOutputFields(ctx, pyId);
  const streams = streamFields(ctx, pyId);

  if (!model.rootIsStruct || model.rootType.kind !== "struct") {
    return { rootIsStruct: false, params: [], outputs, streams, delegation };
  }

  const rootType = model.rootType;
  const fieldByName = new Map(structFields(ctx, rootType, ctx.expr).map((f) => [f.name, f]));
  const fieldInfo = collectFieldInfo(ctx, rootType);

  // Drive from sigEntries: it is the canonical, literal-excluded param list and
  // carries the authoritative scrubbed host names.
  const params = model.sigEntries.map((e) => {
    const fe = fieldByName.get(e.wireKey);
    const fi = fieldInfo.get(e.wireKey);
    return describeParam(e, fe?.type, fe?.node, fi?.defaultValue, fi?.doc);
  });

  return { rootIsStruct: true, params, outputs, streams, delegation };
}

interface SigLike {
  name: string;
  wireKey: string;
  isOptional: boolean;
  hasExplicitDefault: boolean;
  doc?: string;
}

function describeParam(
  e: SigLike,
  type: BoundType | undefined,
  node: Expr | undefined,
  defaultValue: string | number | boolean | undefined,
  fallbackDoc: string | undefined,
): TypedParam {
  const optional = e.isOptional;
  const hasDefault = e.hasExplicitDefault;
  const base = {
    hostName: e.name,
    wireKey: e.wireKey,
    optional,
    hasDefault,
    mandatory: !optional && !hasDefault,
    default: defaultValue,
    doc: e.doc ?? fallbackDoc,
  };
  const inner = type && type.kind === "optional" ? type.inner : type;

  const choices = inner ? literalChoices(inner, node) : undefined;
  if (choices) return { ...base, kind: "enum", choices };

  switch (inner?.kind) {
    case "scalar":
      if (inner.scalar === "path") {
        return { ...base, kind: "path", scalarKind: "path", mediaTypes: pathMediaTypes(node) };
      }
      if (inner.scalar === "int" || inner.scalar === "float") {
        return { ...base, kind: inner.scalar, scalarKind: inner.scalar, range: numericRange(node) };
      }
      return { ...base, kind: "str", scalarKind: "str" };
    case "bool":
      return { ...base, kind: "bool" };
    case "count":
      return { ...base, kind: "count" };
    case "list":
      return {
        ...base,
        kind: "list",
        listBounds: listBounds(node),
        itemType: describeItem(inner.item, node),
      };
    case "struct":
      return { ...base, kind: "struct" };
    case "union":
      return { ...base, kind: "union" };
    default:
      // Unresolved / literal / nested-optional: treat as an opaque string.
      return { ...base, kind: "str" };
  }
}

function describeItem(item: BoundType, node: Expr | undefined): TypedParamItem {
  const inner = item.kind === "optional" ? item.inner : item;
  const choices = literalChoices(inner, node);
  if (choices) return { kind: "enum", choices };
  switch (inner.kind) {
    case "scalar":
      if (inner.scalar === "path") {
        return { kind: "path", scalarKind: "path", mediaTypes: pathMediaTypes(node) };
      }
      return { kind: inner.scalar, scalarKind: inner.scalar };
    case "bool":
      return { kind: "bool" };
    case "count":
      return { kind: "count" };
    case "struct":
      return { kind: "struct" };
    case "union":
      return { kind: "union" };
    default:
      return { kind: "str" };
  }
}

/** Allowed values when `inner` is a literal or a union of literals (else undefined). */
function literalChoices(inner: BoundType, node: Expr | undefined): (string | number)[] | undefined {
  if (inner.kind === "literal") return [inner.value];
  if (
    inner.kind === "union" &&
    inner.variants.length > 0 &&
    inner.variants.every((v) => v.type.kind === "literal")
  ) {
    return inner.variants.map((v) => (v.type as Extract<BoundType, { kind: "literal" }>).value);
  }
  // Fallback: an IR alternative of literal nodes the solver did not surface as a
  // union of BoundType literals.
  const altNode = node ? findNode(node, (n) => n.kind === "alternative") : undefined;
  if (altNode && altNode.kind === "alternative") {
    const alts = altNode.attrs.alts;
    if (alts.length > 0 && alts.every((a) => a.kind === "literal")) {
      return alts.map((a) => (a as Extract<Expr, { kind: "literal" }>).attrs.str);
    }
  }
  return undefined;
}

function numericRange(node: Expr | undefined): { min?: number; max?: number } | undefined {
  const r = findRangeNode(node);
  if (!r) return undefined;
  const { minValue, maxValue } = r.attrs;
  if (minValue === undefined && maxValue === undefined) return undefined;
  return { min: minValue, max: maxValue };
}

function listBounds(node: Expr | undefined): { min?: number; max?: number } | undefined {
  const r = findRepeatNode(node);
  if (!r) return undefined;
  const { countMin, countMax } = r.attrs;
  if (countMin === undefined && countMax === undefined) return undefined;
  return { min: countMin, max: countMax };
}

function pathMediaTypes(node: Expr | undefined): string[] | undefined {
  const p = node ? findNode(node, (n) => n.kind === "path") : undefined;
  if (p && p.kind === "path") {
    const mt = p.attrs.mediaTypes;
    if (mt && mt.length > 0) return mt;
  }
  return undefined;
}
