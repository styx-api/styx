export type FormatName = "boutiques" | "argdump" | "workbench" | "mrtrix" | "argtype";

/** The first non-whitespace character of a source ("" if it is all blank). */
function firstNonBlankChar(source: string): string {
  const match = source.match(/\S/);
  return match ? match[0] : "";
}

/**
 * Auto-detect the format of a descriptor source string.
 *
 * Every JSON frontend (boutiques, argdump, workbench, mrtrix) is a top-level
 * object, so the first non-blank character being `{` is the signal for "some
 * JSON format"; we then inspect its keys to pick which one. Anything else
 * non-blank is treated as the argtype DSL, whose sources open with a terminal
 * (`int`), a literal (`"hello"`), a combinator (`seq(...)`), a `name: expr`
 * definition, or a `---` frontmatter fence - never with `{`.
 *
 * Deciding on the leading character (rather than trying `JSON.parse` first) is
 * what lets standalone argtype snippets like `"hello"` or `42` be recognized:
 * those are *also* valid JSON scalars, so a parse-first approach would swallow
 * them and then reject them as "not an object".
 *
 * Returns null only when the source is blank, or opens with `{` but matches no
 * known JSON format (ambiguous, or still being typed).
 */
export function detectFormat(source: string): FormatName | null {
  const first = firstNonBlankChar(source);
  if (first === "") return null;
  if (first !== "{") return "argtype";

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Opens like a JSON object but is not valid (yet) - e.g. mid-edit.
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Check $schema for argdump
  if (typeof obj.$schema === "string" && obj.$schema.includes("argdump")) {
    return "argdump";
  }

  // Workbench: has a "command" switch plus "short_description"
  if (typeof obj.command === "string" && typeof obj.short_description === "string") {
    return "workbench";
  }

  // MRtrix C++ dump: a "synopsis" string plus "option_groups" and "arguments" arrays
  if (
    typeof obj.synopsis === "string" &&
    Array.isArray(obj.option_groups) &&
    Array.isArray(obj.arguments)
  ) {
    return "mrtrix";
  }

  // Boutiques: has "command-line" or "inputs" array
  if ("command-line" in obj || (Array.isArray(obj.inputs) && "name" in obj)) {
    return "boutiques";
  }

  // Argdump: has "actions" array + "prog"
  if (Array.isArray(obj.actions) && "prog" in obj) {
    return "argdump";
  }

  return null;
}
