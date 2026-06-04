import { describe, expect, it } from "vitest";
import { generate, generateCtx, lit, rep, seq, str } from "./test-helpers.js";
import { generateTypeScript, TypeScriptBackend } from "./typescript.js";

// A tool with a repeated multi-field sub-struct (mrtrix `-config key value` shape):
// field `config` is a list of struct{key,value}, which becomes a named type.
const withNestedStruct = (id: string) =>
  generate(seq(lit(id), rep(seq(str("key"), str("value")), "config")), { app: { id } });

describe("TypeScript nested type prefixing", () => {
  it("prefixes a nested struct type with the tool id", () => {
    const code = withNestedStruct("mytool");
    // Nested struct named `<Tool>Config`, not a bare suite-colliding `Config`.
    expect(code).toContain("MytoolConfig");
    expect(code).not.toMatch(/\binterface Config\b/);
  });

  it("keeps distinct tools' same-named nested types globally distinct", () => {
    expect(withNestedStruct("toola")).toContain("ToolaConfig");
    expect(withNestedStruct("toolb")).toContain("ToolbConfig");
  });
});

describe("TypeScript shared package scope", () => {
  it("suffix-dodges a top-level name reused across tools sharing a scope", () => {
    const backend = new TypeScriptBackend();
    const scope = backend.newPackageScope();
    const expr = seq(lit("report"), str("input"));
    // Two tools with the same id (forced collision) emitted into one package scope.
    const a = generateTypeScript(generateCtx(expr, { app: { id: "report" } }), scope);
    const b = generateTypeScript(generateCtx(expr, { app: { id: "report" } }), scope);
    expect(a).toMatch(/\bReport\b/);
    expect(b).toContain("Report2");
  });

  it("does not dodge when each tool gets its own scope (default)", () => {
    const expr = seq(lit("report"), str("input"));
    const a = generateTypeScript(generateCtx(expr, { app: { id: "report" } }));
    const b = generateTypeScript(generateCtx(expr, { app: { id: "report" } }));
    expect(a).toBe(b);
    expect(b).not.toContain("Report2");
  });
});
