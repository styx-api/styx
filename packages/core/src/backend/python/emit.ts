import type { BoundType } from "../../bindings/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import type { SigEntry, SigOptions } from "../sig-entries.js";
import { snakeCase } from "../string-case.js";
import type { ArgResult } from "./arg-builder.js";
import { buildArgs, resultToStmt } from "./arg-builder.js";
import { mapType, pyStr } from "./typemap.js";
import type { NamedType } from "./types.js";
import { collectFieldInfo, resolveTypeName } from "./types.js";

/**
 * Emit a Python triple-quoted docstring. Single-line if short, multi-line for
 * longer text. Should be placed as the first statement inside a function/class
 * body or as a field doc immediately after the annotation.
 */
export function emitDocstring(cb: CodeBuilder, text?: string): void {
  if (!text) return;
  const lines = text.split("\n");
  if (lines.length === 1 && !lines[0]!.includes('"')) {
    cb.line(`"""${lines[0]}"""`);
    return;
  }
  cb.line(`"""`);
  for (const line of lines) cb.line(line);
  cb.line(`"""`);
}

export function emitImports(cb: CodeBuilder, emitOutputs: boolean): void {
  cb.line("import dataclasses");
  cb.line("import typing");
  cb.blank();
  const fromStyxdefs = ["Execution", "InputPathType", "Metadata", "Runner"];
  if (emitOutputs) fromStyxdefs.push("OutputPathType");
  cb.line(`from styxdefs import ${fromStyxdefs.join(", ")}, get_global_runner`);
}

export function emitMetadata(ctx: CodegenContext, metaConst: string, cb: CodeBuilder): void {
  const id = ctx.app?.id ?? "unknown";
  const name = ctx.app?.doc?.title ?? ctx.app?.id ?? "unknown";
  const pkg = ctx.package?.name ?? "unknown";

  cb.line(`${metaConst} = Metadata(`);
  cb.indent(() => {
    cb.line(`id=${pyStr(id)},`);
    cb.line(`name=${pyStr(name)},`);
    cb.line(`package=${pyStr(pkg)},`);
    if (ctx.app?.doc?.literature?.length) {
      cb.line(`citations=[${ctx.app.doc.literature.map(pyStr).join(", ")}],`);
    }
    if (ctx.app?.container?.image) {
      cb.line(`container_image_tag=${pyStr(ctx.app.container.image)},`);
    }
  });
  cb.line(")");
}

/**
 * Python keywords that would cause a SyntaxError or silent miscompile if used
 * as a class-body annotation key (e.g. `lambda: float` parses as a lambda
 * expression statement, not a TypedDict field). The class-syntax check uses
 * this to force functional syntax for those fields. Builtins like `int`/`str`
 * are NOT in this set - those are valid class attribute names.
 */
export const PY_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** Can `s` be used as a class-attribute name in a TypedDict class body? */
function isPyIdent(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !PY_KEYWORDS.has(s);
}

/**
 * Emit the python source for one struct as a TypedDict. Uses functional syntax
 * if any field name is not a Python identifier (e.g. `@type` discriminators);
 * otherwise uses class syntax for readability.
 *
 * When `injectAtTypeTag` is given, an `@type: typing.Literal[<tag>]` entry is
 * prepended; used by the root struct of single-tool params, whose tag is
 * derived from `pkg/appId` rather than from the IR.
 */
function emitStructTypedDict(
  name: string,
  type: Extract<BoundType, { kind: "struct" }>,
  ctx: CodegenContext,
  resolve: (t: BoundType) => string | undefined,
  cb: CodeBuilder,
  injectAtTypeTag?: string,
): void {
  const fieldInfo = collectFieldInfo(ctx, type);
  const entries = Object.entries(type.fields);
  // @type literal fields are special: they're not user-provided regular fields
  // but discriminator values. Other literals are skipped (they have no runtime
  // representation in the dict).
  const hasInjectedAtType = injectAtTypeTag !== undefined;
  const hasNonIdentKey =
    hasInjectedAtType ||
    entries.some(([k, v]) => {
      if (v.kind === "literal") return k === "@type";
      return !isPyIdent(k);
    });

  // Compute the typed entry list (skipping non-discriminator literals).
  const typedEntries: Array<{ key: string; type: string; doc?: string }> = [];
  if (injectAtTypeTag !== undefined) {
    // NotRequired: the factory always sets @type and runtime dispatch tables
    // read it, but callers building a dict by hand shouldn't have to type it.
    // (Union variants further down keep their @type required - that one IS
    // load-bearing for discriminated-union narrowing.)
    typedEntries.push({
      key: "@type",
      type: `typing.NotRequired[typing.Literal[${pyStr(injectAtTypeTag)}]]`,
    });
  }
  for (const [fieldName, fieldType] of entries) {
    if (fieldType.kind === "literal") {
      if (fieldName === "@type") {
        const lit =
          typeof fieldType.value === "string"
            ? `typing.Literal[${pyStr(fieldType.value)}]`
            : `typing.Literal[${fieldType.value}]`;
        typedEntries.push({ key: fieldName, type: lit });
      }
      continue;
    }
    const fi = fieldInfo.get(fieldName);
    const hasDefault = fi?.defaultValue !== undefined;
    let typeExpr = mapType(fieldType, resolve);
    // Fields with defaults are nullable: missing/None means "use the default".
    // Mirrors the TS backend's `field?:` semantics on TypedDict-like shapes.
    if (hasDefault && !typeExpr.includes("None")) {
      typeExpr = `${typeExpr} | None`;
    }
    typedEntries.push({ key: fieldName, type: typeExpr, doc: fi?.doc });
  }

  if (hasNonIdentKey) {
    cb.line(`${name} = typing.TypedDict(`);
    cb.indent(() => {
      cb.line(`${pyStr(name)},`);
      cb.line(`{`);
      cb.indent(() => {
        for (const { key, type } of typedEntries) {
          cb.line(`${pyStr(key)}: ${type},`);
        }
      });
      cb.line(`},`);
    });
    cb.line(`)`);
  } else {
    cb.line(`class ${name}(typing.TypedDict):`);
    cb.indent(() => {
      if (typedEntries.length === 0) {
        cb.line("pass");
        return;
      }
      for (const { key, type, doc } of typedEntries) {
        cb.line(`${key}: ${type}`);
        if (doc) emitDocstring(cb, doc);
      }
    });
  }
}

export function emitTypeDeclarations(
  typeDecls: NamedType[],
  namedTypes: Map<string, string>,
  ctx: CodegenContext,
  cb: CodeBuilder,
  rootName?: string,
  rootTypeTag?: string,
): void {
  const resolve = resolveTypeName(namedTypes);

  // Python evaluates type expressions eagerly (no hoisting like TS), so we
  // emit declarations in reverse-discovery order: leaves before roots. The
  // walker pushes parents before children, so reversing yields a topological
  // order suitable for evaluation.
  const ordered = [...typeDecls].reverse();

  for (const { name, type } of ordered) {
    if (type.kind === "struct") {
      const inject = name === rootName ? rootTypeTag : undefined;
      emitStructTypedDict(name, type, ctx, resolve, cb, inject);
      cb.blank();
    } else if (type.kind === "union") {
      const parts = type.variants.map((v) => mapType(v.type, resolve));
      cb.line(`${name} = ${parts.join(" | ")}`);
      cb.blank();
    }
  }
}

export function emitBuildCargs(
  ctx: CodegenContext,
  rootType: BoundType,
  paramsType: string,
  funcName: string,
  cb: CodeBuilder,
): void {
  let result: ArgResult;
  try {
    result = buildArgs(ctx.expr, ctx, rootType);
  } catch {
    cb.line(`def ${funcName}(params: ${paramsType}, execution: Execution) -> list[str]:`);
    cb.indent(() => {
      emitDocstring(cb, "Build command-line arguments from parameters.");
      cb.line("return []");
    });
    return;
  }

  const argsCode = resultToStmt(result);

  cb.line(`def ${funcName}(params: ${paramsType}, execution: Execution) -> list[str]:`);
  cb.indent(() => {
    emitDocstring(cb, "Build command-line arguments from parameters.");
    cb.line("cargs: list[str] = []");
    for (const line of argsCode.split("\n")) {
      if (line.trim()) cb.line(line);
    }
    cb.line("return cargs");
  });
}

export function emitWrapperFunction(
  ctx: CodegenContext,
  paramsType: string,
  funcName: string,
  metaConst: string,
  cargsFunc: string,
  outputsFunc: string | undefined,
  outputsType: string | undefined,
  cb: CodeBuilder,
): void {
  const emitOutputs = outputsFunc !== undefined;
  const appDoc = ctx.app?.doc;
  const returnType = emitOutputs && outputsType ? outputsType : "None";

  cb.line(`def ${funcName}(params: ${paramsType}, runner: Runner | None = None) -> ${returnType}:`);
  cb.indent(() => {
    cb.line('"""');
    let hasContent = false;
    if (appDoc?.title) {
      cb.line(appDoc.title);
      hasContent = true;
    }
    if (appDoc?.description) {
      if (hasContent) cb.blank();
      cb.line(appDoc.description);
      hasContent = true;
    }
    if (appDoc?.authors?.length) {
      if (hasContent) cb.blank();
      cb.line(`Author: ${appDoc.authors.join(", ")}`);
      hasContent = true;
    }
    if (appDoc?.urls?.length) {
      if (hasContent) cb.blank();
      cb.line(`URL: ${appDoc.urls[0]}`);
      hasContent = true;
    }
    if (hasContent) cb.blank();
    cb.line("Args:");
    cb.line("    params: The parameters.");
    cb.line("    runner: Command runner (defaults to global runner).");
    cb.blank();
    cb.line("Returns:");
    cb.line(emitOutputs ? "    Tool outputs (paths to files produced by the tool)." : "    None.");
    cb.line('"""');
    cb.line("runner = runner if runner is not None else get_global_runner()");
    cb.line(`execution = runner.start_execution(${metaConst})`);
    cb.line("execution.params(params)");
    // Local names `args`/`out` avoid colliding with the module-level `cargs`
    // and `outputs` functions when they share generic names.
    cb.line(`args = ${cargsFunc}(params, execution)`);
    if (emitOutputs) {
      cb.line(`out = ${outputsFunc}(params, execution)`);
      cb.line("execution.run(args)");
      cb.line("return out");
    } else {
      cb.line("execution.run(args)");
    }
  });
}

/** Convenience: derive a snake_case function name from the app id. */
export function appFuncName(ctx: CodegenContext, fallback: string): string {
  return snakeCase(ctx.app?.id ?? fallback);
}

/** Render a JS value as a Python literal. Used for default values in signatures. */
function renderPyDefault(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "float('nan')";
  return pyStr(value);
}

/** SigOptions hooks for Python: ` | None` nullable suffix, `None` nullable default. */
export function pySigOptions(resolve: (t: BoundType) => string | undefined): SigOptions {
  return {
    renderType: (t) => mapType(t, resolve),
    nullableSuffix: " | None",
    nullableDefault: "None",
    renderDefault: renderPyDefault,
  };
}

/**
 * Scrub a Boutiques wire name into a valid Python host identifier. Replaces
 * any non-`[A-Za-z0-9_]` character with `_`; prefixes `v_` if the result
 * starts with a digit; appends a single trailing underscore when the scrubbed
 * name matches a reserved word or shadowed built-in (matching v1 niwrap's
 * `float_:` style). The caller is responsible for further deduping the result
 * through a `Scope` so collisions with already-registered locals don't slip
 * through.
 */
export function pyScrubIdent(name: string, reserved: ReadonlySet<string>): string {
  let scrubbed = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(scrubbed)) scrubbed = "v_" + scrubbed;
  if (scrubbed === "") scrubbed = "_";
  if (reserved.has(scrubbed)) scrubbed = scrubbed + "_";
  return scrubbed;
}

/** Emit a sequence of `name: type [= default],` lines (one per entry) into `cb`. */
function emitSigParams(entries: readonly SigEntry[], cb: CodeBuilder): void {
  for (const e of entries) {
    if (e.sigDefault !== undefined) {
      cb.line(`${e.name}: ${e.sigType} = ${e.sigDefault},`);
    } else {
      cb.line(`${e.name}: ${e.sigType},`);
    }
  }
}

/**
 * Word-wrap a Google-style "Args:" entry. Produces lines like
 *   `name: description that continues...\`
 *   `    until it ends here.`
 * The first line is prefixed with `<indent><name>: `; continuations use
 * `<indent>    ` (4 spaces deeper). Lines that exceed `lineWidth` end with a
 * `\` continuation marker.
 */
function wrapDocEntry(name: string, doc: string, indent: string, lineWidth = 80): string[] {
  const firstPrefix = `${indent}${name}: `;
  const contPrefix = `${indent}    `;
  const words = doc.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [`${firstPrefix.trimEnd()}`];

  const lines: string[] = [];
  let current = firstPrefix + words[0]!;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (current.length + 1 + word.length + 1 > lineWidth) {
      lines.push(current + "\\");
      current = contPrefix + word;
    } else {
      current += " " + word;
    }
  }
  lines.push(current);
  return lines;
}

/** Emit the per-field `Args:` block for a docstring. Caller is already at the
 * correct indent (i.e. inside the function body). */
function emitArgsBlock(entries: readonly { name: string; doc?: string }[], cb: CodeBuilder): void {
  cb.line("Args:");
  for (const e of entries) {
    for (const ln of wrapDocEntry(e.name, e.doc ?? "", "    ")) cb.line(ln);
  }
}

/**
 * Emit the `_params(...)` factory: a kwarg-style function that builds and
 * returns the params dict (with `@type` injected). Required fields and fields
 * with explicit defaults are always set; optional-without-default fields are
 * conditionally set when not None.
 */
export function emitParamsFactory(
  entries: readonly SigEntry[],
  funcName: string,
  paramsType: string,
  typeTag: string | undefined,
  cb: CodeBuilder,
): void {
  // Signature
  if (entries.length === 0) {
    cb.line(`def ${funcName}() -> ${paramsType}:`);
  } else {
    cb.line(`def ${funcName}(`);
    cb.indent(() => emitSigParams(entries, cb));
    cb.line(`) -> ${paramsType}:`);
  }

  cb.indent(() => {
    // Docstring
    cb.line('"""');
    cb.line("Build params.");
    if (entries.length > 0) {
      cb.blank();
      emitArgsBlock(entries, cb);
    }
    cb.blank();
    cb.line("Returns:");
    cb.line("    Params dictionary.");
    cb.line('"""');

    // Build dict: required and explicitly-defaulted fields go into the literal
    cb.line(`params: ${paramsType} = {`);
    cb.indent(() => {
      if (typeTag !== undefined) cb.line(`"@type": ${pyStr(typeTag)},`);
      for (const e of entries) {
        if (!e.isOptional || e.hasExplicitDefault) {
          cb.line(`${pyStr(e.wireKey)}: ${e.name},`);
        }
      }
    });
    cb.line("}");

    // Conditional include for optional-without-default fields
    for (const e of entries) {
      if (e.isOptional && !e.hasExplicitDefault) {
        cb.line(`if ${e.name} is not None:`);
        cb.indent(() => cb.line(`params[${pyStr(e.wireKey)}] = ${e.name}`));
      }
    }
    cb.line("return params");
  });
}

/**
 * Emit the user-facing kwarg wrapper: takes the same kwargs as `_params()`
 * plus `runner`, builds the params dict, and delegates to the dict-style
 * execute function.
 */
export function emitKwargWrapper(
  ctx: CodegenContext,
  entries: readonly SigEntry[],
  funcName: string,
  paramsFnName: string,
  executeFnName: string,
  outputsType: string | undefined,
  cb: CodeBuilder,
): void {
  // Signature: same as params factory + `runner` last
  cb.line(`def ${funcName}(`);
  cb.indent(() => {
    emitSigParams(entries, cb);
    cb.line("runner: Runner | None = None,");
  });
  const returnType = outputsType ?? "None";
  cb.line(`) -> ${returnType}:`);

  cb.indent(() => {
    // Docstring: app title/description + per-field docs + runner + Returns.
    const appDoc = ctx.app?.doc;
    cb.line('"""');
    if (appDoc?.title) cb.line(appDoc.title);
    if (appDoc?.description) {
      if (appDoc?.title) cb.blank();
      cb.line(appDoc.description);
    }
    if (appDoc?.authors?.length) {
      cb.blank();
      cb.line(`Author: ${appDoc.authors.join(", ")}`);
    }
    if (appDoc?.urls?.length) {
      cb.blank();
      cb.line(`URL: ${appDoc.urls[0]}`);
    }
    cb.blank();
    emitArgsBlock(
      [...entries, { name: "runner", doc: "Command runner (defaults to global runner)." }],
      cb,
    );
    cb.blank();
    cb.line("Returns:");
    cb.line(outputsType ? "    Tool outputs (paths to files produced by the tool)." : "    None.");
    cb.line('"""');

    // Body: delegate to factory + execute
    if (entries.length === 0) {
      cb.line(`params = ${paramsFnName}()`);
    } else {
      cb.line(`params = ${paramsFnName}(`);
      cb.indent(() => {
        for (const e of entries) cb.line(`${e.name}=${e.name},`);
      });
      cb.line(")");
    }
    if (outputsType) {
      cb.line(`return ${executeFnName}(params, runner)`);
    } else {
      cb.line(`${executeFnName}(params, runner)`);
    }
  });
}
