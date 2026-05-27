import { describe, expect, it } from "vitest";
import { appModuleName } from "./typescript.js";
import { generate, lit, opt, seq } from "./test-helpers.js";

describe("TypeScript name dodging - host vs wire", () => {
  it("scrubs TS reserved-word field names with trailing underscore", () => {
    const code = generate(
      seq(lit("cmd"), opt(seq(lit("--class"), { kind: "str", attrs: {}, meta: { name: "class" } }))),
      { app: { id: "tool" } },
    );
    // Signature uses scrubbed host name (class_); the wire key (class) stays
    // in dict assignments via dot notation since TS allows reserved words
    // as property names.
    expect(code).toMatch(/class_:\s*string\s*\|\s*null/);
    expect(code).toMatch(/params\.class\s*=\s*class_/);
  });

  it("prefixes digit-leading field names with v_", () => {
    const code = generate(
      seq(lit("cmd"), { kind: "path", attrs: {}, meta: { name: "4d_input" } }),
      { app: { id: "tool" } },
    );
    expect(code).toMatch(/v_4d_input:\s*InputPathType/);
    // Object literal key for non-ident wire key is quoted
    expect(code).toMatch(/"4d_input":\s*v_4d_input/);
    // Property access path uses bracket notation
    expect(code).toMatch(/params\["4d_input"\]/);
  });

  it("dodges collisions with function-local names (runner/params)", () => {
    const code = generate(
      seq(lit("cmd"), { kind: "str", attrs: {}, meta: { name: "runner" } }),
      { app: { id: "tool" } },
    );
    expect(code).toMatch(/runner_2:\s*string/);
    expect(code).toMatch(/runner:\s*runner_2/);
  });

  it("scrubs digit-leading app ids in public names", () => {
    // `3dPFM` -> derived names would otherwise start with a digit. The
    // public-name scrub prepends `v_` before case conversion.
    const code = generate(seq(lit("3dPFM")), { app: { id: "3dPFM" } });
    expect(code).toMatch(/export function v3dPfm\b/);
    expect(code).toMatch(/V_3D_PFM_METADATA\b/);
  });

  it("scrubs digit-leading app ids in appModuleName for file name", () => {
    expect(appModuleName({ id: "3dPFM" })).toBe("v_3d_pfm");
    expect(appModuleName({ id: "class" })).toBe("class_");
    expect(appModuleName({ id: "normal_tool" })).toBe("normal_tool");
  });

  it("quotes non-identifier wire keys in interface fields", () => {
    const code = generate(
      seq(lit("cmd"), { kind: "path", attrs: {}, meta: { name: "4d_input" } }),
      { app: { id: "tool" } },
    );
    // Interface field must be quoted since `4d_input` isn't a valid identifier
    expect(code).toMatch(/"4d_input":\s*InputPathType/);
  });
});
