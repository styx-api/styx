import type { Binding, BoundType } from "../bindings/index.js";
import type { CodegenContext } from "../manifest/index.js";
import { collectFieldInfo } from "./collect-field-info.js";

/** Renders a default value as a target-language literal. */
export type RenderLiteral = (value: string | number | boolean) => string;

/**
 * Build the field-name -> rendered-default map for a struct root (else empty).
 * Includes only non-optional defaulted fields (optional fields are
 * presence-guarded; their default comes from the factory's kwarg signature).
 *
 * `rootType` defaults to the resolved root type; callers that already have it
 * (the arg-builders) pass it to avoid re-resolving.
 */
export function collectDefaults(
  ctx: CodegenContext,
  renderLiteral: RenderLiteral,
  rootType: BoundType | undefined = ctx.resolve(ctx.expr)?.type,
): Map<string, string> {
  const out = new Map<string, string>();
  if (rootType?.kind !== "struct") return out;
  for (const [name, fi] of collectFieldInfo(ctx, rootType)) {
    if (fi.defaultValue === undefined) continue;
    if (rootType.fields[name]?.kind === "optional") continue;
    out.set(name, renderLiteral(fi.defaultValue));
  }
  return out;
}

/** The rendered default for a binding iff it is a root-level defaulted field. */
export function rootFieldDefault(
  binding: Binding | undefined,
  defaults: ReadonlyMap<string, string>,
): string | undefined {
  if (!binding) return undefined;
  const a = binding.access;
  if (a.length === 1 && a[0]?.kind === "field") return defaults.get(binding.name);
  return undefined;
}
