import type { BoundType } from "../../bindings/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import type { ArgResult } from "./arg-builder.js";
import { buildArgs, resultToStmt } from "./arg-builder.js";
import { mapType } from "./typemap.js";
import type { NamedType } from "./types.js";
import { collectFieldInfo, resolveTypeName } from "./types.js";

export function emitJsDoc(cb: CodeBuilder, description?: string): void {
  if (!description) return;
  const lines = description.split("\n");
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

export function emitImports(cb: CodeBuilder, emitOutputs: boolean): void {
  const inputs = ["Runner", "Execution", "Metadata", "InputPathType"];
  if (emitOutputs) inputs.push("OutputPathType");
  cb.line(`import type { ${inputs.join(", ")} } from "styxdefs";`);
  cb.line('import { getGlobalRunner } from "styxdefs";');
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
    if (ctx.app?.container?.image) {
      cb.line(`container_image_tag: ${JSON.stringify(ctx.app.container.image)},`);
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
        // Emit @type discriminator on root params interface
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

          const hasDefault = fi?.defaultValue !== undefined;
          const isOptional = fieldType.kind === "optional";
          const optional = isOptional || hasDefault ? "?" : "";

          const mapped =
            fieldType.kind === "optional"
              ? mapType(fieldType.inner, resolve) + " | null"
              : mapType(fieldType, resolve);
          cb.line(`${fieldName}${optional}: ${mapped};`);
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
    cb.line("runner = runner ?? getGlobalRunner();");
    cb.line(`const execution = runner.startExecution(${metaConst});`);
    cb.line("execution.params(params);");
    // Local names `args`/`out` avoid colliding with the module-level `cargs` /
    // `outputs` functions when they share generic names.
    cb.line(`const args = ${cargsFunc}(params, execution);`);
    if (emitOutputs) {
      cb.line(`const out = ${outputsFunc}(params, execution);`);
      cb.line("execution.run(args);");
      cb.line("return out;");
    } else {
      cb.line("execution.run(args);");
    }
  });
  cb.line("}");
}
