import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import * as styx from "./index.js";

/**
 * The exact `@styx-api/core` surface the niwrap-hub depends on (Phase C / S3).
 *
 * The hub compiles descriptors in the browser: it parses + optimizes + solves +
 * resolves outputs (compile/defaultPipeline/solve/resolveOutputs/createContext),
 * drives its forms off the JSON Schema backend, runs the TS backend output through a
 * transpiler + DryRunner for cargs/outputs, and renders Python/TS call snippets.
 *
 * Keep this list in lockstep with niwrap-hub/docs/styx2-phase-c-plan.md (Track S, S3).
 * Removing or renaming any of these is a breaking change for the hub.
 */
const HUB_SURFACE = [
  // frontend + pipeline + solver
  "compile",
  "defaultPipeline",
  "solve",
  "resolveOutputs",
  "createContext",
  // JSON Schema backend (forms)
  "JsonSchemaBackend",
  "generateSchema",
  "generateOutputsSchema",
  // TypeScript backend (transpile-and-run for cargs/outputs)
  "generateTypeScript",
  "TypeScriptBackend",
  // dispatch-entrypoint resolver: the authoritative `@type` -> execute-fn-name
  // map (struct root -> `<tool>Execute`, non-struct -> wrapper) the hub uses to
  // invoke the right export after transpiling, without recomputing names.
  "appEntrypoint",
  // call-site snippet renderers (replace the hub's pythonCodeGen.ts + symbolmaps)
  "renderPythonCall",
  "renderTypeScriptCall",
  "buildSigEntries",
] as const;

describe("@styx-api/core public API (niwrap-hub surface)", () => {
  it("re-exports every symbol the hub needs from the package root", () => {
    for (const name of HUB_SURFACE) {
      expect(styx, `missing export: ${name}`).toHaveProperty(name);
      expect(styx[name], `export ${name} is undefined`).toBeDefined();
    }
  });

  it("exposes callables / constructors of the expected shape", () => {
    // functions
    for (const name of [
      "compile",
      "solve",
      "resolveOutputs",
      "createContext",
      "generateSchema",
      "generateOutputsSchema",
      "generateTypeScript",
      "appEntrypoint",
      "renderPythonCall",
      "renderTypeScriptCall",
      "buildSigEntries",
    ] as const) {
      expect(typeof styx[name], `${name} should be a function`).toBe("function");
    }
    // backends are classes (constructors)
    expect(typeof styx.JsonSchemaBackend).toBe("function");
    expect(typeof styx.TypeScriptBackend).toBe("function");
    // defaultPipeline is a Pass instance (name + apply)
    expect(typeof styx.defaultPipeline.apply).toBe("function");
  });
});

describe("@styx-api/core bundle size guard", () => {
  // Bundling with rolldown + gzip is heavier than a normal unit test.
  it("tree-shaken + minified hub surface stays under the 61 KB gzip ceiling", async () => {
    const { rolldown } = await import("rolldown");
    const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const VIRTUAL = "\0styx-hub-surface";
    const entry = `export { ${HUB_SURFACE.join(", ")} } from ${JSON.stringify(indexPath)};`;

    const bundle = await rolldown({
      input: VIRTUAL,
      logLevel: "silent",
      plugins: [
        {
          name: "virtual-hub-surface",
          resolveId(id) {
            return id === VIRTUAL ? id : null;
          },
          load(id) {
            return id === VIRTUAL ? entry : null;
          },
        },
      ],
    });

    try {
      const { output } = await bundle.generate({ minify: true, format: "esm" });
      const code = output.map((c) => (c.type === "chunk" ? c.code : "")).join("");
      const gzipKb = gzipSync(code).length / 1024;

      // Sanity floor: catches a silently-empty bundle (e.g. resolution dropped to
      // externals) that would make the ceiling check meaningless.
      expect(gzipKb, "bundle is implausibly small - resolution likely failed").toBeGreaterThan(5);

      // Ceiling from the niwrap-hub bench: the core tree-shaken + minified was
      // 24-61 KB gzip; the hub also needs JsonSchemaBackend (forms), which must not
      // push it past 61 KB. Current measured: ~29 KB.
      expect(gzipKb).toBeLessThan(61);
    } finally {
      await bundle.close();
    }
  }, 60_000);
});
