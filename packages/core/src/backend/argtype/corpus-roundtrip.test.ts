import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../../index.js";
import { ArgtypeParser } from "../../frontend/argtype/parser-frontend.js";
import { generateArgtype } from "./emit.js";

/**
 * Corpus validity guard: for every descriptor in the typecheck catalog (the
 * curated hard cases - unions, dup outputs/variants, mutable inputs, mrtrix,
 * workbench), the emitter must produce argtype source that re-parses with ZERO
 * errors. This is the strongest property that holds universally: it proves the
 * backend never emits invalid/non-reparseable syntax across the shape diversity
 * of real tools, independent of the documented annotation lossiness (docs,
 * titles, media types, mutable) and the frontend's outputs-collected-to-root
 * behavior, which prevent exact codegen equality for some tools.
 */

const CATALOG = new URL(
  "../../../../../packages/cli/test-fixtures/typecheck-catalog/suite/1.0/",
  import.meta.url,
);

const TOOLS: Array<[string, string]> = [
  ["DenoiseImage", "boutiques.json"],
  ["antsApplyTransforms", "boutiques.json"],
  ["borderMerge", "workbench.json"],
  ["dupOutputs", "boutiques.json"],
  ["dupVariant", "boutiques.json"],
  ["dwi2response", "boutiques.json"],
  ["mrtrixDemo", "mrtrix.json"],
  ["mutate", "boutiques.json"],
  ["shapes", "boutiques.json"],
  ["variousTypes", "boutiques.json"],
];

const argtype = new ArgtypeParser();

describe("argtype backend: corpus emits re-parseable source", () => {
  for (const [tool, file] of TOOLS) {
    it(`${tool}: emitted argtype re-parses cleanly`, () => {
      const source = readFileSync(fileURLToPath(new URL(`${tool}/${file}`, CATALOG)), "utf8");
      const direct = compile(source);
      expect(direct.errors, `${tool}: direct parse errors`).toEqual([]);

      const { source: emitted } = generateArgtype(direct.expr, direct.meta);
      const reparsed = argtype.parse(emitted);
      expect(reparsed.errors, `${tool}: emitted argtype failed to re-parse:\n${emitted}`).toEqual(
        [],
      );
    });
  }
});
