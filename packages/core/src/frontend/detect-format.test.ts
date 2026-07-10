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

  it("detects boutiques regardless of leading whitespace before the brace", () => {
    const source =
      "  \n  " + JSON.stringify({ name: "tool", "command-line": "tool [X]", inputs: [] });
    expect(detectFormat(source)).toBe("boutiques");
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

  it("detects a bare terminal or literal root as argtype", () => {
    // These are valid argtype but also valid JSON scalars; the leading-char
    // rule keeps them from being swallowed and rejected as "not an object".
    expect(detectFormat("int")).toBe("argtype");
    expect(detectFormat('"hello"')).toBe("argtype");
    expect(detectFormat("42")).toBe("argtype");
  });

  it("treats any non-brace, non-blank source as argtype", () => {
    // The only non-JSON frontend is argtype, so anything that does not open as
    // a JSON object is handed to the argtype parser (which reports its own
    // errors) rather than left undetected.
    expect(detectFormat("not json")).toBe("argtype");
    expect(detectFormat("the cat sat (here)")).toBe("argtype");
    expect(detectFormat("[]")).toBe("argtype");
  });

  it("returns null for a brace-leading object that matches no known JSON format", () => {
    const source = JSON.stringify({ foo: "this mentions seq( in a value" });
    expect(detectFormat(source)).toBeNull();
  });

  it("returns null for ambiguous input", () => {
    expect(detectFormat(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null for blank or whitespace-only input", () => {
    expect(detectFormat("")).toBeNull();
    expect(detectFormat("   \n  \t ")).toBeNull();
  });

  it("returns null for a brace-leading source that is not valid JSON yet", () => {
    // Mid-edit: opens like an object but does not parse.
    expect(detectFormat('{ "name": ')).toBeNull();
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
