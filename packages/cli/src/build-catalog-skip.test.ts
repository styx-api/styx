import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PythonBackend } from "@styx/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { build } from "./build.js";

let tmp: string;
let out: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "styx-skip-"));
  out = mkdtempSync(path.join(os.tmpdir(), "styx-out-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const full = path.join(tmp, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const BOUTIQUES = JSON.stringify({
  name: "greet",
  description: "Print a greeting.",
  "tool-version": "1.0",
  "schema-version": "0.5",
  "command-line": "greet [NAME]",
  inputs: [{ id: "name", name: "Name", type: "String", "value-key": "[NAME]" }],
});

function relPaths(files: { path: string }[]): string[] {
  return files.map((f) => path.relative(out, f.path).split(path.sep).join("/")).sort();
}

describe("catalog build: skipping unbuildable tools", () => {
  it("skips an unsupported source format and still emits the rest", () => {
    writeFile("project.json", JSON.stringify({ name: "proj", packages: ["pkg"] }));
    writeFile("pkg/package.json", JSON.stringify({ name: "pkg", default: "1" }));
    writeFile("pkg/1/version.json", JSON.stringify({ name: "1", apps: ["greet", "wb"] }));
    writeFile(
      "pkg/1/greet/app.json",
      JSON.stringify({ name: "greet", source: { type: "boutiques", path: "d.json" } }),
    );
    writeFile("pkg/1/greet/d.json", BOUTIQUES);
    writeFile(
      "pkg/1/wb/app.json",
      JSON.stringify({ name: "wb", source: { type: "workbench", path: "wb.json" } }),
    );
    writeFile("pkg/1/wb/wb.json", "{}");

    const result = build({ catalog: tmp, out, backends: [new PythonBackend()], mode: "multi" });

    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => /unsupported source format "workbench"/.test(w))).toBe(true);
    const paths = relPaths(result.files);
    expect(paths).toContain("python/pkg/greet.py");
    expect(paths.some((p) => p.includes("/wb"))).toBe(false);
  });

  it("skips a suite whose every tool was skipped (no empty package)", () => {
    writeFile("project.json", JSON.stringify({ name: "proj", packages: ["only"] }));
    writeFile("only/package.json", JSON.stringify({ name: "only", default: "1" }));
    writeFile("only/1/version.json", JSON.stringify({ name: "1", apps: ["wb"] }));
    writeFile(
      "only/1/wb/app.json",
      JSON.stringify({ name: "wb", source: { type: "workbench", path: "wb.json" } }),
    );
    writeFile("only/1/wb/wb.json", "{}");

    const result = build({ catalog: tmp, out, backends: [new PythonBackend()], mode: "multi" });

    expect(result.errors).toEqual([]);
    // No package files at all, and no root pyproject listing an empty distribution.
    expect(result.files).toEqual([]);
    expect(result.warnings.some((w) => /no tools emitted, package skipped/.test(w))).toBe(true);
  });
});
