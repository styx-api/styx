import type { BoundType } from "../bindings/index.js";
import type { AppMeta } from "../ir/index.js";
import type { CodegenContext, PackageMeta, ProjectMeta } from "../manifest/index.js";

export interface EmitResult {
  files: Map<string, string>;
  errors: EmitError[];
  warnings: EmitWarning[];
}

export interface EmitError {
  message: string;
}

export interface EmitWarning {
  message: string;
}

export interface EmittedApp extends EmitResult {
  meta?: AppMeta;
}

export interface EmittedPackage extends EmitResult {
  meta?: PackageMeta;
}

/**
 * A code generator for one target language. Implementations emit in up to
 * three tiers; only `emitApp` is mandatory.
 *
 * The CLI's `--mode` flag selects which tiers run: `scripts` = `emitApp` only,
 * `single` = `emitApp` + one `emitPackage`, `multi` = all three tiers.
 *
 * Paths in returned file maps are relative to the emit tier's natural root
 * (package directory for app/package emit, project root for project emit).
 * Orchestration is responsible for prefixing/merging the maps.
 */
export interface Backend {
  readonly name: string;
  readonly target: string;
  /** Emit the per-tool file(s) for one app. Mandatory. */
  emitApp(ctx: CodegenContext): EmittedApp;
  /**
   * Emit suite-level files for a package containing many apps (e.g. the
   * `__init__.py` re-exporting `from .bet import *` per tool, or an
   * `index.ts` doing `export * from "./bet.js"`). Optional; defaulted to
   * no-op by callers when absent.
   */
  emitPackage?(pkg: PackageMeta, apps: EmittedApp[]): EmittedPackage;
  /**
   * Emit project-level artifacts spanning many packages (e.g. root
   * `pyproject.toml`, top-level `__init__.py`, runner helpers).
   * Wired up by Plan 2's CLI catalog mode; backends opt in as needed.
   */
  emitProject?(proj: ProjectMeta, packages: EmittedPackage[]): EmitResult;
}

export interface TypeMap {
  map(type: BoundType): string;
  imports(type: BoundType): string[];
}
