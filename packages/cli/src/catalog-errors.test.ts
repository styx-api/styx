import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCatalog } from "./catalog.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "styx-cat-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const full = path.join(tmp, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("loadCatalog: malformed JSON", () => {
  it("project.json with invalid JSON includes the file path in the error", () => {
    writeFile("project.json", "{ not valid json");
    expect(() => loadCatalog(tmp)).toThrow(/project\.json: invalid JSON/);
  });

  it("package.json with invalid JSON includes the file path in the error", () => {
    writeFile("package.json", '{ "name": "x", ');
    expect(() => loadCatalog(tmp)).toThrow(/package\.json: invalid JSON/);
  });

  it("version.json with invalid JSON includes the file path in the error", () => {
    writeFile("version.json", "garbage");
    expect(() => loadCatalog(tmp)).toThrow(/version\.json: invalid JSON/);
  });

  it("app.json with invalid JSON includes the file path in the error", () => {
    writeFile("app.json", "[1, 2,");
    expect(() => loadCatalog(tmp)).toThrow(/app\.json: invalid JSON/);
  });

  it("nested malformed app.json surfaces during a project-level walk", () => {
    writeFile("project.json", JSON.stringify({ name: "p", packages: ["pkg"] }));
    writeFile("pkg/package.json", JSON.stringify({ name: "pkg", default: "1" }));
    writeFile("pkg/1/version.json", JSON.stringify({ name: "1", apps: ["tool"] }));
    writeFile("pkg/1/tool/app.json", "{{{");
    expect(() => loadCatalog(tmp)).toThrow(/pkg[\\/]1[\\/]tool[\\/]app\.json: invalid JSON/);
  });
});

describe("loadCatalog: missing source.path in app.json", () => {
  it("throws with a clear message when app.json has no source.path", () => {
    writeFile("app.json", JSON.stringify({ name: "tool" }));
    expect(() => loadCatalog(tmp)).toThrow(/app\.json: missing source\.path/);
  });

  it("throws when source object is present but empty", () => {
    writeFile("app.json", JSON.stringify({ name: "tool", source: {} }));
    expect(() => loadCatalog(tmp)).toThrow(/app\.json: missing source\.path/);
  });

  it("skips a sourceless stub during a project-level walk and warns", () => {
    // Real catalogs (niwrap) list not-yet-wrapped tools alongside wrapped ones;
    // a stub must not abort the whole build - it is skipped with a warning.
    writeFile("project.json", JSON.stringify({ name: "p", packages: ["pkg"] }));
    writeFile("pkg/package.json", JSON.stringify({ name: "pkg", default: "1" }));
    writeFile("pkg/1/version.json", JSON.stringify({ name: "1", apps: ["wrapped", "stub"] }));
    writeFile(
      "pkg/1/wrapped/app.json",
      JSON.stringify({ name: "wrapped", source: { path: "x.json" } }),
    );
    writeFile("pkg/1/stub/app.json", JSON.stringify({ name: "stub" }));

    const cat = loadCatalog(tmp);
    expect(cat.packages[0]!.apps.map((a) => a.name)).toEqual(["wrapped"]);
    expect(cat.warnings).toHaveLength(1);
    expect(cat.warnings[0]).toMatch(/stub[\\/]app\.json: skipped \(no source\.path/);
  });
});

describe("loadCatalog: missing files", () => {
  it("missing app.json in an app dir is silently skipped (loose layout tolerance)", () => {
    writeFile("project.json", JSON.stringify({ name: "p", packages: ["pkg"] }));
    writeFile("pkg/package.json", JSON.stringify({ name: "pkg", default: "1" }));
    writeFile("pkg/1/version.json", JSON.stringify({ name: "1", apps: ["tool"] }));
    // tool/ exists but no app.json
    mkdirSync(path.join(tmp, "pkg", "1", "tool"), { recursive: true });

    const cat = loadCatalog(tmp);
    expect(cat.packages[0]!.apps).toEqual([]);
  });
});
