import { describe, expect, it } from "vitest";
import { CodeBuilder } from "../code-builder.js";
import { emitDocstring } from "./emit.js";

function doc(text: string): string {
  const cb = new CodeBuilder();
  emitDocstring(cb, text);
  return cb.toString();
}

describe("emitDocstring escaping", () => {
  it("escapes an embedded triple-quote so it cannot close the docstring", () => {
    const out = doc('see """this""" note');
    expect(out).not.toContain('"""this"""');
    // The opening/closing fences are the only bare triple-quotes.
    expect(out.split('"""').length - 1).toBe(2);
  });

  it("does not use the single-line form for text ending in a backslash", () => {
    // `"""use \"""` would escape the closing quotes; must go multi-line.
    const out = doc("use \\");
    expect(out).toBe('"""\nuse \\\n"""');
  });

  it("keeps the single-line form for plain short text", () => {
    expect(doc("hello")).toBe('"""hello"""');
  });
});
