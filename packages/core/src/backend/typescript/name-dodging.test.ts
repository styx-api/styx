import { describe, expect, it } from "vitest";
import { generate, lit, opt, path, seq } from "./test-helpers.js";

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
});
