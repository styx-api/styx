import type { AppMeta } from "../../ir/index.js";
import type { CodegenContext, PackageMeta, ProjectMeta } from "../../manifest/index.js";
import type { AppEntrypoint, Backend, EmitResult, EmittedApp, EmittedPackage } from "../backend.js";
import { CodeBuilder } from "../code-builder.js";
import { generatePackageJson, generateRootIndex, generateTsconfig } from "./packaging.js";
import { Scope } from "../scope.js";
import { camelCase, pascalCase, screamingSnakeCase, snakeCase } from "../string-case.js";
import { buildSigEntries } from "../sig-entries.js";
import {
  emitBuildCargs,
  emitImports,
  emitKwargWrapper,
  emitMetadata,
  emitParamsFactory,
  emitTypeDeclarations,
  emitWrapperFunction,
  tsScrubIdent,
  tsSigOptions,
} from "./emit.js";
import { collectFieldInfo } from "./types.js";
import { emitValidate } from "./validate-emit.js";
import {
  emitBuildOutputs,
  emitOutputsInterface,
  emitStripExtensionsHelper,
  needsStripExtensionsHelper,
  streamFieldIds,
} from "./outputs-emit.js";
import { mapType } from "./typemap.js";
import { collectNamedTypes, resolveTypeName, structKey, unionKey } from "./types.js";

const TS_RESERVED: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "type",
  // Not keywords, but forbidden as binding names in strict mode (ES modules are
  // always strict), so a parameter/local named these is a hard error.
  "arguments",
  "eval",
  "await",
]);

/**
 * Per-tool public symbol names emitted directly in the flat tool file. Wrapper
 * and function names use camelCase; type names use PascalCase; the metadata
 * constant uses SCREAMING_SNAKE_CASE.
 */
export interface PublicNames {
  params: string;
  outputs: string;
  metadata: string;
  cargs: string;
  outputsFn: string;
  paramsFn: string;
  execute: string;
  validate: string;
  wrapper: string;
}

/** Public-name scheme used by the TypeScript backend. Exported so the CLI and tests can use it. */
export function computePublicNames(appId: string | undefined): PublicNames {
  if (!appId) {
    return {
      params: "Params",
      outputs: "Outputs",
      metadata: "METADATA",
      cargs: "cargs",
      outputsFn: "outputs",
      paramsFn: "buildParams",
      execute: "execute",
      validate: "validate",
      wrapper: "run",
    };
  }
  // Pre-scrub digit-leading ids so derived case forms produce valid
  // identifiers in a consistent case.
  const id = /^[0-9]/.test(appId) ? "v_" + appId : appId;
  return {
    params: pascalCase(id),
    outputs: pascalCase(id) + "Outputs",
    metadata: screamingSnakeCase(id) + "_METADATA",
    cargs: camelCase(id) + "_cargs",
    outputsFn: camelCase(id) + "_outputs",
    paramsFn: camelCase(id) + "Params",
    execute: camelCase(id) + "Execute",
    validate: camelCase(id) + "Validate",
    wrapper: camelCase(id),
  };
}

export function generateTypeScript(ctx: CodegenContext, packageScope?: Scope): string {
  const cb = new CodeBuilder("  ");
  // A package-shared scope keeps top-level names unique across every tool in the
  // suite barrel; without one (standalone emit) a per-tool scope is enough.
  const scope = packageScope ?? new Scope(TS_RESERVED);

  const appId = ctx.app?.id;
  const pkg = ctx.package?.name ?? "unknown";
  const publicNames = computePublicNames(appId);

  const rootBinding = ctx.resolve(ctx.expr);
  const rootType = rootBinding?.type ?? { kind: "struct" as const, fields: {} };
  // Only treat the root as struct-shaped when there's a real binding. A
  // synthesized empty-struct fallback (no root binding) means the solver
  // collapsed everything away, so the kwarg wrapper has nothing to wrap.
  const rootIsStruct = rootBinding?.type.kind === "struct";

  // Pre-reserve module-level public names so any IR-derived names colliding
  // with them get suffix-bumped. `params` is intentionally NOT pre-reserved -
  // `collectNamedTypes` claims it for the root struct just below. Each name
  // is scrubbed through `tsScrubIdent` first since the case helpers happily
  // pass through digit-leading app ids.
  const reg = (name: string) => scope.add(tsScrubIdent(name, TS_RESERVED));
  const names = {
    params: tsScrubIdent(publicNames.params, TS_RESERVED),
    outputs: reg(publicNames.outputs),
    metadata: reg(publicNames.metadata),
    cargs: reg(publicNames.cargs),
    outputsFn: reg(publicNames.outputsFn),
    paramsFn: rootIsStruct ? reg(publicNames.paramsFn) : "",
    execute: rootIsStruct ? reg(publicNames.execute) : "",
    validate: reg(publicNames.validate),
    wrapper: reg(publicNames.wrapper),
  };

  // Prefix nested type names with the tool's root name so a suite's flat barrel
  // doesn't collide same-named types (e.g. `Outputtype`) across tools.
  const { namedTypes, typeDecls } = collectNamedTypes(
    rootType,
    names.params,
    scope,
    pascalCase,
    appId ? names.params : "",
  );

  const rootName =
    (rootType.kind === "struct" ? namedTypes.get(structKey(rootType)) : undefined) ??
    (rootType.kind === "union" ? namedTypes.get(unionKey(rootType)) : undefined) ??
    names.params;
  names.params = rootName;

  // Auto-generated header.
  cb.comment("This file was auto generated by Styx.");
  cb.comment("Do not edit this file directly.");
  cb.blank();

  // Every tool emits an Outputs object: at minimum the synthetic `root` output
  // directory (outputFile(".")), plus any declared file/mutable outputs and
  // stdout/stderr stream fields. OutputPathType is therefore always imported.
  const emitOutputs = true;

  emitImports(cb, true);
  cb.blank();

  emitMetadata(ctx, names.metadata, cb);
  cb.blank();

  emitTypeDeclarations(typeDecls, namedTypes, ctx, names.params, appId, pkg, cb);

  if (emitOutputs) {
    emitOutputsInterface(ctx, names.outputs, cb);
    cb.blank();
  }

  const paramsType =
    rootType.kind === "struct" || rootType.kind === "union"
      ? names.params
      : mapType(rootType, resolveTypeName(namedTypes));

  if (emitOutputs && needsStripExtensionsHelper(ctx)) {
    emitStripExtensionsHelper(cb);
    cb.blank();
  }

  // Build the per-field SigEntry list once - the factory and kwarg wrapper
  // both consume it, so the host names registered here must satisfy both
  // function scopes. Pre-reserve `params` (factory + wrapper body) and
  // `runner` (wrapper signature) so a wire key matching either gets
  // suffix-bumped. `rootType.kind === "struct"` check satisfies the `Extract`
  // constraint when `rootIsStruct` is true.
  const rootTypeTag = appId ? `${pkg}/${appId}` : undefined;
  const sigScope = scope.child(["params", "runner"]);
  const sigEntries =
    rootIsStruct && rootType.kind === "struct"
      ? buildSigEntries(
          rootType,
          collectFieldInfo(ctx, rootType),
          (wireKey) => sigScope.add(tsScrubIdent(wireKey, TS_RESERVED)),
          tsSigOptions(resolveTypeName(namedTypes)),
        )
      : [];

  // Params factory (struct-rooted tools only): a kwarg-style builder for the
  // params object. Useful for callers that want to build a params object to
  // mutate before executing.
  if (rootIsStruct) {
    emitParamsFactory(sigEntries, names.paramsFn, paramsType, rootTypeTag, cb);
    cb.blank();
  }

  // Validation: walks the root binding and throws StyxValidationError on bad
  // input. Called first thing in the dict-style execute (below).
  emitValidate(
    ctx,
    rootType,
    ctx.expr,
    paramsType,
    names.validate,
    resolveTypeName(namedTypes),
    scope,
    cb,
  );
  cb.blank();

  emitBuildCargs(ctx, rootType, paramsType, names.cargs, cb);
  cb.blank();

  if (emitOutputs) {
    emitBuildOutputs(ctx, paramsType, names.outputs, names.outputsFn, cb);
    cb.blank();
  }

  // Dict-style execute function. For struct roots it's the internal
  // `<tool>Execute`; for other roots it doubles as the user-facing wrapper.
  const executeName = rootIsStruct ? names.execute : names.wrapper;
  emitWrapperFunction(
    ctx,
    paramsType,
    executeName,
    names.metadata,
    names.cargs,
    emitOutputs ? names.outputsFn : undefined,
    emitOutputs ? names.outputs : undefined,
    names.validate,
    streamFieldIds(ctx),
    cb,
  );
  cb.blank();

  // Kwarg-style wrapper (struct roots only): the v1-parity user-facing entry.
  if (rootIsStruct) {
    emitKwargWrapper(
      ctx,
      sigEntries,
      names.wrapper,
      names.paramsFn,
      names.execute,
      emitOutputs ? names.outputs : undefined,
      cb,
    );
    cb.blank();
  }

  return cb.toString();
}

/**
 * Module name (file stem) for an app: snake_case of app.id, fallback `output`.
 * Scrubbed so digit-leading app ids (e.g. `3dPFM` -> `v_3d_pfm`) and keyword
 * collisions don't break `export * from "./<mod>.js"` in the package index.
 */
export function appModuleName(meta: AppMeta | undefined): string {
  if (!meta?.id) return "output";
  return tsScrubIdent(snakeCase(meta.id), TS_RESERVED);
}

/**
 * The dispatch entrypoint for one app: its root `@type` (`<package>/<app>`) and
 * the dict-style execute function name. Returns undefined when the id or package
 * is unknown (no stable `@type`), so the app is left out of the suite dispatcher.
 */
export function appEntrypoint(ctx: CodegenContext): AppEntrypoint | undefined {
  const appId = ctx.app?.id;
  const pkg = ctx.package?.name;
  if (!appId || !pkg) return undefined;
  const publicNames = computePublicNames(appId);
  const rootIsStruct = ctx.resolve(ctx.expr)?.type.kind === "struct";
  const executeFn = tsScrubIdent(
    rootIsStruct ? publicNames.execute : publicNames.wrapper,
    TS_RESERVED,
  );
  return { type: `${pkg}/${appId}`, executeFn };
}

/**
 * Generate the suite-level `index.ts` re-export for a package containing
 * multiple tool modules. Each tool module's public symbols are surfaced via
 * `export * from "./bet.js"`. When apps carry a dispatch entrypoint, a
 * suite-level `execute(params, runner)` is appended that routes a config object
 * to the right tool by its root `@type`.
 */
export function generatePackageIndex(apps: EmittedApp[]): string {
  const cb = new CodeBuilder("  ");
  cb.comment("This file was auto generated by Styx.");
  cb.comment("Do not edit this file directly.");
  cb.blank();

  const sortedApps = [...apps].sort((a, b) =>
    appModuleName(a.meta).localeCompare(appModuleName(b.meta)),
  );
  const dispatch = sortedApps
    .map((a) => ({ entry: a.entrypoint, mod: appModuleName(a.meta) }))
    .filter((x): x is { entry: AppEntrypoint; mod: string } => x.entry !== undefined);

  if (dispatch.length > 0) {
    cb.line(`import type { Runner } from "styxdefs";`);
    for (const d of dispatch) {
      cb.line(`import { ${d.entry.executeFn} } from "./${d.mod}.js";`);
    }
    cb.blank();
  }

  for (const mod of sortedApps.map((a) => appModuleName(a.meta))) {
    cb.line(`export * from "./${mod}.js";`);
  }

  if (dispatch.length > 0) {
    cb.blank();
    emitPackageDispatch(
      cb,
      dispatch.map((d) => d.entry),
    );
  }

  return cb.toString();
}

/** Emit the suite-level `execute(params, runner)` dispatcher over `@type`. */
function emitPackageDispatch(cb: CodeBuilder, dispatch: AppEntrypoint[]): void {
  cb.line("/**");
  cb.line(" * Run a tool in this package from a params object, routed by its `@type`.");
  cb.line(" */");
  cb.line(
    `export function execute(params: { "@type": string }, runner: Runner | null = null): unknown {`,
  );
  cb.indent(() => {
    cb.line("const dispatch: Record<string, (params: any, runner: Runner | null) => unknown> = {");
    cb.indent(() => {
      for (const e of dispatch) {
        cb.line(`${JSON.stringify(e.type)}: ${e.executeFn},`);
      }
    });
    cb.line("};");
    cb.line(`const fn = dispatch[params["@type"]];`);
    cb.line("if (fn === undefined) {");
    cb.indent(() => {
      cb.line("throw new Error(`No tool registered for @type '${params[\"@type\"]}'`);");
    });
    cb.line("}");
    cb.line("return fn(params, runner);");
  });
  cb.line("}");
}

export class TypeScriptBackend implements Backend {
  readonly name = "typescript";
  readonly target = "typescript";

  emitApp(ctx: CodegenContext, scope?: Scope): EmittedApp {
    const code = generateTypeScript(ctx, scope);
    const fileName = `${appModuleName(ctx.app)}.ts`;
    return {
      meta: ctx.app,
      entrypoint: appEntrypoint(ctx),
      files: new Map([[fileName, code]]),
      errors: [],
      warnings: [],
    };
  }

  newPackageScope(): Scope {
    return new Scope(TS_RESERVED);
  }

  emitPackage(pkg: PackageMeta, apps: EmittedApp[]): EmittedPackage {
    return {
      meta: pkg,
      files: new Map([["index.ts", generatePackageIndex(apps)]]),
      errors: [],
      warnings: [],
    };
  }

  emitProject(proj: ProjectMeta, packages: EmittedPackage[]): EmitResult {
    return {
      files: new Map([
        ["package.json", generatePackageJson(proj)],
        ["index.ts", generateRootIndex(packages)],
        ["tsconfig.json", generateTsconfig()],
      ]),
      errors: [],
      warnings: [],
    };
  }
}
