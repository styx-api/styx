import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildCommand } from "./command.js";

const FIXTURE = path.resolve(import.meta.dirname, "..", "test-fixtures", "mini-catalog");
const GREET = path.join(FIXTURE, "tools", "1.0", "greet", "boutiques.json");

describe("runBuildCommand: arg validation (exit 2)", () => {
  it("requires -o/--out", () => {
    const r = runBuildCommand(GREET, { backend: "python", mode: "scripts" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("error: -o/--out is required");
    expect(r.files).toEqual([]);
  });

  it("rejects unknown backends", () => {
    const r = runBuildCommand(GREET, { out: "/out", backend: "rust", mode: "scripts" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr[0]).toBe("error: unknown backend(s): rust");
    expect(r.stderr[1]).toMatch(/^known: /);
  });

  it("rejects empty backend list", () => {
    const r = runBuildCommand(GREET, { out: "/out", backend: "", mode: "scripts" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("error: no backends selected");
  });

  it("rejects bad mode strings", () => {
    const r = runBuildCommand(GREET, { out: "/out", backend: "python", mode: "everything" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr[0]).toMatch(/--mode must be one of scripts \| single \| multi/);
  });
});

describe("runBuildCommand: build errors (exit 1)", () => {
  it("missing both input and catalog returns exit 1", () => {
    const r = runBuildCommand(undefined, { out: "/out", backend: "python", mode: "scripts" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("error: missing input: pass a descriptor path or --catalog");
  });

  it("both input and catalog returns exit 1", () => {
    const r = runBuildCommand(GREET, {
      out: "/out",
      catalog: FIXTURE,
      backend: "python",
      mode: "scripts",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("error: --input and --catalog are mutually exclusive");
  });

  it("nonexistent input file returns exit 1 with file context", () => {
    const r = runBuildCommand(path.join(FIXTURE, "does-not-exist.json"), {
      out: "/out",
      backend: "python",
      mode: "scripts",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.some((l) => l.includes("does-not-exist.json"))).toBe(true);
  });
});

describe("runBuildCommand: partial catalog output (exit 1, files kept)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "styx-partial-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
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

  it("keeps the files of tools that compiled when one tool in the catalog fails", () => {
    writeFile("project.json", JSON.stringify({ name: "proj", packages: ["pkg"] }));
    writeFile("pkg/package.json", JSON.stringify({ name: "pkg", default: "1" }));
    writeFile("pkg/1/version.json", JSON.stringify({ name: "1", apps: ["greet", "broken"] }));
    writeFile(
      "pkg/1/greet/app.json",
      JSON.stringify({ name: "greet", source: { type: "boutiques", path: "d.json" } }),
    );
    writeFile("pkg/1/greet/d.json", BOUTIQUES);
    writeFile(
      "pkg/1/broken/app.json",
      JSON.stringify({ name: "broken", source: { type: "boutiques", path: "missing.json" } }),
    );
    // broken/missing.json is absent -> read failure -> real per-tool error.

    const r = runBuildCommand(undefined, {
      out: "/out",
      catalog: tmp,
      backend: "python",
      mode: "multi",
    });

    // Non-zero exit so the failure is visible, but the tool that compiled survives.
    expect(r.exitCode).toBe(1);
    expect(r.files.some((f) => f.path.endsWith(path.join("greet.py")))).toBe(true);
    expect(r.stdout.some((l) => /^wrote \d+ file/.test(l))).toBe(true);
  });
});

describe("runBuildCommand: happy path (exit 0)", () => {
  it("returns files and a 'wrote N files' message", () => {
    const r = runBuildCommand(GREET, { out: "/out", backend: "python", mode: "scripts" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toEqual([]);
    expect(r.files).toHaveLength(1);
    expect(r.stdout).toEqual(["wrote 1 file to /out"]);
  });

  it("pluralizes when more than one file is emitted", () => {
    const r = runBuildCommand(undefined, {
      out: "/out",
      catalog: FIXTURE,
      backend: "python",
      mode: "single",
    });
    expect(r.exitCode).toBe(0);
    // single mode: 2 app modules + __init__.py + py.typed.
    expect(r.stdout[0]).toBe("wrote 4 files to /out");
  });

  it("comma-separated backends produce per-backend output dirs", () => {
    const r = runBuildCommand(GREET, {
      out: "/out",
      backend: "python,typescript",
      mode: "scripts",
    });
    expect(r.exitCode).toBe(0);
    const targets = new Set(r.files.map((f) => path.relative("/out", f.path).split(path.sep)[0]));
    expect(targets).toEqual(new Set(["python", "typescript"]));
  });

  it("repeated -b flags accumulate (cac surfaces a string[] for repeats)", () => {
    const r = runBuildCommand(GREET, {
      out: "/out",
      backend: ["python", "typescript"],
      mode: "scripts",
    });
    expect(r.exitCode).toBe(0);
    expect(r.files).toHaveLength(2);
  });

  it("default mode is scripts", () => {
    const r = runBuildCommand(undefined, {
      out: "/out",
      catalog: FIXTURE,
      backend: "python",
    });
    expect(r.exitCode).toBe(0);
    // scripts mode skips emitPackage, so no __init__.py.
    expect(r.files.some((f) => f.path.endsWith("__init__.py"))).toBe(false);
  });
});
