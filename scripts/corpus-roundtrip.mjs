#!/usr/bin/env node
// Full-corpus Boutiques/mrtrix/workbench -> argtype round-trip sweep.
//
// For every descriptor in a niwrap catalog, this asserts the universally-safe
// round-trip property: the source compiles to IR with zero errors, and the
// argtype the backend emits from that IR re-parses (as argtype) with zero
// errors. Re-parse validity is the strongest property that holds across the
// whole corpus - it proves the emitter never produces invalid/non-reparseable
// syntax over the full shape diversity of real tools. It does NOT assert codegen
// identity: the documented annotation lossiness (media types, some docs, mutable
// flags) and the frontend's outputs-collected-to-root behavior mean the emitted
// argtype is not byte-identical to a from-scratch authoring for every tool, so
// only re-parse validity is checked here (same rationale as the in-repo
// `corpus-roundtrip.test.ts` smoke, which this generalizes to all ~1900 tools).
//
// The in-repo vitest `corpus-roundtrip.test.ts` is the fast 10-case smoke; this
// script is the full sweep, wired into CI against a pinned niwrap checkout.
//
// Prereq: @styx-api/core and @styx-api/cli must be built (run `npm run build -w
// @styx-api/core -w @styx-api/cli`). Usage:
//   node scripts/corpus-roundtrip.mjs --catalog <path-to-niwrap/src/niwrap>
//
// Options:
//   --catalog <dir>  Catalog root (a niwrap project/package/version/app dir).
//   --min <n>        Minimum descriptor count expected (default 1900). Guards
//                    against a wrong --catalog path silently passing with zero
//                    tools - the corpus has ~1900+ descriptors (1919 at the
//                    pinned ref). Raise the floor if bumping the ref grows it.

import { readFileSync } from "node:fs";
import { compile, generateArgtype } from "@styx-api/core";
import { loadCatalog } from "@styx-api/cli";

function parseArgs(argv) {
  const args = { catalog: undefined, min: 1900 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog") args.catalog = argv[++i];
    else if (a === "--min") {
      // Reject a missing/non-numeric value: `Number(undefined)` is NaN, and
      // `length < NaN` is always false, which would silently disable the
      // anti-silent-skip guard below.
      args.min = Number(argv[++i]);
      if (!Number.isFinite(args.min)) {
        process.stderr.write("error: --min requires a numeric value.\n");
        process.exit(2);
      }
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

const { catalog, min } = parseArgs(process.argv.slice(2));
if (!catalog) {
  process.stderr.write(
    "error: --catalog <dir> is required (path to a niwrap catalog, e.g. niwrap/src/niwrap).\n",
  );
  process.exit(2);
}

// Enumerate every descriptor in the catalog (project > package > app), keeping
// the source path + declared format for a targeted compile.
let project;
try {
  project = loadCatalog(catalog);
} catch (e) {
  process.stderr.write(`error: failed to load catalog '${catalog}': ${e?.message ?? e}\n`);
  process.exit(2);
}

const descriptors = project.packages.flatMap((pkg) =>
  pkg.apps.map((app) => ({ name: app.name, path: app.sourcePath, format: app.sourceFormat })),
);

process.stdout.write(`Loaded ${descriptors.length} descriptor(s) from ${catalog}\n`);

// Surface apps `loadCatalog` skipped (stub apps, malformed `app.json`). These
// tools drop out of `descriptors` entirely, so without printing them a
// catalog-walk regression could shrink coverage while still clearing the count
// guard. They are informational, not failures.
if (project.warnings.length > 0) {
  process.stdout.write(`\n${project.warnings.length} catalog warning(s) (skipped apps):\n`);
  for (const w of project.warnings) process.stdout.write(`  - ${w}\n`);
}

// Anti-silent-skip guard: a wrong --catalog path (or a catalog that failed to
// enumerate its apps) would leave nothing to check and pass vacuously. Require a
// realistic descriptor count so an empty/near-empty sweep is a hard failure.
if (descriptors.length < min) {
  process.stderr.write(
    `\nFAIL: only ${descriptors.length} descriptor(s) found, expected at least ${min}.\n` +
      `  Is --catalog pointing at the niwrap catalog root (e.g. niwrap/src/niwrap)?\n`,
  );
  process.exit(1);
}

const failures = [];
let passed = 0;

for (const d of descriptors) {
  let source;
  try {
    source = readFileSync(d.path, "utf8");
  } catch (e) {
    failures.push({ tool: d.name, path: d.path, stage: "read", detail: e?.message ?? String(e) });
    continue;
  }

  // 1. Compile the descriptor to IR. A real tool must parse with zero errors.
  const direct = compile(source, d.format ? { format: d.format } : undefined);
  if (direct.errors.length > 0) {
    failures.push({
      tool: d.name,
      path: d.path,
      stage: "compile",
      detail: direct.errors[0].message,
    });
    continue;
  }

  // 2. Emit argtype from the IR, then re-parse it as argtype. The universally
  //    safe property is that the emitted source re-parses with zero errors.
  let emitted;
  try {
    emitted = generateArgtype(direct.expr, direct.meta).source;
  } catch (e) {
    failures.push({ tool: d.name, path: d.path, stage: "emit", detail: e?.message ?? String(e) });
    continue;
  }
  const reparsed = compile(emitted, { format: "argtype" });
  if (reparsed.errors.length > 0) {
    failures.push({
      tool: d.name,
      path: d.path,
      stage: "reparse",
      detail: reparsed.errors[0].message,
    });
    continue;
  }

  passed++;
}

process.stdout.write("\n" + "=".repeat(60) + "\n");
if (failures.length === 0) {
  process.stdout.write(`PASS: ${passed}/${descriptors.length} descriptors round-trip cleanly.\n`);
  process.exit(0);
}

process.stdout.write(`FAIL: ${failures.length}/${descriptors.length} descriptor(s) failed:\n\n`);
for (const f of failures) {
  process.stdout.write(`  [${f.stage}] ${f.tool}\n    ${f.path}\n    ${f.detail}\n`);
}
process.exit(1);
