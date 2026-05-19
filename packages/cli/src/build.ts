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
  type PackageMeta,
  type ProjectMeta,
} from "@styx/core";

import { loadCatalog, type CatalogProject } from "./catalog.js";

export type BuildMode = "scripts" | "single" | "multi";

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

export interface BuildResult {
  files: BuiltFile[];
  errors: string[];
  warnings: string[];
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

  const ctx = readAndCompile(inputPath, undefined, undefined, result);
  if (!ctx) return result;

  for (const backend of options.backends) {
    const emitted = backend.emitApp(ctx);
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
  const result: BuildResult = { files: [], errors: [], warnings: [] };
  let catalog: CatalogProject;
  try {
    catalog = loadCatalog(catalogPath);
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
    return result;
  }

  for (const backend of options.backends) {
    runBackendOverCatalog(backend, catalog, options.mode, options.out, result);
  }
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
  pkg: PackageMeta | undefined,
  proj: ProjectMeta | undefined,
  result: BuildResult,
): ReturnType<typeof createContext> | null {
  let source: string;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch (e) {
    result.errors.push(`${sourcePath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  const parsed = compile(source, sourcePath);
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
}

function runBackendOverCatalog(
  backend: Backend,
  catalog: CatalogProject,
  mode: BuildMode,
  outRoot: string,
  result: BuildResult,
): void {
  const backendRoot = path.resolve(outRoot, backend.target);
  const packagesEmitted: EmittedPackage[] = [];

  for (const pkg of catalog.packages) {
    const pkgDir = pkg.meta.name ?? "package";
    const appsEmitted: EmittedApp[] = [];

    for (const app of pkg.apps) {
      const ctx = readAndCompile(app.sourcePath, pkg.meta, catalog.meta, result);
      if (!ctx) continue;

      const emitted = backend.emitApp(ctx);
      appendEmitMessages(result, emitted, backend, `${pkg.meta.name}/${app.name}`);
      appsEmitted.push(emitted);

      for (const [name, content] of emitted.files) {
        result.files.push({ path: path.join(backendRoot, pkgDir, name), content });
      }
    }

    if (mode !== "scripts" && backend.emitPackage) {
      const pkgEmit = backend.emitPackage(pkg.meta, appsEmitted);
      appendEmitMessages(result, pkgEmit, backend, pkg.meta.name);
      packagesEmitted.push(pkgEmit);
      for (const [name, content] of pkgEmit.files) {
        result.files.push({ path: path.join(backendRoot, pkgDir, name), content });
      }
    }
  }

  if (mode === "multi" && backend.emitProject) {
    const projEmit = backend.emitProject(catalog.meta, packagesEmitted);
    appendEmitMessages(result, projEmit, backend, catalog.meta.name);
    for (const [name, content] of projEmit.files) {
      result.files.push({ path: path.join(backendRoot, name), content });
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
