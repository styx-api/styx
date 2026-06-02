#!/usr/bin/env node
// Generate Python + TypeScript wrappers from the in-repo fixture catalog and
// type-check the output with `mypy --strict` and `tsc --noEmit`.
//
// This is the codegen typecheck gate. String-matching unit tests pin specific
// emitted shapes but cannot prove the generated code actually type-checks;
// running the real type-checkers over a small curated catalog catches whole
// classes of bugs those tests miss (declaration ordering / forward references,
// optional-omit NotRequired, union-output `never` collapses, indexability).
//
// Prereq: @styx/core and @styx/cli must be built (run `npm run build -w
// @styx/core -w @styx/cli`). The `typecheck:codegen` npm script does this for
// you; CI builds in a prior step. Also requires `mypy` on PATH (Python) - tsc
// comes from the repo's dev dependency.
//
// The output dir lives INSIDE the repo so the generated TS resolves `styxdefs`
// (and tsc itself) from the repo's node_modules via the normal upward walk.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "packages", "cli", "test-fixtures", "typecheck-catalog");
const outDir = path.join(repoRoot, ".tmp-codegen-typecheck");
const cliBin = path.join(repoRoot, "packages", "cli", "dist", "bin.mjs");
const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const pyDir = path.join(outDir, "python");
const tsProject = path.join(outDir, "typescript", "tsconfig.json");

// Files every run MUST emit. The CLI exits 0 even when it *skips* a tool
// (unsupported format, stub, etc.), so a silently-dropped fixture would leave
// nothing for the type-checkers to catch and the gate would falsely pass.
// Asserting the expected outputs exist makes a dropped tool a hard failure.
const expectedTools = [
  "dwi2response",
  "shapes",
  "denoise_image",
  "ants_apply_transforms",
  "mutate",
  "border_merge",
];
const expectedFiles = expectedTools.flatMap((t) => [
  `python/suite/${t}.py`,
  `typescript/suite/${t}.ts`,
]);

/** Run a command inheriting stdio; return its exit status (1 on spawn error). */
function run(label, cmd, args) {
  process.stdout.write(`\n→ ${label}\n  ${cmd} ${args.join(" ")}\n`);
  const res = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
  if (res.error) {
    process.stderr.write(`  ${label}: failed to launch (${res.error.message})\n`);
    return 1;
  }
  return res.status ?? 1;
}

if (!existsSync(cliBin)) {
  process.stderr.write(
    `error: CLI not built (${path.relative(repoRoot, cliBin)} missing).\n` +
      `  Run: npm run build -w @styx/core -w @styx/cli\n`,
  );
  process.exit(2);
}

// 1. Generate (multi mode => full project: pyproject + tsconfig + barrels).
rmSync(outDir, { recursive: true, force: true });
const gen = run("generate", process.execPath, [
  cliBin,
  "build",
  "--catalog",
  fixtures,
  "--mode",
  "multi",
  "-b",
  "python",
  "-b",
  "typescript",
  "-o",
  outDir,
]);
if (gen !== 0) {
  process.stderr.write("\nFAIL: codegen did not complete.\n");
  process.exit(1);
}

// Guard against a silently-skipped fixture (CLI exits 0 on skips).
const missing = expectedFiles.filter((rel) => !existsSync(path.join(outDir, rel)));
if (missing.length > 0) {
  process.stderr.write(
    `\nFAIL: expected generated files are missing (fixture skipped?):\n` +
      missing.map((m) => `  - ${m}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

// 2. Type-check both targets. Run both even if the first fails so the report
//    is complete.
const tsStatus = run("typescript: tsc --noEmit", process.execPath, [
  tscBin,
  "--noEmit",
  "-p",
  tsProject,
]);

// mypy: styxdefs is an external runtime, so ignore its (uninstalled) imports;
// --strict maximizes coverage of the generated code itself.
const pyStatus = run("python: mypy --strict", "python", [
  "-m",
  "mypy",
  "--strict",
  "--ignore-missing-imports",
  pyDir,
]);

const failures = [];
if (tsStatus !== 0) failures.push("TypeScript (tsc)");
if (pyStatus !== 0) failures.push("Python (mypy)");

process.stdout.write("\n" + "=".repeat(60) + "\n");
if (failures.length === 0) {
  process.stdout.write("PASS: generated Python + TypeScript type-check cleanly.\n");
  process.exit(0);
}
process.stdout.write(`FAIL: type errors in generated ${failures.join(" and ")}.\n`);
process.exit(1);
