import { describe, expect, it } from "vitest";
import { CodeBuilder } from "../code-builder.js";
import { emitJsDoc } from "./emit.js";

function jsdoc(text: string): string {
  const cb = new CodeBuilder();
  emitJsDoc(cb, text);
  return cb.toString();
}

describe("emitJsDoc escaping", () => {
  it("escapes `*/` so it cannot terminate the block comment", () => {
    const out = jsdoc("ends a comment */ then more");
    expect(out).not.toContain("*/ then");
    // The only bare `*/` is the closing fence.
    expect(out.split("*/").length - 1).toBe(1);
  });

  it("leaves ordinary text untouched", () => {
    expect(jsdoc("hello")).toBe("/** hello */");
  });
});
