import { describe, expect, it } from "vitest";
import { generate, generateCtx, lit, rep, seq, str } from "./test-helpers.js";
import { generatePython, PythonBackend } from "./python.js";

// A repeated multi-field sub-struct (mrtrix `-config key value` shape): field
// `config` is a list of struct{key,value}, which becomes a named type.
const withNestedStruct = (id: string) =>
  generate(seq(lit(id), rep(seq(str("key"), str("value")), "config")), { app: { id } });

describe("Python nested type prefixing", () => {
  it("prefixes a nested struct type with the tool id", () => {
    const code = withNestedStruct("mytool");
    expect(code).toContain("MytoolConfig");
    // A bare `Config` class would shadow other tools via `from .x import *`.
    expect(code).not.toMatch(/\bclass Config\b/);
  });

  it("keeps distinct tools' same-named nested types globally distinct", () => {
    expect(withNestedStruct("toola")).toContain("ToolaConfig");
    expect(withNestedStruct("toolb")).toContain("ToolbConfig");
  });
});

describe("Python shared package scope", () => {
  it("suffix-dodges a top-level name reused across tools sharing a scope", () => {
    const backend = new PythonBackend();
    const scope = backend.newPackageScope();
    const expr = seq(lit("report"), str("input"));
    const a = generatePython(generateCtx(expr, { app: { id: "report" } }), scope);
    const b = generatePython(generateCtx(expr, { app: { id: "report" } }), scope);
    expect(a).toMatch(/\bReport\b/);
    expect(b).toContain("Report2");
  });

  it("does not dodge when each tool gets its own scope (default)", () => {
    const expr = seq(lit("report"), str("input"));
    const a = generatePython(generateCtx(expr, { app: { id: "report" } }));
    const b = generatePython(generateCtx(expr, { app: { id: "report" } }));
    expect(a).toBe(b);
    expect(b).not.toContain("Report2");
  });
});
