import type { BoundType } from "../../bindings/index.js";
import type { AppMeta } from "../../ir/index.js";
import type { CodegenContext, PackageMeta, ProjectMeta } from "../../manifest/index.js";
import type {
  AppEntrypoint,
  Backend,
  EmitResult,
  EmittedApp,
  EmittedPackage,
  EmitWarning,
} from "../backend.js";
import type { SigEntry } from "../sig-entries.js";
import type { NamedType } from "./types.js";
import {
  generateRequirementsTxt,
  generateRootInitPy,
  generateRootPyproject,
  generateRootReadme,
  generateSubPyproject,
  generateSubReadme,
  pyDistName,
} from "./packaging.js";
import { CodeBuilder } from "../code-builder.js";
import { Scope } from "../scope.js";
import { pascalCase, screamingSnakeCase, snakeCase } from "../string-case.js";
import { buildSigEntries } from "../sig-entries.js";
import {
  emitBuildCargs,
  emitImports,
  emitKwargWrapper,
  emitMetadata,
  emitParamsFactory,
  emitTypeDeclarations,
  emitWrapperFunction,
  pyScrubIdent,
  pySigOptions,
} from "./emit.js";
import { collectFieldInfo } from "./types.js";
import { emitValidate } from "./validate-emit.js";
import {
  emitBuildOutputs,
  emitOutputsClass,
  emitStripExtensionsHelper,
  needsStripExtensionsHelper,
  streamFieldIds,
} from "./outputs-emit.js";
import { mapType } from "./typemap.js";
import { collectNamedTypes, resolveTypeName, structKey, unionKey } from "./types.js";

// Python reserved words + commonly-shadowed built-ins. Used to avoid collisions
// when generating identifiers. Includes keywords, common stdlib builtins, and
// the styxdefs symbols we emit/import.
const PY_RESERVED: ReadonlySet<string> = new Set([
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
  // Common builtins to avoid shadowing.
  "list",
  "dict",
  "tuple",
  "set",
  "int",
  "float",
  "str",
  "bool",
  "type",
  "print",
  "open",
  "input",
  "range",
  "len",
  "id",
  "object",
  "Exception",
  "ValueError",
  "TypeError",
  // styxdefs symbols we emit/import.
  "Runner",
  "Execution",
  "Metadata",
  "InputPathType",
  "OutputPathType",
  "get_global_runner",
  "dataclasses",
  "typing",
]);

/**
 * Per-tool public symbol names. With the flat `fsl/bet.py` layout each tool
 * file emits these names directly - there is no internal/public alias split.
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

/** Public-name scheme used by the Python backend. Exported so the CLI and tests can use it. */
export function computePublicNames(appId: string | undefined): PublicNames {
  if (!appId) {
    return {
      params: "Params",
      outputs: "Outputs",
      metadata: "METADATA",
      cargs: "cargs",
      outputsFn: "outputs",
      paramsFn: "build_params",
      execute: "execute",
      validate: "validate",
      wrapper: "run",
    };
  }
  // Pre-scrub digit-leading ids (e.g. `3dPFM`) so all derived case forms
  // produce valid Python identifiers in a consistent case (matches v1's
  // `V_3D_PFM_METADATA` / `v_3d_pfm` style instead of mixed `v_3D_PFM`).
  const id = /^[0-9]/.test(appId) ? "v_" + appId : appId;
  return {
    params: pascalCase(id),
    outputs: pascalCase(id) + "Outputs",
    metadata: screamingSnakeCase(id) + "_METADATA",
    cargs: snakeCase(id) + "_cargs",
    outputsFn: snakeCase(id) + "_outputs",
    paramsFn: snakeCase(id) + "_params",
    execute: snakeCase(id) + "_execute",
    validate: snakeCase(id) + "_validate",
    wrapper: snakeCase(id),
  };
}

/**
 * A kwarg `_params` builder for one nested (non-root) struct - a union variant
 * or a plain nested sub-struct. Lets callers write
 * `output=tool_corrected_output_params(...)` instead of hand-authoring a
 * `{"@type": ...}` dict. The root struct's factory is `names.paramsFn`; this
 * covers everything below it.
 */
export interface NestedFactory {
  /** The struct's TypedDict name (factory return + `params` annotation type). */
  typeName: string;
  /** Structural identity key of the struct - used by the snippet renderer to
   * route a nested struct value to its factory. */
  structKey: string;
  /** Registered factory function name (e.g. `tool_corrected_output_params`). */
  funcName: string;
  /** The struct's `@type` discriminator, injected by the factory; undefined for
   * a plain sub-struct that carries no discriminator. */
  typeTag: string | undefined;
  /** Per-field signature entries (shared with the snippet renderer). */
  sigEntries: SigEntry[];
}

/**
 * The fully-derived naming/typing model for one tool's Python emission. Computed
 * once by `buildEmitModel` so the file emitter and the call-site snippet renderer
 * share the exact same public names, scrubbed kwarg names, and root typing - the
 * snippet must match the function the generated code actually exposes.
 */
export interface PyEmitModel {
  appId: string | undefined;
  pkg: string | undefined;
  names: {
    params: string;
    outputs: string;
    metadata: string;
    cargs: string;
    outputsFn: string;
    paramsFn: string;
    execute: string;
    validate: string;
    wrapper: string;
  };
  rootType: BoundType;
  rootIsStruct: boolean;
  namedTypes: Map<string, string>;
  typeDecls: NamedType[];
  rootTypeTag: string | undefined;
  paramsType: string;
  sigEntries: SigEntry[];
  nestedFactories: NestedFactory[];
}

/**
 * Derive the public names, named-type declarations, root typing, and per-field
 * signature entries for one tool. Mutates `scope` exactly as the emitter needs
 * (the `reg` registrations and the `sigScope` child), so passing the same scope
 * the emitter continues with keeps later local registrations consistent.
 */
export function buildEmitModel(
  ctx: CodegenContext,
  scope: Scope = new Scope(PY_RESERVED),
): PyEmitModel {
  const appId = ctx.app?.id;
  const pkg = ctx.package?.name;
  const publicNames = computePublicNames(appId);

  const rootBinding = ctx.resolve(ctx.expr);
  const rootType: BoundType = rootBinding?.type ?? { kind: "struct", fields: {} };
  // Only treat the root as struct-shaped when there's a real binding. A
  // synthesized empty-struct fallback (no root binding) means the solver
  // collapsed everything away, so the kwarg wrapper has nothing to wrap.
  const rootIsStruct = rootBinding?.type.kind === "struct";

  // Pre-reserve module-level public names so any IR-derived names colliding
  // with them get suffix-bumped. `params` is intentionally NOT pre-reserved -
  // `collectNamedTypes` claims it for the root struct just below. Each name
  // is scrubbed through `pyScrubIdent` first since the case helpers happily
  // pass through digit-leading app ids like `3dvolreg.afni`.
  const reg = (name: string) => scope.add(pyScrubIdent(name, PY_RESERVED));
  const names = {
    params: pyScrubIdent(publicNames.params, PY_RESERVED),
    outputs: reg(publicNames.outputs),
    metadata: reg(publicNames.metadata),
    cargs: reg(publicNames.cargs),
    outputsFn: reg(publicNames.outputsFn),
    paramsFn: rootIsStruct ? reg(publicNames.paramsFn) : "",
    execute: rootIsStruct ? reg(publicNames.execute) : "",
    validate: reg(publicNames.validate),
    wrapper: reg(publicNames.wrapper),
  };

  // Prefix nested type names with the tool's root name so a suite's flat
  // `from .x import *` re-exports don't shadow same-named types across tools.
  const { namedTypes, typeDecls } = collectNamedTypes(
    rootType,
    names.params,
    scope,
    pascalCase,
    appId ? names.params : "",
  );

  names.params =
    (rootType.kind === "struct" ? namedTypes.get(structKey(rootType)) : undefined) ??
    (rootType.kind === "union" ? namedTypes.get(unionKey(rootType)) : undefined) ??
    names.params;

  // Tag injected as `@type: Literal[...]` on the root TypedDict (and as a
  // constant key by the params factory). Skipped when appId/pkg aren't known.
  const rootTypeTag = appId && pkg ? `${pkg}/${appId}` : undefined;

  const paramsType =
    rootType.kind === "struct" || rootType.kind === "union"
      ? names.params
      : mapType(rootType, resolveTypeName(namedTypes));

  // Host kwarg names are snake_cased so a tool's signature reads idiomatically
  // (`corrected_output_file_name=`) regardless of how the descriptor authored
  // the wire id (camelCase Boutiques sub-ids, etc.); the dict key keeps the
  // original wire name, so this divergence is the same one as `float` ->
  // `float_`. Scrubbed for validity / reserved words, then deduped through the
  // function scope. Shared by the root wrapper and every nested factory so they
  // stay in lockstep.
  const hostName = (childScope: Scope, wireKey: string): string =>
    childScope.add(pyScrubIdent(snakeCase(wireKey), PY_RESERVED));

  // Build the per-field SigEntry list once - the factory and kwarg wrapper
  // both consume it, so the host names registered here must satisfy both
  // function scopes. Pre-reserve `params` (factory + wrapper body) and
  // `runner` (wrapper signature) so a wire key matching either gets
  // suffix-bumped. `rootType` is narrowed by `rootIsStruct` for the `Extract`
  // constraint.
  const resolve = resolveTypeName(namedTypes);
  const sigScope = scope.child(["params", "runner"]);
  const sigEntries =
    rootIsStruct && rootType.kind === "struct"
      ? buildSigEntries(
          rootType,
          collectFieldInfo(ctx, rootType),
          (wireKey) => hostName(sigScope, wireKey),
          pySigOptions(resolve),
        )
      : [];

  // Nested-struct factories: every non-root struct (union variants and plain
  // nested sub-structs, all already collected into `typeDecls`) gets a kwarg
  // `_params` builder so callers don't have to hand-author `{"@type": ...}`
  // dicts. Unions are bare type aliases (the caller picks a variant), so only
  // struct decls get a factory. The factory name is derived from the
  // (already tool-prefixed, unique) TypedDict name and registered in the shared
  // scope so it stays unique across the suite's flat `from .x import *`.
  //
  // Why this is Python-only (the TypeScript backend keeps nested objects as
  // inline literals): a nested object literal is idiomatic, well-typed API
  // design in TypeScript, but in Python it reads as an untyped dict blob.
  // niwrap's Python audience has used the factory-builder pattern since v1
  // (`tool_sub_params(...)`), so emitting these factories restores the
  // convention downstream users expect rather than forcing raw tagged dicts.
  // The two backends deliberately diverge here; see `structConstructor` in
  // snippet-core for the matching seam on the snippet side.
  const rootStructKey =
    rootIsStruct && rootType.kind === "struct" ? structKey(rootType) : undefined;
  const nestedFactories: NestedFactory[] = [];
  for (const decl of typeDecls) {
    if (decl.type.kind !== "struct") continue;
    const sKey = structKey(decl.type);
    if (sKey === rootStructKey) continue; // root already has its `_params` factory
    const funcName = scope.add(pyScrubIdent(snakeCase(decl.name) + "_params", PY_RESERVED));
    // Union variants carry their discriminator as a required `@type` literal
    // field; the factory injects it. A plain nested sub-struct has none.
    //
    // The `string` narrowing is total in practice, not a silent drop: the
    // solver always builds `@type` from a variant's string `name`, so the
    // literal value is invariably a string. (If a numeric `@type` ever slipped
    // through, `emitStructTypedDict` would still emit it as a required
    // `Literal[<n>]` field, so the un-injected dict would fail the mypy --strict
    // codegen gate rather than miscompile silently.)
    const atType = decl.type.fields["@type"];
    const typeTag =
      atType && atType.kind === "literal" && typeof atType.value === "string"
        ? atType.value
        : undefined;
    const factoryScope = scope.child(["params"]);
    const factorySig = buildSigEntries(
      decl.type,
      collectFieldInfo(ctx, decl.type),
      (wireKey) => hostName(factoryScope, wireKey),
      pySigOptions(resolve),
    );
    nestedFactories.push({
      typeName: decl.name,
      structKey: sKey,
      funcName,
      typeTag,
      sigEntries: factorySig,
    });
  }

  return {
    appId,
    pkg,
    names,
    rootType,
    rootIsStruct,
    namedTypes,
    typeDecls,
    rootTypeTag,
    paramsType,
    sigEntries,
    nestedFactories,
  };
}

export function generatePython(ctx: CodegenContext, packageScope?: Scope): string {
  return generatePythonModule(ctx, packageScope).code;
}

/**
 * Emit the module and, alongside it, the dispatch entrypoint carrying the
 * *scope-registered* execute-function name. Computing the entrypoint here (not
 * via the scope-blind `appEntrypoint`) keeps the suite dispatcher in sync with
 * the actual emitted symbol when a shared package scope suffix-bumps a collision.
 */
function generatePythonModule(
  ctx: CodegenContext,
  packageScope?: Scope,
): { code: string; entrypoint: AppEntrypoint | undefined } {
  const cb = new CodeBuilder("    ");
  // A package-shared scope keeps top-level names unique across every tool in the
  // suite's `from .x import *` re-exports; without one a per-tool scope suffices.
  const scope = packageScope ?? new Scope(PY_RESERVED);

  const {
    names,
    rootType,
    rootIsStruct,
    namedTypes,
    typeDecls,
    rootTypeTag,
    paramsType,
    sigEntries,
    nestedFactories,
  } = buildEmitModel(ctx, scope);

  // Auto-generated header.
  cb.comment("This file was auto generated by Styx.", "# ");
  cb.comment("Do not edit this file directly.", "# ");
  cb.blank();

  // Every tool emits an Outputs object: at minimum the synthetic `root` output
  // directory (output_file(".")), plus any declared file/mutable outputs and
  // stdout/stderr stream fields. OutputPathType is therefore always imported.
  emitImports(cb);
  cb.blank();

  emitMetadata(ctx, names.metadata, cb);
  cb.blank();

  emitTypeDeclarations(typeDecls, namedTypes, ctx, cb, names.params, rootTypeTag);

  emitOutputsClass(ctx, names.outputs, cb);
  cb.blank();

  if (needsStripExtensionsHelper(ctx)) {
    emitStripExtensionsHelper(cb);
    cb.blank();
  }

  // Params factory (struct-rooted tools only): a kwarg-style builder for the
  // params dict. Useful for callers that want to build a dict to mutate before
  // executing.
  if (rootIsStruct) {
    emitParamsFactory(sigEntries, names.paramsFn, paramsType, rootTypeTag, cb);
    cb.blank();
  }

  // Nested-struct factories: one kwarg `_params` builder per union variant /
  // nested sub-struct, so callers can write `output=tool_x_params(...)` instead
  // of a hand-authored `{"@type": ...}` dict. Their TypedDicts are already
  // declared above (emitTypeDeclarations), so the eager annotations resolve.
  for (const nf of nestedFactories) {
    emitParamsFactory(nf.sigEntries, nf.funcName, nf.typeName, nf.typeTag, cb);
    cb.blank();
  }

  // Validation: walks the root binding and raises StyxValidationError on bad
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

  emitBuildOutputs(ctx, paramsType, names.outputs, names.outputsFn, cb);
  cb.blank();

  // Dict-style execute function. For struct roots it's the internal
  // `<tool>_execute`; for other roots it doubles as the user-facing wrapper.
  const executeName = rootIsStruct ? names.execute : names.wrapper;
  emitWrapperFunction(
    ctx,
    paramsType,
    executeName,
    names.metadata,
    names.cargs,
    names.outputsFn,
    names.outputs,
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
      names.outputs,
      cb,
    );
    cb.blank();
  }

  // `__all__` keeps suite-level `from .bet import *` from re-exporting the
  // module's stdlib/styxdefs imports.
  const publicSymbols = [
    names.params,
    names.outputs,
    names.metadata,
    names.cargs,
    names.outputsFn,
    ...(rootIsStruct ? [names.paramsFn, names.execute] : []),
    ...nestedFactories.map((nf) => nf.funcName),
    names.validate,
    names.wrapper,
  ];
  cb.line("__all__ = [");
  cb.indent(() => {
    for (const sym of publicSymbols) cb.line(`"${sym}",`);
  });
  cb.line("]");

  // `executeName` is the scope-registered symbol actually emitted above, so the
  // dispatcher references the real name even after a collision suffix-bump.
  const appId = ctx.app?.id;
  const pkg = ctx.package?.name;
  const entrypoint: AppEntrypoint | undefined =
    appId && pkg ? { type: `${pkg}/${appId}`, executeFn: executeName } : undefined;

  return { code: cb.toString(), entrypoint };
}

/**
 * Module name (file stem) for an app: snake_case of app.id, fallback `output`.
 * Scrubbed so digit-leading app ids (e.g. `3dPFM` -> `v_3d_pfm`) and keyword
 * collisions don't break `from .<mod> import *` in the package __init__.
 */
export function appModuleName(meta: AppMeta | undefined): string {
  if (!meta?.id) return "output";
  return pyScrubIdent(snakeCase(meta.id), PY_RESERVED);
}

/**
 * The dispatch entrypoint for one app: its root `@type` (`<package>/<app>`) and
 * the dict-style execute function name. Returns undefined when the id or package
 * is unknown (no stable `@type`), so the app is left out of the suite dispatcher.
 *
 * Note: this recomputes the execute name without a package scope, so it reflects
 * the un-bumped name. The emitter (`emitApp`) instead takes the entrypoint from
 * the scope-aware emit pass; use that path when a shared package scope is in play.
 */
export function appEntrypoint(ctx: CodegenContext): AppEntrypoint | undefined {
  const appId = ctx.app?.id;
  const pkg = ctx.package?.name;
  if (!appId || !pkg) return undefined;
  const publicNames = computePublicNames(appId);
  const rootIsStruct = ctx.resolve(ctx.expr)?.type.kind === "struct";
  const executeFn = pyScrubIdent(
    rootIsStruct ? publicNames.execute : publicNames.wrapper,
    PY_RESERVED,
  );
  return { type: `${pkg}/${appId}`, executeFn };
}

/**
 * Generate the suite-level `__init__.py` re-export for a package containing
 * multiple tool modules. Each tool module's public symbols are surfaced via
 * `from .bet import *` (each tool file defines `__all__`). When apps carry a
 * dispatch entrypoint, a suite-level `execute(params, runner)` is appended that
 * routes a config object to the right tool by its root `@type`.
 */
export function generatePackageInit(apps: EmittedApp[]): string {
  const cb = new CodeBuilder("    ");
  cb.comment("This file was auto generated by Styx.", "# ");
  cb.comment("Do not edit this file directly.", "# ");
  cb.blank();

  const dispatch = apps
    .map((a) => a.entrypoint)
    .filter((e): e is AppEntrypoint => e !== undefined)
    .sort((a, b) => a.type.localeCompare(b.type));

  if (dispatch.length > 0) {
    cb.line("import typing");
    cb.blank();
    cb.line("from styxdefs import Runner");
    cb.blank();
  }

  const modules = apps
    .map((a) => appModuleName(a.meta))
    .filter((name): name is string => !!name)
    .sort();

  for (const mod of modules) {
    cb.line(`from .${mod} import *`);
  }

  if (dispatch.length > 0) {
    cb.blank();
    emitPackageDispatch(cb, dispatch);
  }

  return cb.toString();
}

/** Emit the suite-level `execute(params, runner)` dispatcher over `@type`. */
function emitPackageDispatch(cb: CodeBuilder, dispatch: AppEntrypoint[]): void {
  cb.line(
    "def execute(params: dict[str, typing.Any], runner: Runner | None = None) -> typing.Any:",
  );
  cb.indent(() => {
    cb.line('"""Run a tool in this package from a params object, routed by its `@type`."""');
    cb.line("_dispatch: dict[str, typing.Callable[[typing.Any, Runner | None], typing.Any]] = {");
    cb.indent(() => {
      for (const e of dispatch) {
        cb.line(`${JSON.stringify(e.type)}: ${e.executeFn},`);
      }
    });
    cb.line("}");
    // `.get` (not `params["@type"]`) so a missing discriminant surfaces the
    // clean ValueError below instead of a bare KeyError. The `is not None` guard
    // also narrows `_type` away from None for the typed `_dispatch.get`.
    cb.line('_type = params.get("@type")');
    cb.line("_fn = _dispatch.get(_type) if _type is not None else None");
    cb.line("if _fn is None:");
    cb.indent(() => {
      cb.line(`raise ValueError(f"No tool registered for @type {_type!r}")`);
    });
    cb.line("return _fn(params, runner)");
  });
}

export class PythonBackend implements Backend {
  readonly name = "python";
  readonly target = "python";

  emitApp(ctx: CodegenContext, scope?: Scope): EmittedApp {
    // Take the entrypoint from the same pass that emitted the module, so its
    // execute-function name reflects any shared-scope suffix-bump.
    const { code, entrypoint } = generatePythonModule(ctx, scope);
    const fileName = `${appModuleName(ctx.app)}.py`;
    return {
      meta: ctx.app,
      entrypoint,
      files: new Map([[fileName, code]]),
      errors: [],
      warnings: [],
    };
  }

  newPackageScope(): Scope {
    return new Scope(PY_RESERVED);
  }

  emitPackage(pkg: PackageMeta, apps: EmittedApp[]): EmittedPackage {
    return {
      meta: pkg,
      files: new Map([
        ["__init__.py", generatePackageInit(apps)],
        // PEP 561 marker so type-checkers treat the generated suite as typed.
        ["py.typed", ""],
      ]),
      errors: [],
      warnings: [],
    };
  }

  emitProject(proj: ProjectMeta, packages: EmittedPackage[]): EmitResult {
    const files = new Map<string, string>();
    const distNames: string[] = [];
    const pkgDirs: string[] = [];
    const warnings: EmitWarning[] = [];

    // The metapackage's importable module doubles as the namespace every suite
    // nests under (`<project>.<suite>`), so `from <project> import <suite>` and
    // `<project>.use_docker()` both resolve from one shared `<project>/` package.
    // Scrub the project name to a valid, non-keyword identifier; with no project
    // name there is no namespace and suites stay top-level (matching the bare
    // distribution-name fallback in `pyDistName`).
    const nsName = proj.name && proj.name.trim() ? pyScrubIdent(proj.name, PY_RESERVED) : undefined;

    for (const p of packages) {
      const pkg = p.meta ?? {};
      // Mirror the CLI's `pkgDir` fallback so a nameless package's source dir
      // still gets a matching pyproject/README instead of being orphaned.
      const dir = pkg.name ?? "package";
      pkgDirs.push(dir);
      distNames.push(pyDistName(proj, pkg));
      // Import package: `<project>.<suite>` so it shares the metapackage's
      // namespace; setuptools maps the flat suite dir onto this dotted path.
      const importPkg = nsName ? `${nsName}.${dir}` : dir;
      files.set(`${dir}/pyproject.toml`, generateSubPyproject(proj, pkg, importPkg));
      files.set(`${dir}/README.md`, generateSubReadme(proj, pkg));
    }

    // The metapackage ships `<project>/__init__.py` (a thin styxkit re-export so
    // `<project>.use_docker()` works, PEP 561 typed) into the same `<project>/`
    // package the suites nest under. Its on-disk source dir must dodge a suite
    // named after the project (both would write `<project>/`); the import name
    // stays `<project>` via a `package-dir` remap so the namespace is preserved.
    const metaImport = nsName ?? "project";
    let metaDir = metaImport;
    if (pkgDirs.includes(metaDir)) {
      const collided = metaDir;
      while (pkgDirs.includes(metaDir)) metaDir += "_";
      warnings.push({
        message: `metapackage directory "${collided}" collides with a suite directory; emitting its sources in "${metaDir}" instead (import name stays "${metaImport}")`,
      });
    }
    files.set(`${metaDir}/__init__.py`, generateRootInitPy());
    files.set(`${metaDir}/py.typed`, "");

    files.set("pyproject.toml", generateRootPyproject(proj, distNames, metaImport, metaDir));
    files.set("README.md", generateRootReadme(proj, distNames));
    files.set("requirements.txt", generateRequirementsTxt(pkgDirs));

    return { files, errors: [], warnings };
  }
}
