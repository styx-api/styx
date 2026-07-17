import type { BoundType } from "../../bindings/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import type { SigEntry, SigOptions } from "../sig-entries.js";
import { snakeCase } from "../string-case.js";
import { structKey, unionKey } from "../type-keys.js";
import type { ArgResult } from "./arg-builder.js";
import { buildArgs, resultToStmt } from "./arg-builder.js";
import { mapType, pyStr, renderPyLiteral } from "./typemap.js";
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

export function emitImports(cb: CodeBuilder): void {
  cb.line("import dataclasses");
  cb.line("import pathlib");
  cb.line("import typing");
  cb.blank();
  // Every tool emits an Outputs object, so OutputPathType is always needed.
  // (Kept last to preserve the previously emitted import order.)
  const fromStyxdefs = [
    "Execution",
    "InputPathType",
    "Metadata",
    "Runner",
    "StyxValidationError",
    "OutputPathType",
  ];
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
    // The package/version-level container is authoritative: niwrap curates one
    // container per tool version (version.json) and applies it to every app, so
    // it overrides a descriptor's incidental inline container-image. The inline
    // image is only a fallback for a standalone single-descriptor build that has
    // no package context.
    const containerImage = ctx.package?.docker ?? ctx.app?.container?.image;
    if (containerImage) {
      cb.line(`container_image_tag=${pyStr(containerImage)},`);
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
    const isOptional = fieldType.kind === "optional";
    // The value type is the inner type, never `| None`: the solver has no
    // nullable, so a present value is never None. Omittability (the key may be
    // absent) is expressed structurally via `typing.NotRequired[...]`.
    const inner = isOptional ? fieldType.inner : fieldType;
    let typeExpr = mapType(inner, resolve);
    // A field is omittable iff it is `optional` or it carries a default (which
    // includes flags - `defaultValue` false). Mark omittable fields NotRequired:
    // optional-without-default fields are conditionally set by the factory, and
    // defaulted fields may legitimately be absent in a hand-authored config (the
    // absence-safe runtime reads apply the default). Required-without-default
    // fields stay bare - the factory always writes them.
    if (isOptional || hasDefault) {
      typeExpr = `typing.NotRequired[${typeExpr}]`;
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

/** Structural identity key for a NamedType (only structs/unions are collected). */
function declKey(type: BoundType): string | undefined {
  if (type.kind === "struct") return structKey(type);
  if (type.kind === "union") return unionKey(type);
  return undefined;
}

/**
 * Collect the keys of every named struct/union directly referenced by `type`'s
 * emitted expression. Wrappers (optional/list) are transparent; a nested
 * struct/union is its own declaration, so we record its key and stop. This is
 * the dependency edge set used to order declarations.
 */
function collectRefs(type: BoundType, namedTypes: Map<string, string>, out: Set<string>): void {
  switch (type.kind) {
    case "optional":
      collectRefs(type.inner, namedTypes, out);
      break;
    case "list":
      collectRefs(type.item, namedTypes, out);
      break;
    case "struct": {
      const k = structKey(type);
      if (namedTypes.has(k)) out.add(k);
      break;
    }
    case "union": {
      const k = unionKey(type);
      if (namedTypes.has(k)) out.add(k);
      break;
    }
    default:
      break;
  }
}

/** Direct named-type dependencies of one declaration (its field/variant types). */
function declDeps(type: BoundType, namedTypes: Map<string, string>): Set<string> {
  const out = new Set<string>();
  if (type.kind === "struct") {
    for (const fieldType of Object.values(type.fields)) collectRefs(fieldType, namedTypes, out);
  } else if (type.kind === "union") {
    for (const v of type.variants) collectRefs(v.type, namedTypes, out);
  }
  return out;
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

  // Python evaluates type expressions eagerly (no hoisting like TS): a name
  // must be defined before any declaration references it. The collector yields
  // types in forward-discovery order (parents before children); the old
  // emission just reversed that, but reverse-discovery breaks for shared types
  // in a DAG - e.g. a union arm discovered deep under the FIRST variant that is
  // also referenced by a LATER sibling arm ends up emitted after its user.
  // Instead, do a real topological sort over the dependency graph (post-order
  // DFS so a type is emitted only after every type it references). Back-edges
  // from a cycle are ignored - the recursion guard breaks them, and recursive
  // descriptor types don't occur in practice.
  const byKey = new Map<string, NamedType>();
  for (const decl of typeDecls) {
    const k = declKey(decl.type);
    if (k !== undefined) byKey.set(k, decl);
  }

  const ordered: NamedType[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  function emitInOrder(key: string): void {
    if (visited.has(key)) return;
    const decl = byKey.get(key);
    if (decl === undefined) return;
    onStack.add(key);
    for (const dep of declDeps(decl.type, namedTypes)) {
      if (!onStack.has(dep)) emitInOrder(dep);
    }
    onStack.delete(key);
    visited.add(key);
    ordered.push(decl);
  }
  // Drive from the original discovery order so independent declarations keep a
  // stable, deterministic relative order.
  for (const decl of typeDecls) {
    const k = declKey(decl.type);
    if (k !== undefined) emitInOrder(k);
  }

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
  validateFunc: string | undefined,
  streams: { stdout?: string; stderr?: string },
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
    // Validate the params dict first (the kwarg wrapper delegates here, so it
    // gets validation transitively; the statically-typed kwargs don't need it).
    if (validateFunc) cb.line(`${validateFunc}(params)`);
    cb.line("runner = runner if runner is not None else get_global_runner()");
    cb.line(`execution = runner.start_execution(${metaConst})`);
    cb.line("execution.params(params)");
    // Local names `args`/`out` avoid colliding with the module-level `cargs`
    // and `outputs` functions when they share generic names.
    cb.line(`args = ${cargsFunc}(params, execution)`);
    if (emitOutputs) {
      cb.line(`out = ${outputsFunc}(params, execution)`);
      const handlers: string[] = [];
      if (streams.stdout) handlers.push(`handle_stdout=lambda s: out.${streams.stdout}.append(s)`);
      if (streams.stderr) handlers.push(`handle_stderr=lambda s: out.${streams.stderr}.append(s)`);
      cb.line(`execution.run(args${handlers.length ? ", " + handlers.join(", ") : ""})`);
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

/**
 * SigOptions hooks for Python. The kwarg-signature sentinel for an optional
 * param is `T | None = None` - here `| None` is the *parameter* type (the
 * "not provided" sentinel a caller passes), not the dict field type, which is
 * just `typing.NotRequired[T]`. Keeping the sentinel preserves the ergonomic
 * `foo(x)` call where omitted optionals default to `None` and the factory then
 * drops them.
 */
export function pySigOptions(resolve: (t: BoundType) => string | undefined): SigOptions {
  return {
    renderType: (t) => mapType(t, resolve),
    nullableSuffix: " | None",
    nullableDefault: "None",
    renderDefault: renderPyLiteral,
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
 * returns the params dict (with `@type` injected). Non-optional fields (required,
 * and defaulted scalars whose default lives on the signature) are always set in
 * the literal. Every optional field is set conditionally when not None -
 * including optional-with-default ones: their value type is `T | None` (the omit
 * sentinel) but the dict field is the non-None `NotRequired[T]`, so a bare
 * literal assignment of a possibly-None value would not type-check. When the
 * caller omits the arg, the signature default (a concrete non-None value) flows
 * through the guard and is written.
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
    cb.line("Build parameters.");
    if (entries.length > 0) {
      cb.blank();
      emitArgsBlock(entries, cb);
    }
    cb.blank();
    cb.line("Returns:");
    cb.line("    Parameter dictionary.");
    cb.line('"""');

    // Build dict: required and explicitly-defaulted fields go into the literal
    cb.line(`params: ${paramsType} = {`);
    cb.indent(() => {
      if (typeTag !== undefined) cb.line(`"@type": ${pyStr(typeTag)},`);
      for (const e of entries) {
        if (!e.isOptional) {
          cb.line(`${pyStr(e.wireKey)}: ${e.name},`);
        }
      }
    });
    cb.line("}");

    // Conditional include for every optional field (its kwarg default supplies a
    // non-None value when the caller omits the arg).
    for (const e of entries) {
      if (e.isOptional) {
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
