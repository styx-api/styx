import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { detectLevel, loadCatalog } from "./catalog.js";

const FIXTURE = path.resolve(import.meta.dirname, "..", "test-fixtures", "mini-catalog");

describe("catalog discovery", () => {
  it("detects each level by index file", () => {
    expect(detectLevel(FIXTURE)).toBe("project");
    expect(detectLevel(path.join(FIXTURE, "tools"))).toBe("package");
    expect(detectLevel(path.join(FIXTURE, "tools", "1.0"))).toBe("version");
    expect(detectLevel(path.join(FIXTURE, "tools", "1.0", "greet"))).toBe("app");
  });

  it("returns null for non-catalog dirs", () => {
    expect(detectLevel(import.meta.dirname)).toBeNull();
  });

  it("loads the full hierarchy from the project root", () => {
    const cat = loadCatalog(FIXTURE);
    expect(cat.meta.name).toBe("miniproject");
    expect(cat.meta.version).toBe("0.1.0");
    expect(cat.meta.doc?.title).toBe("Mini Project");
    expect(cat.meta.license?.description).toBe("MIT");
    expect(cat.packages).toHaveLength(1);

    const pkg = cat.packages[0]!;
    expect(pkg.meta.name).toBe("tools");
    expect(pkg.meta.version).toBe("1.0");
    expect(pkg.meta.docker).toBe("miniproject/tools:1.0");
    expect(pkg.apps.map((a) => a.name).sort()).toEqual(["farewell", "greet"]);
  });

  it("walks from a package root and finds the default version", () => {
    const cat = loadCatalog(path.join(FIXTURE, "tools"));
    expect(cat.packages).toHaveLength(1);
    expect(cat.packages[0]!.meta.version).toBe("1.0");
    expect(cat.packages[0]!.apps).toHaveLength(2);
  });

  it("walks from a version root", () => {
    const cat = loadCatalog(path.join(FIXTURE, "tools", "1.0"));
    expect(cat.packages).toHaveLength(1);
    // Parent package.json is read so the package name is populated.
    expect(cat.packages[0]!.meta.name).toBe("tools");
    expect(cat.packages[0]!.apps).toHaveLength(2);
  });

  it("walks from a single-app root", () => {
    const cat = loadCatalog(path.join(FIXTURE, "tools", "1.0", "greet"));
    expect(cat.packages[0]!.apps).toHaveLength(1);
    expect(cat.packages[0]!.apps[0]!.name).toBe("greet");
  });

  it("throws when handed a non-catalog directory", () => {
    expect(() => loadCatalog(import.meta.dirname)).toThrow(/not a catalog root/);
  });
});
