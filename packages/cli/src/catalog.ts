import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import type { Documentation, PackageMeta, ProjectMeta } from "@styx/core";

/**
 * Loaded catalog: a project containing packages, each holding one or more
 * apps. We always normalize to project > package > app even when the catalog
 * root only describes a subset of the hierarchy (e.g. a single version dir).
 */
export interface CatalogProject {
  meta: ProjectMeta;
  packages: CatalogPackage[];
  /** Non-fatal issues found while walking the catalog (e.g. skipped stub apps). */
  warnings: string[];
}

export interface CatalogPackage {
  meta: PackageMeta;
  apps: CatalogApp[];
}

export interface CatalogApp {
  /** Stable identifier from `app.json#name`, used for the emitted module slug. */
  name: string;
  /** Absolute path to the descriptor file referenced by `app.json#source`. */
  sourcePath: string;
  sourceFormat?: string;
}

interface ProjectJson {
  name?: string;
  version?: string;
  license?: string;
  packages?: string[];
  docs?: Documentation;
}

interface PackageJson {
  name?: string;
  versions?: string[];
  default?: string;
  docs?: Documentation;
}

interface VersionJson {
  name?: string;
  container?: string;
  apps?: string[];
  executables?: { required?: string[]; ignored?: string[] };
}

interface AppJson {
  name?: string;
  source?: { type?: string; path?: string };
  docs?: Documentation;
}

function readJson<T>(file: string): T {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`${file}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect what level of the niwrap catalog a directory describes.
 * Project dirs contain `project.json`, package dirs contain `package.json`,
 * version dirs contain `version.json`, app dirs contain `app.json`.
 */
export type CatalogLevel = "project" | "package" | "version" | "app";

export function detectLevel(dir: string): CatalogLevel | null {
  if (exists(path.join(dir, "project.json"))) return "project";
  if (exists(path.join(dir, "package.json"))) return "package";
  if (exists(path.join(dir, "version.json"))) return "version";
  if (exists(path.join(dir, "app.json"))) return "app";
  return null;
}

/**
 * Load one app descriptor. When `warnings` is supplied (catalog-walk mode), a
 * stub app (`app.json` present but no `source.path`) is skipped with a warning
 * instead of aborting the whole build - real catalogs list not-yet-wrapped tools
 * alongside wrapped ones. Without `warnings` (a direct single-app target) the
 * missing source is a hard error, since the user pointed straight at it.
 */
function loadApp(appDir: string, warnings?: string[]): CatalogApp | null {
  const appJsonPath = path.join(appDir, "app.json");
  if (!exists(appJsonPath)) return null;
  const app = readJson<AppJson>(appJsonPath);
  const name = app.name ?? path.basename(appDir);
  const sourceRel = app.source?.path;
  if (!sourceRel) {
    if (warnings) {
      warnings.push(`${appJsonPath}: skipped (no source.path - not yet wrapped)`);
      return null;
    }
    throw new Error(`${appJsonPath}: missing source.path`);
  }
  return {
    name,
    sourcePath: path.resolve(appDir, sourceRel),
    sourceFormat: app.source?.type,
  };
}

function loadVersion(versionDir: string, warnings?: string[]): CatalogPackage | null {
  const versionPath = path.join(versionDir, "version.json");
  if (!exists(versionPath)) return null;
  const version = readJson<VersionJson>(versionPath);

  const appNames = version.apps ?? listSubdirs(versionDir);
  const apps: CatalogApp[] = [];
  for (const appName of appNames) {
    const appDir = path.join(versionDir, appName);
    if (!isDir(appDir)) continue;
    const app = loadApp(appDir, warnings);
    if (app) apps.push(app);
  }

  // Try to enrich with the parent package.json if there is one (package > version layout).
  const parentPkg = path.join(versionDir, "..", "package.json");
  let pkgName: string | undefined;
  let pkgDoc: Documentation | undefined;
  if (exists(parentPkg)) {
    const pkg = readJson<PackageJson>(parentPkg);
    pkgName = pkg.name;
    pkgDoc = pkg.docs;
  }
  pkgName ??= path.basename(path.dirname(versionDir));

  return {
    meta: {
      name: pkgName,
      version: version.name,
      docker: version.container,
      doc: pkgDoc,
    },
    apps,
  };
}

function loadPackage(pkgDir: string, warnings?: string[]): CatalogPackage | null {
  const pkgPath = path.join(pkgDir, "package.json");
  if (!exists(pkgPath)) return null;
  const pkg = readJson<PackageJson>(pkgPath);

  const versionName = pkg.default ?? pkg.versions?.[0] ?? firstVersionDir(pkgDir);
  if (!versionName) return null;
  const versionDir = path.join(pkgDir, versionName);
  if (!isDir(versionDir)) return null;

  const loaded = loadVersion(versionDir, warnings);
  if (!loaded) return null;

  return {
    meta: {
      name: pkg.name ?? path.basename(pkgDir),
      version: versionName,
      docker: loaded.meta.docker,
      doc: pkg.docs ?? loaded.meta.doc,
    },
    apps: loaded.apps,
  };
}

function listSubdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function firstVersionDir(pkgDir: string): string | null {
  for (const name of listSubdirs(pkgDir)) {
    if (exists(path.join(pkgDir, name, "version.json"))) return name;
  }
  return null;
}

/**
 * Load a catalog from any niwrap layout level. The level is auto-detected from
 * which `*.json` index file is present in `root`. Always returns a normalized
 * `project > package > app` shape, synthesizing missing layers as needed.
 */
export function loadCatalog(root: string): CatalogProject {
  const level = detectLevel(root);
  if (!level) {
    throw new Error(
      `${root}: no project.json / package.json / version.json / app.json found - not a catalog root`,
    );
  }

  const warnings: string[] = [];

  if (level === "project") {
    const project = readJson<ProjectJson>(path.join(root, "project.json"));
    const packageNames = project.packages ?? listSubdirs(root);
    const packages: CatalogPackage[] = [];
    for (const name of packageNames) {
      const pkgDir = path.join(root, name);
      const pkg = loadPackage(pkgDir, warnings);
      if (pkg) packages.push(pkg);
    }
    return {
      meta: {
        name: project.name,
        version: project.version,
        doc: project.docs,
        license: project.license ? { description: project.license } : undefined,
      },
      packages,
      warnings,
    };
  }

  if (level === "package") {
    const pkg = loadPackage(root, warnings);
    if (!pkg) throw new Error(`${root}: package.json present but no resolvable version`);
    return { meta: { name: pkg.meta.name }, packages: [pkg], warnings };
  }

  if (level === "version") {
    const pkg = loadVersion(root, warnings);
    if (!pkg) throw new Error(`${root}: version.json present but failed to load`);
    return { meta: { name: pkg.meta.name }, packages: [pkg], warnings };
  }

  // level === "app": a direct single-app target, so a missing source is fatal.
  const app = loadApp(root);
  if (!app) throw new Error(`${root}: app.json present but missing source.path`);
  return {
    meta: {},
    packages: [
      {
        meta: { name: path.basename(path.dirname(root)) },
        apps: [app],
      },
    ],
    warnings,
  };
}
