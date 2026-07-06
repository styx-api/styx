import { describe, expect, it } from "vitest";

import { knownBackends, resolveBackends } from "./backends.js";

describe("backends", () => {
  it("exposes the registered aliases", () => {
    expect(knownBackends).toContain("python");
    expect(knownBackends).toContain("typescript");
    expect(knownBackends).toContain("boutiques");
    expect(knownBackends).toContain("argtype");
    expect(knownBackends).toContain("schema");
  });

  it("resolves the argtype serialization backend", () => {
    const { backends, unknown } = resolveBackends(["argtype"]);
    expect(unknown).toEqual([]);
    expect(backends.map((b) => b.name)).toEqual(["argtype"]);
  });

  it("resolves aliases to backend instances", () => {
    const { backends, unknown } = resolveBackends(["python", "typescript"]);
    expect(unknown).toEqual([]);
    expect(backends.map((b) => b.name).sort()).toEqual(["python", "typescript"]);
  });

  it("deduplicates aliases that resolve to the same backend", () => {
    const { backends } = resolveBackends(["typescript", "ts"]);
    expect(backends).toHaveLength(1);
    expect(backends[0]!.name).toBe("typescript");
  });

  it("reports unknown names", () => {
    const { backends, unknown } = resolveBackends(["python", "rust"]);
    expect(backends.map((b) => b.name)).toEqual(["python"]);
    expect(unknown).toEqual(["rust"]);
  });
});
