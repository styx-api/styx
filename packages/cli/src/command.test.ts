import * as path from "node:path";
import { describe, expect, it } from "vitest";

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
