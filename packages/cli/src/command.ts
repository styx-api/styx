import { knownBackends, resolveBackends } from "./backends.js";
import { build, type BuildMode } from "./build.js";
import type { BuiltFile } from "./build.js";

export interface BuildFlags {
  out?: string;
  catalog?: string;
  backend?: string | string[];
  mode?: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
  files: BuiltFile[];
}

/**
 * Run the `build` command without side effects (no process.exit, no I/O).
 * Returns the exit code, buffered output lines, and file map; the bin glue
 * is responsible for actually writing files and forwarding output.
 *
 * Exit code split: 2 for CLI-shape errors (bad flag, unknown backend),
 * 1 for build errors (parse failure, conflicting input/catalog), 0 for
 * success.
 */
export function runBuildCommand(input: string | undefined, flags: BuildFlags): RunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const out = flags.out;
  if (!out) {
    stderr.push("error: -o/--out is required");
    return { exitCode: 2, stdout, stderr, files: [] };
  }

  const backendNames = collectList(flags.backend);
  const { backends, unknown } = resolveBackends(backendNames);
  if (unknown.length > 0) {
    stderr.push(`error: unknown backend(s): ${unknown.join(", ")}`);
    stderr.push(`known: ${knownBackends.join(", ")}`);
    return { exitCode: 2, stdout, stderr, files: [] };
  }
  if (backends.length === 0) {
    stderr.push("error: no backends selected");
    return { exitCode: 2, stdout, stderr, files: [] };
  }

  const mode = parseMode(flags.mode);
  if (!mode) {
    stderr.push(`error: --mode must be one of scripts | single | multi (got "${flags.mode}")`);
    return { exitCode: 2, stdout, stderr, files: [] };
  }

  const result = build({ input, catalog: flags.catalog, out, backends, mode });

  for (const w of result.warnings) stderr.push(`warn: ${w}`);
  for (const e of result.errors) stderr.push(`error: ${e}`);

  if (result.errors.length > 0) {
    return { exitCode: 1, stdout, stderr, files: [] };
  }

  stdout.push(`wrote ${result.files.length} file${result.files.length === 1 ? "" : "s"} to ${out}`);
  return { exitCode: 0, stdout, stderr, files: result.files };
}

function collectList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseMode(value: string | undefined): BuildMode | null {
  if (!value) return "scripts";
  if (value === "scripts" || value === "single" || value === "multi") return value;
  return null;
}
