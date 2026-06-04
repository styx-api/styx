import type { AppMeta } from "../../ir/index.js";
import type { CodegenContext, PackageMeta, ProjectMeta } from "../../manifest/index.js";
import type { Backend, EmitResult, EmittedApp, EmittedPackage } from "../backend.js";
import {
  generateRequirementsTxt,
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

export function generatePython(ctx: CodegenContext, packageScope?: Scope): string {
  const cb = new CodeBuilder("    ");
  // A package-shared scope keeps top-level names unique across every tool in the
  // suite's `from .x import *` re-exports; without one a per-tool scope suffices.
  const scope = packageScope ?? new Scope(PY_RESERVED);

  const appId = ctx.app?.id;
  const pkg = ctx.package?.name;
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

  // Auto-generated header.
  cb.comment("This file was auto generated by Styx.", "# ");
  cb.comment("Do not edit this file directly.", "# ");
  cb.blank();

  // Every tool emits an Outputs object: at minimum the synthetic `root` output
  // directory (output_file(".")), plus any declared file/mutable outputs and
  // stdout/stderr stream fields. OutputPathType is therefore always imported.
  const emitOutputs = true;

  emitImports(cb, true);
  cb.blank();

  emitMetadata(ctx, names.metadata, cb);
  cb.blank();

  emitTypeDeclarations(typeDecls, namedTypes, ctx, cb, names.params, rootTypeTag);

  if (emitOutputs) {
    emitOutputsClass(ctx, names.outputs, cb);
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
  // suffix-bumped. `rootType` is narrowed by `rootIsStruct` for the `Extract`
  // constraint.
  const sigScope = scope.child(["params", "runner"]);
  const sigEntries =
    rootIsStruct && rootType.kind === "struct"
      ? buildSigEntries(
          rootType,
          collectFieldInfo(ctx, rootType),
          (wireKey) => sigScope.add(pyScrubIdent(wireKey, PY_RESERVED)),
          pySigOptions(resolveTypeName(namedTypes)),
        )
      : [];

  // Params factory (struct-rooted tools only): a kwarg-style builder for the
  // params dict. Useful for callers that want to build a dict to mutate before
  // executing.
  if (rootIsStruct) {
    emitParamsFactory(sigEntries, names.paramsFn, paramsType, rootTypeTag, cb);
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

  if (emitOutputs) {
    emitBuildOutputs(ctx, paramsType, names.outputs, names.outputsFn, cb);
    cb.blank();
  }

  // Dict-style execute function. For struct roots it's the internal
  // `<tool>_execute`; for other roots it doubles as the user-facing wrapper.
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

  // `__all__` keeps suite-level `from .bet import *` from re-exporting the
  // module's stdlib/styxdefs imports.
  const publicSymbols = [
    names.params,
    ...(emitOutputs ? [names.outputs] : []),
    names.metadata,
    names.cargs,
    ...(emitOutputs ? [names.outputsFn] : []),
    ...(rootIsStruct ? [names.paramsFn, names.execute] : []),
    names.validate,
    names.wrapper,
  ];
  cb.line("__all__ = [");
  cb.indent(() => {
    for (const sym of publicSymbols) cb.line(`"${sym}",`);
  });
  cb.line("]");

  return cb.toString();
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
 * Generate the suite-level `__init__.py` re-export for a package containing
 * multiple tool modules. Each tool module's public symbols are surfaced via
 * `from .bet import *` (each tool file defines `__all__`).
 */
export function generatePackageInit(apps: EmittedApp[]): string {
  const cb = new CodeBuilder("    ");
  cb.comment("This file was auto generated by Styx.", "# ");
  cb.comment("Do not edit this file directly.", "# ");
  cb.blank();

  const modules = apps
    .map((a) => appModuleName(a.meta))
    .filter((name): name is string => !!name)
    .sort();

  for (const mod of modules) {
    cb.line(`from .${mod} import *`);
  }

  return cb.toString();
}

export class PythonBackend implements Backend {
  readonly name = "python";
  readonly target = "python";

  emitApp(ctx: CodegenContext, scope?: Scope): EmittedApp {
    const code = generatePython(ctx, scope);
    const fileName = `${appModuleName(ctx.app)}.py`;
    return {
      meta: ctx.app,
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

    for (const p of packages) {
      const pkg = p.meta ?? {};
      // Mirror the CLI's `pkgDir` fallback so a nameless package's source dir
      // still gets a matching pyproject/README instead of being orphaned.
      const dir = pkg.name ?? "package";
      pkgDirs.push(dir);
      distNames.push(pyDistName(proj, pkg));
      files.set(`${dir}/pyproject.toml`, generateSubPyproject(proj, pkg));
      files.set(`${dir}/README.md`, generateSubReadme(proj, pkg));
    }

    files.set("pyproject.toml", generateRootPyproject(proj, distNames));
    files.set("README.md", generateRootReadme(proj, distNames));
    files.set("requirements.txt", generateRequirementsTxt(pkgDirs));

    return { files, errors: [], warnings: [] };
  }
}
