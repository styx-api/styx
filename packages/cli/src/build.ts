import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  compile,
  createContext,
  defaultPipeline,
  resolveOutputs,
  solve,
  type Backend,
  type EmitResult,
  type EmittedApp,
  type EmittedPackage,
  type FormatName,
  type PackageMeta,
  type ProjectMeta,
} from "@styx-api/core";

import { loadCatalog, type CatalogProject } from "./catalog.js";

export type BuildMode = "scripts" | "single" | "multi";

/** Frontend formats the compiler can parse; others are skipped with a warning. */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set<FormatName>([
  "boutiques",
  "argdump",
  "workbench",
]);

export interface BuildOptions {
  /** Single-descriptor input file (mutually exclusive with `catalog`). */
  input?: string;
  /** Catalog directory (mutually exclusive with `input`). */
  catalog?: string;
  /** Output directory; per-backend files end up under `<out>/<backend.target>/...`. */
  out: string;
  /** Backends to run (instances pre-resolved by the caller). */
  backends: Backend[];
  /** Which emit tiers to run. */
  mode: BuildMode;
}

/** A single file from a backend run, keyed by destination path. */
export interface BuiltFile {
  /** Absolute destination path. */
  path: string;
  content: string;
}

/** Per-tool tallies for a catalog build (undefined for single-descriptor builds). */
export interface BuildStats {
  appsCompiled: number;
  appsFailed: number;
  appsSkipped: number;
}

export interface BuildResult {
  files: BuiltFile[];
  errors: string[];
  warnings: string[];
  /** Catalog-build tallies; set only by `--catalog` builds. */
  stats?: BuildStats;
}

/** Render an unknown thrown value as a message string. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run the build. Returns the assembled file map and diagnostics; the caller
 * is responsible for actually writing to disk (so tests can introspect the
 * map directly).
 */
export function build(options: BuildOptions): BuildResult {
  if (options.input && options.catalog) {
    return { files: [], errors: ["--input and --catalog are mutually exclusive"], warnings: [] };
  }
  if (!options.input && !options.catalog) {
    return {
      files: [],
      errors: ["missing input: pass a descriptor path or --catalog"],
      warnings: [],
    };
  }

  if (options.input) return buildSingle(options.input, options);
  return buildCatalog(options.catalog!, options);
}

function buildSingle(inputPath: string, options: BuildOptions): BuildResult {
  const result: BuildResult = { files: [], errors: [], warnings: [] };

  const ctx = readAndCompile(inputPath, undefined, undefined, undefined, result);
  if (!ctx) return result;

  for (const backend of options.backends) {
    let emitted;
    try {
      emitted = backend.emitApp(ctx);
    } catch (e) {
      result.errors.push(`[${backend.name}] ${errMsg(e)}`);
      continue;
    }
    appendEmitMessages(result, emitted, backend);
    for (const [name, content] of emitted.files) {
      result.files.push({
        path: path.resolve(options.out, backend.target, name),
        content,
      });
    }
  }
  return result;
}

function buildCatalog(catalogPath: string, options: BuildOptions): BuildResult {
  const result: BuildResult = {
    files: [],
    errors: [],
    warnings: [],
    stats: { appsCompiled: 0, appsFailed: 0, appsSkipped: 0 },
  };
  let catalog: CatalogProject;
  try {
    catalog = loadCatalog(catalogPath);
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
    return result;
  }
  result.warnings.push(...catalog.warnings);

  // Skip/empty warnings are backend-independent, so only the first backend pass
  // records them - otherwise they'd be duplicated once per backend.
  options.backends.forEach((backend, i) => {
    runBackendOverCatalog(backend, catalog, options.mode, options.out, result, i === 0);
  });
  return result;
}

/**
 * Parse a descriptor, run the default optimization pipeline, solve to
 * bindings, and build a `CodegenContext` wired up with the supplied
 * package/project meta. Returns null on read failure (with the error already
 * appended to `result`). Parse-level errors/warnings are also appended.
 */
function readAndCompile(
  sourcePath: string,
  format: string | undefined,
  pkg: PackageMeta | undefined,
  proj: ProjectMeta | undefined,
  result: BuildResult,
): ReturnType<typeof createContext> | null {
  let source: string;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch (e) {
    result.errors.push(`${sourcePath}: ${errMsg(e)}`);
    return null;
  }

  // Isolate the compile pipeline: a single descriptor that makes the solver or
  // a downstream pass throw is recorded as an error and skipped, so one bad tool
  // can't crash a whole-catalog build.
  try {
    // Honor the catalog's declared format when it's one we support, so we don't
    // fall back to content sniffing (and get a clearer error if it mis-parses).
    const parsed = compile(
      source,
      format && SUPPORTED_FORMATS.has(format)
        ? { filename: sourcePath, format: format as FormatName }
        : sourcePath,
    );
    for (const e of parsed.errors) result.errors.push(`${sourcePath}: ${e.message}`);
    for (const w of parsed.warnings) result.warnings.push(`${sourcePath}: ${w.message}`);

    const piped = defaultPipeline.apply(parsed.expr);
    if (piped.warnings) {
      for (const w of piped.warnings) result.warnings.push(`${sourcePath}: ${w}`);
    }

    const solveResult = solve(piped.expr);
    const outputs = resolveOutputs(piped.expr, solveResult);
    return createContext(piped.expr, solveResult, outputs, {
      app: parsed.meta,
      package: pkg,
      project: proj,
    });
  } catch (e) {
    result.errors.push(`${sourcePath}: ${errMsg(e)}`);
    return null;
  }
}

function runBackendOverCatalog(
  backend: Backend,
  catalog: CatalogProject,
  mode: BuildMode,
  outRoot: string,
  result: BuildResult,
  recordWarnings: boolean,
): void {
  const backendRoot = path.resolve(outRoot, backend.target);
  const packagesEmitted: EmittedPackage[] = [];

  for (const pkg of catalog.packages) {
    const pkgDir = pkg.meta.name ?? "package";
    const appsEmitted: EmittedApp[] = [];
    let skipped = 0;
    // One scope shared across every tool in the suite so top-level names stay
    // unique across the package's flat barrel re-exports.
    const pkgScope = backend.newPackageScope?.();

    for (const app of pkg.apps) {
      // A tool can declare a format we have no frontend for yet (e.g. Workbench).
      // Skip it with a warning rather than failing the whole catalog build.
      if (app.sourceFormat && !SUPPORTED_FORMATS.has(app.sourceFormat)) {
        skipped++;
        if (recordWarnings) {
          if (result.stats) result.stats.appsSkipped++;
          result.warnings.push(
            `${app.sourcePath}: skipped (unsupported source format "${app.sourceFormat}")`,
          );
        }
        continue;
      }

      const ctx = readAndCompile(app.sourcePath, app.sourceFormat, pkg.meta, catalog.meta, result);
      if (!ctx) {
        if (recordWarnings && result.stats) result.stats.appsFailed++;
        continue;
      }

      // Isolate emit so one tool that makes a backend throw doesn't crash the run.
      let emitted: EmittedApp;
      try {
        emitted = backend.emitApp(ctx, pkgScope);
      } catch (e) {
        result.errors.push(`[${backend.name} ${pkg.meta.name}/${app.name}] ${errMsg(e)}`);
        if (recordWarnings && result.stats) result.stats.appsFailed++;
        continue;
      }
      appendEmitMessages(result, emitted, backend, `${pkg.meta.name}/${app.name}`);
      appsEmitted.push(emitted);
      if (recordWarnings && result.stats) result.stats.appsCompiled++;

      for (const [name, content] of emitted.files) {
        result.files.push({ path: path.join(backendRoot, pkgDir, name), content });
      }
    }

    // A suite whose every tool was skipped (e.g. all-Workbench) emits nothing;
    // don't synthesize an empty package or wire it into the project metadata.
    // Only warn when emptiness is due to skips - genuine failures already errored.
    if (appsEmitted.length === 0) {
      if (recordWarnings && skipped > 0 && skipped === pkg.apps.length) {
        result.warnings.push(`${pkgDir}: all ${skipped} tool(s) skipped, package omitted`);
      }
      continue;
    }

    if (mode !== "scripts" && backend.emitPackage) {
      try {
        const pkgEmit = backend.emitPackage(pkg.meta, appsEmitted);
        appendEmitMessages(result, pkgEmit, backend, pkg.meta.name);
        packagesEmitted.push(pkgEmit);
        for (const [name, content] of pkgEmit.files) {
          result.files.push({ path: path.join(backendRoot, pkgDir, name), content });
        }
      } catch (e) {
        result.errors.push(`[${backend.name} ${pkgDir}] package emit failed: ${errMsg(e)}`);
      }
    }
  }

  if (mode === "multi" && backend.emitProject && packagesEmitted.length > 0) {
    try {
      const projEmit = backend.emitProject(catalog.meta, packagesEmitted);
      appendEmitMessages(result, projEmit, backend, catalog.meta.name);
      for (const [name, content] of projEmit.files) {
        result.files.push({ path: path.join(backendRoot, name), content });
      }
    } catch (e) {
      result.errors.push(`[${backend.name}] project emit failed: ${errMsg(e)}`);
    }
  }
}

function appendEmitMessages(
  result: BuildResult,
  emit: EmitResult,
  backend: Backend,
  scope?: string,
): void {
  const tag = scope ? `[${backend.name} ${scope}]` : `[${backend.name}]`;
  for (const e of emit.errors) result.errors.push(`${tag} ${e.message}`);
  for (const w of emit.warnings) result.warnings.push(`${tag} ${w.message}`);
}
