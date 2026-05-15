import type { BoundType } from "../../bindings/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
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

/** Are all characters in `s` valid in a Python identifier (and `s[0]` not a digit)? */
function isPyIdent(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/**
 * Emit the python source for one struct as a TypedDict. Uses functional syntax
 * if any field name is not a Python identifier (e.g. `@type` discriminators);
 * otherwise uses class syntax for readability.
 */
function emitStructTypedDict(
  name: string,
  type: Extract<BoundType, { kind: "struct" }>,
  ctx: CodegenContext,
  resolve: (t: BoundType) => string | undefined,
  cb: CodeBuilder,
): void {
  const fieldInfo = collectFieldInfo(ctx, type);
  const entries = Object.entries(type.fields);
  // @type literal fields are special: they're not user-provided regular fields
  // but discriminator values. Other literals are skipped (they have no runtime
  // representation in the dict).
  const hasNonIdentKey = entries.some(([k, v]) => {
    if (v.kind === "literal") return k === "@type";
    return !isPyIdent(k);
  });

  // Compute the typed entry list (skipping non-discriminator literals).
  const typedEntries: Array<{ key: string; type: string; doc?: string }> = [];
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
): void {
  const resolve = resolveTypeName(namedTypes);

  // Python evaluates type expressions eagerly (no hoisting like TS), so we
  // emit declarations in reverse-discovery order: leaves before roots. The
  // walker pushes parents before children, so reversing yields a topological
  // order suitable for evaluation.
  const ordered = [...typeDecls].reverse();

  for (const { name, type } of ordered) {
    if (type.kind === "struct") {
      emitStructTypedDict(name, type, ctx, resolve, cb);
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
  cb: CodeBuilder,
): void {
  const emitOutputs = outputsFunc !== undefined;
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
  docLines.push("");
  docLines.push("Args:");
  docLines.push("    params: The parameters.");
  docLines.push("    runner: Command runner (defaults to global runner).");
  docLines.push("");
  docLines.push("Returns:");
  docLines.push(emitOutputs ? "    Tool outputs (paths to files produced by the tool)." : "    None.");

  const returnType = emitOutputs ? "Outputs" : "None";
  cb.line(
    `def ${funcName}(params: ${paramsType}, runner: Runner | None = None) -> ${returnType}:`,
  );
  cb.indent(() => {
    cb.line(`"""`);
    for (const line of docLines) cb.line(line);
    cb.line(`"""`);
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
