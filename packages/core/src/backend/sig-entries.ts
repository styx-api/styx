import type { BoundType } from "../bindings/index.js";
import type { FieldInfo } from "./collect-field-info.js";

/**
 * One entry of a kwarg-style signature, shared across language backends. Each
 * entry describes a single user-facing parameter of the `_params()` factory
 * and the kwarg wrapper:
 * - `sigType`/`sigDefault` go directly into the function signature
 * - `isOptional`/`hasExplicitDefault` drive the dict-build branches (required
 *   and explicitly-defaulted fields are always set; optional-no-default fields
 *   are conditionally set when not None/null)
 * - `doc` is rendered into the per-param doc block (Args / @param)
 */
export interface SigEntry {
  name: string;
  sigType: string;
  /** Rendered default expression in the host language, or undefined for required-no-default. */
  sigDefault?: string;
  /** True iff the BoundType is `optional` (i.e. dict-build conditionally includes). */
  isOptional: boolean;
  /** True iff the field carries an explicit defaultValue in its FieldInfo. */
  hasExplicitDefault: boolean;
  doc?: string;
}

/** Per-backend rendering hooks for `buildSigEntries`. */
export interface SigOptions {
  /** Render a non-optional BoundType as a language-native type expression. */
  renderType: (t: BoundType) => string;
  /** Suffix appended to `renderType(inner)` for optional fields (e.g. ` | None`, ` | null`). */
  nullableSuffix: string;
  /** Default expression for optional-no-default fields (e.g. `None`, `null`). */
  nullableDefault: string;
  /** Render a JS scalar default as a host-language literal (e.g. `True`/`true`). */
  renderDefault: (v: string | number | boolean) => string;
}

/**
 * Build per-field signature entries for the kwarg wrapper and params factory.
 * Skips `@type` (the factory injects it as a constant). Required-no-default
 * entries are placed before defaulted ones so the resulting signature is
 * syntactically valid in both Python and TS.
 */
export function buildSigEntries(
  rootType: Extract<BoundType, { kind: "struct" }>,
  fieldInfo: Map<string, FieldInfo>,
  opts: SigOptions,
): SigEntry[] {
  const entries: SigEntry[] = [];
  for (const [fieldName, fieldType] of Object.entries(rootType.fields)) {
    if (fieldType.kind === "literal") continue;

    const fi = fieldInfo.get(fieldName);
    const isOptional = fieldType.kind === "optional";
    const inner = isOptional ? fieldType.inner : fieldType;
    let sigType = opts.renderType(inner);
    if (isOptional) sigType += opts.nullableSuffix;

    let sigDefault: string | undefined;
    const hasExplicitDefault = fi?.defaultValue !== undefined;
    if (hasExplicitDefault) {
      sigDefault = opts.renderDefault(fi!.defaultValue!);
    } else if (isOptional) {
      sigDefault = opts.nullableDefault;
    }

    entries.push({
      name: fieldName,
      sigType,
      sigDefault,
      isOptional,
      hasExplicitDefault,
      doc: fi?.doc,
    });
  }
  const required = entries.filter((e) => e.sigDefault === undefined);
  const defaulted = entries.filter((e) => e.sigDefault !== undefined);
  return [...required, ...defaulted];
}
