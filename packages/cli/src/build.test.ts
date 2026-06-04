import * as path from "node:path";
import { PythonBackend, TypeScriptBackend } from "@styx/core";
import { describe, expect, it } from "vitest";

import { build } from "./build.js";

const FIXTURE = path.resolve(import.meta.dirname, "..", "test-fixtures", "mini-catalog");
const GREET = path.join(FIXTURE, "tools", "1.0", "greet", "boutiques.json");

function relPaths(files: { path: string }[], out: string): string[] {
  return files.map((f) => path.relative(out, f.path).split(path.sep).join("/")).sort();
}

describe("build (single descriptor)", () => {
  it("emits per-backend files under <out>/<target>/", () => {
    const result = build({
      input: GREET,
      out: "/out",
      backends: [new PythonBackend(), new TypeScriptBackend()],
      mode: "scripts",
    });
    expect(result.errors).toEqual([]);
    expect(relPaths(result.files, "/out")).toEqual(["python/greet.py", "typescript/greet.ts"]);
  });

  it("rejects neither input nor catalog", () => {
    const result = build({
      out: "/out",
      backends: [new PythonBackend()],
      mode: "scripts",
    });
    expect(result.errors).toEqual(["missing input: pass a descriptor path or --catalog"]);
  });

  it("rejects passing both input and catalog", () => {
    const result = build({
      input: GREET,
      catalog: FIXTURE,
      out: "/out",
      backends: [new PythonBackend()],
      mode: "scripts",
    });
    expect(result.errors).toEqual(["--input and --catalog are mutually exclusive"]);
  });
});

describe("build (catalog mode)", () => {
  it("scripts mode emits app files only", () => {
    const result = build({
      catalog: FIXTURE,
      out: "/out",
      backends: [new PythonBackend()],
      mode: "scripts",
    });
    expect(result.errors).toEqual([]);
    expect(relPaths(result.files, "/out")).toEqual([
      "python/tools/farewell.py",
      "python/tools/greet.py",
    ]);
  });

  it("reports a per-tool compiled/failed/skipped tally", () => {
    const result = build({
      catalog: FIXTURE,
      out: "/out",
      backends: [new PythonBackend()],
      mode: "scripts",
    });
    expect(result.stats).toEqual({ appsCompiled: 2, appsFailed: 0, appsSkipped: 0 });
  });

  it("single mode adds the package-level __init__.py", () => {
    const result = build({
      catalog: FIXTURE,
      out: "/out",
      backends: [new PythonBackend()],
      mode: "single",
    });
    expect(result.errors).toEqual([]);
    expect(relPaths(result.files, "/out")).toEqual([
      "python/tools/__init__.py",
      "python/tools/farewell.py",
      "python/tools/greet.py",
      "python/tools/py.typed",
    ]);
  });

  it("multi mode runs all three tiers (project emit adds packaging metadata)", () => {
    const result = build({
      catalog: FIXTURE,
      out: "/out",
      backends: [new PythonBackend()],
      mode: "multi",
    });
    expect(result.errors).toEqual([]);
    expect(relPaths(result.files, "/out")).toEqual([
      "python/README.md",
      "python/pyproject.toml",
      "python/requirements.txt",
      "python/tools/README.md",
      "python/tools/__init__.py",
      "python/tools/farewell.py",
      "python/tools/greet.py",
      "python/tools/py.typed",
      "python/tools/pyproject.toml",
    ]);
  });

  it("typescript catalog build mirrors the python layout", () => {
    const result = build({
      catalog: FIXTURE,
      out: "/out",
      backends: [new TypeScriptBackend()],
      mode: "single",
    });
    expect(result.errors).toEqual([]);
    expect(relPaths(result.files, "/out")).toEqual([
      "typescript/tools/farewell.ts",
      "typescript/tools/greet.ts",
      "typescript/tools/index.ts",
    ]);
  });

  it("typescript multi mode adds the project package.json", () => {
    const result = build({
      catalog: FIXTURE,
      out: "/out",
      backends: [new TypeScriptBackend()],
      mode: "multi",
    });
    expect(result.errors).toEqual([]);
    expect(relPaths(result.files, "/out")).toEqual([
      "typescript/index.ts",
      "typescript/package.json",
      "typescript/tools/farewell.ts",
      "typescript/tools/greet.ts",
      "typescript/tools/index.ts",
      "typescript/tsconfig.json",
    ]);
    const pkgJson = result.files.find((f) => f.path.endsWith("package.json"));
    expect(pkgJson!.content).toContain('"styxdefs": "^0.2.0"');
  });

  it("threads package + project meta into the codegen context", () => {
    const result = build({
      catalog: FIXTURE,
      out: "/out",
      backends: [new PythonBackend()],
      mode: "single",
    });
    const greet = result.files.find((f) => f.path.endsWith("greet.py"));
    expect(greet).toBeDefined();
    // PackageMeta carries name="tools"; PythonBackend uses it in METADATA.
    expect(greet!.content).toContain('package="tools"');
  });

  it("reports read failure with the source path and keeps going", () => {
    // Stand up a synthetic catalog where one app has a missing source file.
    const result = build({
      input: path.join(FIXTURE, "tools", "1.0", "greet", "does-not-exist.json"),
      out: "/out",
      backends: [new PythonBackend()],
      mode: "scripts",
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/does-not-exist\.json/);
    expect(result.files).toEqual([]);
  });
});

describe("build (golden file)", () => {
  it("greet.py output is stable", async () => {
    const result = build({
      input: GREET,
      out: "/out",
      backends: [new PythonBackend()],
      mode: "scripts",
    });
    expect(result.errors).toEqual([]);
    const greet = result.files.find((f) => f.path.endsWith("greet.py"));
    expect(greet).toBeDefined();
    await expect(greet!.content).toMatchFileSnapshot("__snapshots__/greet.py");
  });

  it("greet.ts output is stable", async () => {
    const result = build({
      input: GREET,
      out: "/out",
      backends: [new TypeScriptBackend()],
      mode: "scripts",
    });
    expect(result.errors).toEqual([]);
    const greet = result.files.find((f) => f.path.endsWith("greet.ts"));
    expect(greet).toBeDefined();
    await expect(greet!.content).toMatchFileSnapshot("__snapshots__/greet.ts");
  });
});
