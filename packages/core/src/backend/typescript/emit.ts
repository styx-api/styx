import type { AccessPath, BindingId, BoundType } from "../../bindings/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import type { SigEntry, SigOptions } from "../sig-entries.js";
import type { ArgResult } from "./arg-builder.js";
import { buildArgs, resultToStmt } from "./arg-builder.js";
import { mapType, renderTsLiteral } from "./typemap.js";
import type { NamedType } from "./types.js";
import { collectFieldInfo, resolveTypeName } from "./types.js";

export function emitJsDoc(cb: CodeBuilder, description?: string): void {
  if (!description) return;
  // Escape `*/` so a description containing it can't terminate the block comment
  // early (`*\/` is not a comment terminator; the backslash is inert in comments).
  const safe = description.replace(/\*\//g, "*\\/");
  const lines = safe.split("\n");
  if (lines.length === 1) {
    cb.line(`/** ${lines[0]} */`);
  } else {
    cb.line("/**");
    for (const line of lines) {
      cb.line(` * ${line}`);
    }
    cb.line(" */");
  }
}

export function emitImports(cb: CodeBuilder): void {
  // Every tool emits an Outputs object, so OutputPathType is always needed.
  const inputs = ["Runner", "Execution", "Metadata", "InputPathType", "OutputPathType"];
  cb.line(`import type { ${inputs.join(", ")} } from "styxdefs";`);
  cb.line('import { getGlobalRunner, StyxValidationError } from "styxdefs";');
}

export function emitMetadata(ctx: CodegenContext, metaConst: string, cb: CodeBuilder): void {
  const id = ctx.app?.id ?? "unknown";
  const name = ctx.app?.doc?.title ?? ctx.app?.id ?? "unknown";
  const pkg = ctx.package?.name ?? "unknown";

  cb.line(`export const ${metaConst}: Metadata = {`);
  cb.indent(() => {
    cb.line(`id: ${JSON.stringify(id)},`);
    cb.line(`name: ${JSON.stringify(name)},`);
    cb.line(`package: ${JSON.stringify(pkg)},`);
    if (ctx.app?.doc?.literature?.length) {
      cb.line(`citations: ${JSON.stringify(ctx.app.doc.literature)},`);
    }
    // The package/version-level container is authoritative: niwrap curates one
    // container per tool version (version.json) and applies it to every app, so
    // it overrides a descriptor's incidental inline container-image. The inline
    // image is only a fallback for a standalone single-descriptor build that has
    // no package context.
    const containerImage = ctx.package?.docker ?? ctx.app?.container?.image;
    if (containerImage) {
      cb.line(`container_image_tag: ${JSON.stringify(containerImage)},`);
    }
  });
  cb.line("};");
}

export function emitTypeDeclarations(
  typeDecls: NamedType[],
  namedTypes: Map<string, string>,
  ctx: CodegenContext,
  rootName: string,
  appId: string | undefined,
  pkg: string,
  cb: CodeBuilder,
): void {
  const resolve = resolveTypeName(namedTypes);

  for (const { name, type } of typeDecls) {
    const isRoot = name === rootName;

    if (type.kind === "struct") {
      const fieldInfo = collectFieldInfo(ctx, type);

      cb.line(`export interface ${name} {`);
      cb.indent(() => {
        // @type discriminator on root params interface. Optional: the params
        // factory always sets it and runtime dispatch tables read it, but the
        // type system doesn't need it required (there's only one shape). Union
        // variants below keep their @type required - that one IS load-bearing
        // for discriminated-union narrowing.
        if (isRoot && appId) {
          cb.line(`"@type"?: "${pkg}/${appId}";`);
        }

        for (const [fieldName, fieldType] of Object.entries(type.fields)) {
          // Emit literal @type discriminators on union variant structs
          if (fieldType.kind === "literal") {
            if (fieldName === "@type") {
              cb.line(`"@type": ${JSON.stringify(fieldType.value)};`);
            }
            continue;
          }
          const fi = fieldInfo.get(fieldName);
          emitJsDoc(cb, fi?.doc);

          const isOptional = fieldType.kind === "optional";
          // A field is omittable (key may be absent) iff it is `optional` or it
          // carries a default (which includes flags - their `defaultValue` is
          // false). The default/absent case is handled by the params factory and
          // the absence-safe runtime reads; the type only needs to permit the key
          // to be missing. Never `| null`: the solver has no nullable, so a
          // present value is never null - omittability is the only "unset".
          const omittable = isOptional || fi?.defaultValue !== undefined;
          const optional = omittable ? "?" : "";

          const mapped = isOptional
            ? mapType(fieldType.inner, resolve)
            : mapType(fieldType, resolve);
          // Quote keys that aren't valid identifiers (e.g. `4d_input`). TS
          // allows reserved-word identifiers as interface keys without quotes.
          cb.line(`${tsObjKey(fieldName)}${optional}: ${mapped};`);
        }
      });
      cb.line("}");
      cb.blank();
    } else if (type.kind === "union") {
      const parts = type.variants.map((v) => mapType(v.type, resolve));
      cb.line(`export type ${name} = ${parts.join(" | ")};`);
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
  const paramsVar = "params";

  let result: ArgResult;
  try {
    result = buildArgs(ctx.expr, ctx, rootType);
  } catch {
    emitJsDoc(cb, "Build command-line arguments from parameters.");
    cb.line(
      `export function ${funcName}(_${paramsVar}: ${paramsType}, _execution: Execution): string[] {`,
    );
    cb.indent(() => cb.line("return [];"));
    cb.line("}");
    return;
  }

  const argsCode = resultToStmt(result);

  emitJsDoc(cb, "Build command-line arguments from parameters.");
  cb.line(
    `export function ${funcName}(${paramsVar}: ${paramsType}, execution: Execution): string[] {`,
  );
  cb.indent(() => {
    cb.line("const cargs: string[] = [];");
    for (const line of argsCode.split("\n")) {
      if (line.trim()) cb.line(line);
    }
    cb.line("return cargs;");
  });
  cb.line("}");
}

/**
 * SigOptions hooks for TypeScript. The kwarg-signature sentinel for an optional
 * param is `T | null = null` - here `| null` is the *parameter* type (the
 * "not provided" sentinel a caller passes), not the dict field type, which is
 * just `T?`. Keeping the sentinel keeps the ergonomic `foo(x)` call where
 * omitted optionals default to `null` and the factory then drops them.
 */
export function tsSigOptions(resolve: (t: BoundType) => string | undefined): SigOptions {
  return {
    renderType: (t) => mapType(t, resolve),
    nullableSuffix: " | null",
    nullableDefault: "null",
    renderDefault: renderTsLiteral,
  };
}

/**
 * Scrub a Boutiques wire name into a valid TypeScript host identifier.
 * Mirrors Python's scrub: non-`[A-Za-z0-9_$]` replaced with `_`, digit
 * prefixes get `v_`, reserved-word matches get a trailing `_`. Dedupe through
 * a `Scope` for collisions with already-registered locals.
 */
export function tsScrubIdent(name: string, reserved: ReadonlySet<string>): string {
  let scrubbed = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(scrubbed)) scrubbed = "v_" + scrubbed;
  if (scrubbed === "") scrubbed = "_";
  if (reserved.has(scrubbed)) scrubbed = scrubbed + "_";
  return scrubbed;
}

const TS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render a TypeScript property access path. Uses dot notation when the key is
 * a valid identifier, bracket notation otherwise. (Wire keys like `4d_input`
 * or `@type` can't be dot-accessed.)
 */
export function tsPropAccess(base: string, key: string): string {
  return TS_IDENT_RE.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/**
 * Render a solver-assigned `AccessPath` to a TypeScript expression. Starts from
 * `params`; each `field` segment descends a property, and each `iter` segment
 * resets the base to the loop variable bound to that repeat binding (resolved
 * via `lookupLoopVar` - the `iter` gate atom's loop in outputs codegen, or the
 * arg-builder's local loop). Both the arg-builder and the outputs emitter feed
 * this one function instead of re-deriving paths.
 */
export function renderAccess(
  path: AccessPath,
  lookupLoopVar: (binding: BindingId) => string,
): string {
  let cur = "params";
  for (const seg of path) {
    cur = seg.kind === "field" ? tsPropAccess(cur, seg.name) : lookupLoopVar(seg.binding);
  }
  return cur;
}

/**
 * Render a TypeScript object-literal key. Bare ident when valid, quoted
 * otherwise. (`name: ...` for `name`, `"4d_input": ...` for `4d_input`.)
 */
export function tsObjKey(key: string): string {
  return TS_IDENT_RE.test(key) ? key : JSON.stringify(key);
}

/** Emit `name: type [= default],` lines (one per entry) into `cb`. */
function emitSigParams(entries: readonly SigEntry[], cb: CodeBuilder): void {
  for (const e of entries) {
    if (e.sigDefault !== undefined) {
      cb.line(`${e.name}: ${e.sigType} = ${e.sigDefault},`);
    } else {
      cb.line(`${e.name}: ${e.sigType},`);
    }
  }
}

/** Emit `@param <name> <doc>` JSDoc lines (trimmed empty docs) for each entry. */
function emitJsDocParams(
  entries: readonly { name: string; doc?: string }[],
  cb: CodeBuilder,
): void {
  for (const e of entries) {
    cb.line(` * @param ${e.name} ${e.doc ?? ""}`.trimEnd());
  }
}

/**
 * Emit the `<tool>Params(...)` factory: a kwarg-style builder for the params
 * object. Non-optional fields (required, and defaulted scalars whose default
 * lives on the signature) are always set in the literal. Every optional field is
 * set conditionally when not null - including optional-with-default ones: their
 * value type is `T | null` (the omit sentinel) but the dict field is the
 * non-null `T?`, so a bare literal assignment of a possibly-null value would not
 * type-check. When the caller omits the arg, the signature default (a concrete
 * non-null value) flows through the guard and is written.
 */
export function emitParamsFactory(
  entries: readonly SigEntry[],
  funcName: string,
  paramsType: string,
  typeTag: string | undefined,
  cb: CodeBuilder,
): void {
  // JSDoc
  cb.line("/**");
  cb.line(" * Build parameters.");
  if (entries.length > 0) cb.line(" *");
  emitJsDocParams(entries, cb);
  cb.line(" *");
  cb.line(" * @returns Parameter object.");
  cb.line(" */");

  if (entries.length === 0) {
    cb.line(`export function ${funcName}(): ${paramsType} {`);
  } else {
    cb.line(`export function ${funcName}(`);
    cb.indent(() => emitSigParams(entries, cb));
    cb.line(`): ${paramsType} {`);
  }
  cb.indent(() => {
    cb.line(`const params: ${paramsType} = {`);
    cb.indent(() => {
      if (typeTag !== undefined) cb.line(`"@type": ${JSON.stringify(typeTag)},`);
      for (const e of entries) {
        if (!e.isOptional) {
          cb.line(`${tsObjKey(e.wireKey)}: ${e.name},`);
        }
      }
    });
    cb.line("};");
    for (const e of entries) {
      if (e.isOptional) {
        cb.line(`if (${e.name} !== null) {`);
        cb.indent(() => cb.line(`${tsPropAccess("params", e.wireKey)} = ${e.name};`));
        cb.line("}");
      }
    }
    cb.line("return params;");
  });
  cb.line("}");
}

/**
 * Emit the user-facing kwarg wrapper: takes the same kwargs as the factory
 * plus `runner`, builds the params object, and delegates to the dict-style
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
  const appDoc = ctx.app?.doc;
  cb.line("/**");
  if (appDoc?.title) cb.line(` * ${appDoc.title}`);
  if (appDoc?.description) {
    if (appDoc?.title) cb.line(" *");
    cb.line(` * ${appDoc.description}`);
  }
  if (appDoc?.authors?.length) {
    cb.line(" *");
    cb.line(` * Author: ${appDoc.authors.join(", ")}`);
  }
  if (appDoc?.urls?.length) {
    cb.line(" *");
    cb.line(` * URL: ${appDoc.urls[0]}`);
  }
  cb.line(" *");
  emitJsDocParams(
    [...entries, { name: "runner", doc: "Command runner (defaults to global runner)." }],
    cb,
  );
  cb.line(" *");
  cb.line(
    outputsType
      ? " * @returns Tool outputs (paths to files produced by the tool)."
      : " * @returns void",
  );
  cb.line(" */");

  const returnType = outputsType ?? "void";
  cb.line(`export function ${funcName}(`);
  cb.indent(() => {
    emitSigParams(entries, cb);
    cb.line("runner: Runner | null = null,");
  });
  cb.line(`): ${returnType} {`);

  cb.indent(() => {
    if (entries.length === 0) {
      cb.line(`const params = ${paramsFnName}();`);
    } else {
      cb.line(`const params = ${paramsFnName}(`);
      cb.indent(() => {
        for (const e of entries) cb.line(`${e.name},`);
      });
      cb.line(");");
    }
    if (outputsType) {
      cb.line(`return ${executeFnName}(params, runner);`);
    } else {
      cb.line(`${executeFnName}(params, runner);`);
    }
  });
  cb.line("}");
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
  const appDoc = ctx.app?.doc;
  const docLines: string[] = [];
  if (appDoc?.title) docLines.push(appDoc.title);
  if (appDoc?.description) {
    if (docLines.length > 0) docLines.push("");
    docLines.push(appDoc.description);
  }
  if (appDoc?.authors?.length) {
    docLines.push("");
    docLines.push(`Author: ${appDoc.authors.join(", ")}`);
  }
  if (appDoc?.urls?.length) {
    docLines.push("");
    docLines.push(`URL: ${appDoc.urls[0]}`);
  }

  const emitOutputs = outputsFunc !== undefined;

  if (docLines.length > 0) {
    cb.line("/**");
    for (const line of docLines) {
      cb.line(` * ${line}`);
    }
    cb.line(" *");
    cb.line(" * @param params - The parameters.");
    cb.line(" * @param runner - Command runner (defaults to global runner).");
    if (emitOutputs) cb.line(" * @returns Tool outputs (paths to files produced by the tool).");
    cb.line(" */");
  }

  const returnType = emitOutputs && outputsType ? outputsType : "void";
  cb.line(
    `export function ${funcName}(params: ${paramsType}, runner: Runner | null = null): ${returnType} {`,
  );
  cb.indent(() => {
    // Validate the params object first (the kwarg wrapper delegates here, so it
    // gets validation transitively; the statically-typed kwargs don't need it).
    if (validateFunc) cb.line(`${validateFunc}(params);`);
    cb.line("runner = runner ?? getGlobalRunner();");
    cb.line(`const execution = runner.startExecution(${metaConst});`);
    cb.line("execution.params(params);");
    // Local names `args`/`out` avoid colliding with the module-level `cargs` /
    // `outputs` functions when they share generic names.
    cb.line(`const args = ${cargsFunc}(params, execution);`);
    if (emitOutputs) {
      cb.line(`const out = ${outputsFunc}(params, execution);`);
      const { stdout, stderr } = streams;
      if (stdout || stderr) {
        // run(cargs, handleStdout?, handleStderr?): pass `undefined` for an
        // absent stdout handler so a stderr-only handler lands in position 3.
        const runArgs = ["args"];
        runArgs.push(
          stdout ? `(s: string): void => { ${tsPropAccess("out", stdout)}.push(s); }` : "undefined",
        );
        if (stderr) {
          runArgs.push(`(s: string): void => { ${tsPropAccess("out", stderr)}.push(s); }`);
        }
        cb.line(`execution.run(${runArgs.join(", ")});`);
      } else {
        cb.line("execution.run(args);");
      }
      cb.line("return out;");
    } else {
      cb.line("execution.run(args);");
    }
  });
  cb.line("}");
}
