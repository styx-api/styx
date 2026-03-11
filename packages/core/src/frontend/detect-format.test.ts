import { describe, expect, it } from "vitest";
import { detectFormat } from "./detect-format.js";

describe("detectFormat", () => {
  it("detects boutiques by command-line key", () => {
    const source = JSON.stringify({ name: "tool", "command-line": "tool [X]", inputs: [] });
    expect(detectFormat(source)).toBe("boutiques");
  });

  it("detects boutiques by inputs + name", () => {
    const source = JSON.stringify({ name: "tool", inputs: [{ id: "x" }] });
    expect(detectFormat(source)).toBe("boutiques");
  });

  it("detects argdump by actions + prog", () => {
    const source = JSON.stringify({ prog: "tool", actions: [] });
    expect(detectFormat(source)).toBe("argdump");
  });

  it("detects argdump by $schema containing argdump", () => {
    const source = JSON.stringify({
      $schema: "https://niwrap.dev/argdump/schema-v1.json",
      prog: "tool",
    });
    expect(detectFormat(source)).toBe("argdump");
  });

  it("returns null for invalid JSON", () => {
    expect(detectFormat("not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(detectFormat('"string"')).toBeNull();
    expect(detectFormat("[]")).toBeNull();
  });

  it("returns null for ambiguous input", () => {
    expect(detectFormat(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("prefers $schema detection over key heuristics", () => {
    const source = JSON.stringify({
      $schema: "https://niwrap.dev/argdump/schema-v1.json",
      "command-line": "something",
      prog: "tool",
      actions: [],
    });
    expect(detectFormat(source)).toBe("argdump");
  });

  it("boutiques takes priority over argdump for ambiguous keys", () => {
    // Has both command-line (boutiques) and actions+prog (argdump)
    const source = JSON.stringify({
      name: "tool",
      "command-line": "tool [X]",
      prog: "tool",
      actions: [],
    });
    expect(detectFormat(source)).toBe("boutiques");
  });
});
