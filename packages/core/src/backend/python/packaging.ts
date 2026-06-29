import type { Documentation } from "../../ir/index.js";
import type { PackageMeta, ProjectMeta } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import { PYTHON_RUNNER_DEPS, STYXDEFS_COMPAT } from "../styxdefs-compat.js";

const REQUIRES_PYTHON = ">=3.10";
const BUILD_SYSTEM = `[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"`;

/** Escape a value for embedding in a TOML basic string. */
function tomlStr(s: string): string {
  return (
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, " ")
      // TOML basic strings forbid literal control chars (tab U+0009 is allowed);
      // strip the rest so scraped docs can't produce invalid TOML.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
  );
}

/** Suite directory / importable package name; matches the CLI's `pkgDir` fallback. */
function pkgDir(pkg: PackageMeta): string {
  return pkg.name ?? "package";
}

/** Distribution (PyPI) name for a package: `<project>_<package>`, or just `<package>`. */
export function pyDistName(proj: ProjectMeta, pkg: PackageMeta): string {
  const name = pkgDir(pkg);
  return proj.name ? `${proj.name}_${name}` : name;
}

// pyproject's `[project] description` becomes the core-metadata `Summary` field,
// which PyPI caps at 512 chars. The catalog's `doc.description` is often a full
// paragraph (and is emitted in full into the README / long description anyway),
// so the summary is clamped to fit.
const SUMMARY_MAX_LEN = 512;

/**
 * Clamp a description to a <=512-char one-line summary. Prefer cutting at the
 * last complete sentence that fits (clean, no dangling fragment); if there is no
 * sentence boundary early enough, cut at a word boundary and mark the elision.
 */
function clampSummary(s: string): string {
  if (s.length <= SUMMARY_MAX_LEN) return s;
  const window = s.slice(0, SUMMARY_MAX_LEN);
  const lastSentence = window.lastIndexOf(". ");
  if (lastSentence >= 0) return s.slice(0, lastSentence + 1); // keep the period
  const ellipsis = "...";
  const body = window.slice(0, SUMMARY_MAX_LEN - ellipsis.length);
  const lastSpace = body.lastIndexOf(" ");
  return (lastSpace > 0 ? body.slice(0, lastSpace) : body).replace(/[.,;:\s]+$/, "") + ellipsis;
}

function description(doc: Documentation | undefined, fallbackName: string | undefined): string {
  const summary =
    doc?.description ?? `Styx generated wrappers for ${doc?.title ?? fallbackName ?? "tools"}.`;
  return clampSummary(summary);
}

function authorsField(doc: Documentation | undefined): string {
  const authors = doc?.authors?.length ? doc.authors : ["unknown"];
  return `[${authors.map((a) => `{ name = "${tomlStr(a)}" }`).join(", ")}]`;
}

function licenseField(proj: ProjectMeta): string {
  return `{ text = "${tomlStr(proj.license?.description ?? "unknown")}" }`;
}

/**
 * Per-suite `pyproject.toml`. The suite source stays in a flat directory
 * (`python/<pkg>/bet.py`), but setuptools' `package-dir` maps that directory onto
 * the dotted import package `<project>.<pkg>`, so every suite nests under the
 * metapackage's `<project>/` namespace. That restores `from <project> import
 * <pkg>` while keeping each suite a separately-installable distribution (and
 * leaves no top-level `<pkg>` polluting the global namespace). With no project
 * name the import name is the bare `<pkg>` (top-level fallback). The styxdefs
 * floor is the only runtime dependency.
 *
 * Precondition: `importName` is a valid (possibly dotted) Python package path -
 * the caller scrubs the project + package names into identifiers accordingly.
 */
export function generateSubPyproject(
  proj: ProjectMeta,
  pkg: PackageMeta,
  importName: string,
): string {
  const cb = new CodeBuilder("  ");
  cb.line("[project]");
  cb.line(`name = "${tomlStr(pyDistName(proj, pkg))}"`);
  // The wrapper distribution is released as part of the project, so it carries
  // the project (catalog) version - NOT the wrapped tool's version. This keeps
  // every niwrap_<pkg> in lockstep with the niwrap meta package, matching the
  // single-package TypeScript distribution and the v1 release scheme.
  cb.line(`version = "${tomlStr(proj.version ?? "0.0.0")}"`);
  cb.line(`description = "${tomlStr(description(pkg.doc, pkg.name))}"`);
  cb.line(`readme = "README.md"`);
  cb.line(`license = ${licenseField(proj)}`);
  cb.line(`authors = ${authorsField(pkg.doc ?? proj.doc)}`);
  cb.line(`requires-python = "${REQUIRES_PYTHON}"`);
  cb.line("dependencies = [");
  cb.line(`  "styxdefs${STYXDEFS_COMPAT.python}",`);
  cb.line("]");
  cb.blank();
  cb.line("[tool.setuptools]");
  cb.line(`packages = ["${importName}"]`);
  cb.line(`package-dir = { "${importName}" = "." }`);
  cb.blank();
  cb.line("[tool.setuptools.package-data]");
  cb.line(`"${importName}" = ["py.typed"]`);
  cb.blank();
  cb.line(BUILD_SYSTEM);
  return cb.toString() + "\n";
}

/**
 * The metapackage's `__init__.py`. A thin re-export of styxkit so the runner
 * configuration helpers (`use_docker`, `use_local`, `set_global_runner`, ...)
 * are reachable as `<project>.<name>` - the v1 ergonomic that the v2 split into
 * per-suite distributions otherwise dropped. The logic lives in styxkit (pulled
 * in via `styxkit[all]`), so this stays a wildcard re-export and never re-emits
 * the runner-config code itself.
 */
export function generateRootInitPy(): string {
  return (
    "# This file was auto generated by Styx.\n" +
    "# Do not edit this file directly.\n" +
    "\n" +
    "# Re-export styxkit's runner-configuration helpers (use_docker, use_local,\n" +
    "# use_auto, set_global_runner, get_global_runner, ...) so they are available\n" +
    "# directly on this package, e.g. `import niwrap; niwrap.use_docker()`.\n" +
    "from styxkit import *  # noqa: F401,F403\n"
  );
}

/**
 * Root `pyproject.toml`: a metapackage depending on `styxkit[all]` (the runner
 * stack it re-exports) plus each per-suite distribution, pinned to this exact
 * project version (`niwrap_fsl==1.2.3`). The suites all ride the project version
 * and ship in lockstep, so an exact pin keeps `pip install niwrap==X` consistent:
 * during the post-release index-propagation window (or any momentary registry
 * inconsistency) pip errors cleanly instead of silently grafting an older suite
 * whose layout no longer matches the metapackage. Mirrors the way the CLI pins
 * `@styx-api/core` exactly.
 *
 * `packages` lists only the metapackage's own module so setuptools ships the
 * styxkit re-export without sweeping the sibling suite directories into this
 * distribution. The module is the `<project>/` namespace package the suites nest
 * into, so installing the metapackage makes `<project>.use_docker()` reachable
 * alongside the suites' `from <project> import <pkg>`. `moduleDir` is the on-disk
 * source directory; it differs from the import `moduleName` only when a suite is
 * named after the project, in which case a `package-dir` remap keeps the import
 * name intact.
 */
export function generateRootPyproject(
  proj: ProjectMeta,
  distNames: string[],
  moduleName: string,
  moduleDir: string,
): string {
  const cb = new CodeBuilder("  ");
  cb.line("[project]");
  cb.line(`name = "${tomlStr(proj.name ?? "project")}"`);
  cb.line(`version = "${tomlStr(proj.version ?? "0.0.0")}"`);
  cb.line(`description = "${tomlStr(description(proj.doc, proj.name))}"`);
  cb.line(`readme = "README.md"`);
  cb.line(`license = ${licenseField(proj)}`);
  cb.line(`authors = ${authorsField(proj.doc)}`);
  cb.line(`requires-python = "${REQUIRES_PYTHON}"`);
  cb.line("dependencies = [");
  for (const dep of PYTHON_RUNNER_DEPS) cb.line(`  "${dep}",`);
  // Pin each suite to the exact project version (they ship in lockstep) so a
  // mid-propagation install can't mix a new metapackage with an old suite.
  const suitePin = tomlStr(proj.version ?? "0.0.0");
  for (const dist of distNames) cb.line(`  "${tomlStr(dist)}==${suitePin}",`);
  cb.line("]");
  cb.blank();
  cb.line("[tool.setuptools]");
  cb.line(`packages = ["${moduleName}"]`);
  if (moduleDir !== moduleName) {
    cb.line(`package-dir = { "${moduleName}" = "${moduleDir}" }`);
  }
  cb.blank();
  cb.line("[tool.setuptools.package-data]");
  cb.line(`"${moduleName}" = ["py.typed"]`);
  cb.blank();
  cb.line(BUILD_SYSTEM);
  return cb.toString() + "\n";
}

/** Per-suite README crediting the upstream tool authors. */
export function generateSubReadme(proj: ProjectMeta, pkg: PackageMeta): string {
  const projectTitle = proj.doc?.title ?? proj.name ?? "Styx";
  const packageTitle = pkg.doc?.title ?? pkg.name ?? "package";
  const url = pkg.doc?.urls?.[0];
  const titleMd = url ? `[${packageTitle}](${url})` : packageTitle;
  const credits = pkg.doc?.authors?.length
    ? pkg.doc.authors.join(", ")
    : (pkg.doc?.urls?.join(", ") ?? "unknown");
  const desc = pkg.doc?.description ? `\n\n${pkg.doc.description}` : "";
  return (
    `# ${projectTitle} wrappers for ${titleMd}${desc}\n\n` +
    `${packageTitle} is made by ${credits}.\n\n` +
    `This package contains wrappers only and has no affiliation with the original authors.\n`
  );
}

/** Root README listing the bundled per-suite distributions. */
export function generateRootReadme(proj: ProjectMeta, distNames: string[]): string {
  const title = proj.doc?.title ?? proj.name ?? "Styx";
  const desc = proj.doc?.description ? `\n${proj.doc.description}\n` : "";
  const list = distNames.map((d) => `- ${d}`).join("\n");
  return (
    `# ${title}\n${desc}\n` +
    `Auto-generated Styx wrappers. This project bundles the following packages:\n\n` +
    `${list}\n`
  );
}

/** Local-install manifest: each suite directory first, then the root metapackage. */
export function generateRequirementsTxt(pkgDirs: string[]): string {
  return [...pkgDirs.map((d) => `./${d}`), "./"].join("\n") + "\n";
}
