import type { BoundType } from "../../bindings/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import type { SigEntry } from "../sig-entries.js";
import type { SnippetDialect, SnippetOptions } from "../snippet-core.js";
import { renderValue } from "../snippet-core.js";
import { buildEmitModel } from "./python.js";
import { pyStr } from "./typemap.js";

/** Snippet rendering hooks for Python (dict literals, `True`/`None`). */
const pyDialect: SnippetDialect = {
  indentUnit: "    ",
  string: pyStr,
  boolean: (b) => (b ? "True" : "False"),
  number: (n) => (Number.isFinite(n) ? String(n) : "float('nan')"),
  null: "None",
  objKey: (k) => pyStr(k),
};

/**
 * Render a Python call snippet for one tool from a config object (the params
 * dict the form produces, keyed by Boutiques wire names).
 *
 * Struct-rooted tools use the ergonomic kwarg wrapper -
 * `fsl.bet(infile=..., fractional_intensity=0.5)` - whose keyword names are the
 * *scrubbed host* identifiers (`float` -> `float_`), not the wire keys; the
 * per-field mapping comes from the same `buildSigEntries` the generated wrapper
 * is built from, so the snippet matches the real signature. Nested structs /
 * union variants / lists-of-structs have no constructor in the generated code,
 * so they render as plain dict literals keyed by wire names.
 *
 * Union- (or otherwise non-struct-) rooted tools have no kwarg wrapper; the
 * single dict-style `<tool>` entry is called with one object-literal argument.
 *
 * The snippet matches the *standalone* (single-descriptor) emission of the same
 * context - which is how the hub compiles - not a catalog emission where a
 * shared package scope could suffix-bump a name.
 *
 * @param ctx - The compiled context (compile -> pipeline -> solve ->
 *   resolveOutputs -> createContext, as in the CLI's `readAndCompile`).
 * @param config - The params object, keyed by Boutiques *wire* names (not host
 *   identifiers). Every union-typed value - including the root of a union-rooted
 *   tool - must carry its `@type` discriminator so the variant can be matched;
 *   the root struct's `@type` is supplied by the renderer, so omit it there.
 * @param opts - Import and package-root options.
 */
export function renderPythonCall(
  ctx: CodegenContext,
  config: Record<string, unknown>,
  opts: SnippetOptions = {},
): string {
  const model = buildEmitModel(ctx);
  const pkg = ctx.package?.name;
  const callee = pkg ? `${pkg}.${model.names.wrapper}` : model.names.wrapper;

  const call =
    model.rootIsStruct && model.rootType.kind === "struct"
      ? renderKwargCall(callee, model.sigEntries, model.rootType, config)
      : `${callee}(${renderValue(config, model.rootType, "", pyDialect)})`;

  if (opts.includeImport === false || !pkg) return call;
  const root = opts.packageRoot ?? ctx.project?.name;
  const importLine = root ? `from ${root} import ${pkg}` : `import ${pkg}`;
  return `${importLine}\n\n${call}`;
}

/** Render `callee(name=value, ...)` for a struct root using scrubbed kwarg names. */
function renderKwargCall(
  callee: string,
  sigEntries: readonly SigEntry[],
  rootType: Extract<BoundType, { kind: "struct" }>,
  config: Record<string, unknown>,
): string {
  const nameFor = new Map(sigEntries.map((e) => [e.wireKey, e.name]));
  const indent = pyDialect.indentUnit;
  const lines: string[] = [];
  for (const [wireKey, fieldType] of Object.entries(rootType.fields)) {
    if (fieldType.kind === "literal") continue; // @type / consts injected by the wrapper
    if (!(wireKey in config)) continue;
    const name = nameFor.get(wireKey) ?? wireKey;
    lines.push(`${indent}${name}=${renderValue(config[wireKey], fieldType, indent, pyDialect)},`);
  }
  if (lines.length === 0) return `${callee}()`;
  return `${callee}(\n${lines.join("\n")}\n)`;
}
