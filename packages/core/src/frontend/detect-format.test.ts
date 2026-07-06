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

  it("detects workbench by command + short_description", () => {
    const source = JSON.stringify({
      command: "-border-merge",
      short_description: "MERGE BORDER FILES",
      params: [],
    });
    expect(detectFormat(source)).toBe("workbench");
  });

  it("detects mrtrix by synopsis + option_groups + arguments", () => {
    const source = JSON.stringify({
      name: "5tt2gmwmi",
      synopsis: "Generate a mask image",
      arguments: [{ id: "in", type: "image in" }],
      option_groups: [{ name: "OPTIONS", options: [] }],
    });
    expect(detectFormat(source)).toBe("mrtrix");
  });

  it("detects argtype by a combinator call", () => {
    expect(detectFormat("bet: seq(infile: path)")).toBe("argtype");
    expect(detectFormat("x: opt(str)")).toBe("argtype");
  });

  it("detects argtype by a leading frontmatter fence", () => {
    expect(detectFormat('---\nexe: "bet"\n---\nbet: path')).toBe("argtype");
  });

  it("detects argtype by a frontmatter fence after leading blank lines", () => {
    // The parser tolerates blank lines before the fence, so detection must too.
    expect(detectFormat('\n\n---\nexe: "bet"\n---\nbet: path')).toBe("argtype");
  });

  it("detects a combinator-free argtype definition (bare terminal root)", () => {
    expect(detectFormat("bet: path")).toBe("argtype");
    expect(detectFormat("x: int")).toBe("argtype");
    expect(detectFormat('greeting: "hello"')).toBe("argtype");
    expect(detectFormat('"1deval": path')).toBe("argtype");
  });

  it("returns null for non-JSON prose that is not argtype", () => {
    expect(detectFormat("not json")).toBeNull();
    expect(detectFormat("the cat sat (here)")).toBeNull();
  });

  it("never misclassifies valid JSON as argtype even if a string contains seq(", () => {
    // Valid JSON parses successfully and never reaches the argtype text check.
    const source = JSON.stringify({ foo: "this mentions seq( in a value" });
    expect(detectFormat(source)).toBeNull();
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
