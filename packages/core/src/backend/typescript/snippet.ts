import type { CodegenContext } from "../../manifest/index.js";
import type { SnippetDialect, SnippetOptions } from "../snippet-core.js";
import { renderStructLiteral, renderValue } from "../snippet-core.js";
import { tsObjKey } from "./emit.js";
import { buildEmitModel } from "./typescript.js";

/** Snippet rendering hooks for TypeScript (object literals, `true`/`null`). */
const tsDialect: SnippetDialect = {
  indentUnit: "  ",
  string: (s) => JSON.stringify(s),
  boolean: (b) => (b ? "true" : "false"),
  number: (n) => (Number.isFinite(n) ? String(n) : "NaN"),
  null: "null",
  objKey: tsObjKey,
};

/**
 * Render a TypeScript call snippet for one tool from a config object (keyed by
 * Boutiques wire names).
 *
 * The generated v2 kwarg wrapper takes *positional* arguments, which can't skip
 * a middle optional - so the runnable object-style entry is the dict-style
 * `<tool>Execute(params)` (struct roots). The snippet builds the params object
 * literal (wire-keyed, with the root `@type` injected) and passes it there.
 * Union- (or otherwise non-struct-) rooted tools call the dict-style `<tool>`
 * entry the same way. Nested structs / union variants / lists-of-structs have no
 * constructor in the generated code and render as object literals.
 *
 * The snippet matches the *standalone* (single-descriptor) emission of the same
 * context - which is how the hub compiles - not a catalog emission where a
 * shared package scope could suffix-bump a name.
 */
export function renderTypeScriptCall(
  ctx: CodegenContext,
  config: Record<string, unknown>,
  opts: SnippetOptions = {},
): string {
  const model = buildEmitModel(ctx);
  const pkg = ctx.package?.name;
  const fnName = model.rootIsStruct ? model.names.execute : model.names.wrapper;
  const callee = pkg ? `${pkg}.${fnName}` : fnName;

  const arg =
    model.rootIsStruct && model.rootType.kind === "struct"
      ? renderStructLiteral(config, model.rootType, "", tsDialect, model.rootTypeTag)
      : renderValue(config, model.rootType, "", tsDialect);
  const call = `${callee}(${arg})`;

  if (opts.includeImport === false || !pkg) return call;
  const root = opts.packageRoot ?? ctx.project?.name ?? "niwrap";
  return `import { ${pkg} } from "${root}";\n\n${call}`;
}
