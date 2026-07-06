export type FormatName = "boutiques" | "argdump" | "workbench" | "mrtrix" | "argtype";

/** Matches an argtype combinator call, e.g. `seq(` - the cheapest reliable
 * marker that a non-JSON source is the argtype DSL. */
const ARGTYPE_COMBINATOR = /\b(?:seq|set|opt|rep|alt|any)\s*\(/;

/** Matches a top-level argtype definition (`name: expr` / `"name": expr`) whose
 * right-hand side opens with a terminal, combinator, literal, template, or
 * group - so a combinator-free spec like `bet: path` is still recognized. */
const ARGTYPE_DEFINITION =
  /^[ \t]*(?:[A-Za-z_]\w*|"(?:[^"\\]|\\.)*")[ \t]*:[ \t]*(?:(?:int|float|str|path|seq|set|opt|rep|alt|any)\b|["`(])/m;

/** The first non-blank line of a source, trimmed (empty string if none). */
function firstNonBlankLine(source: string): string {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/**
 * Auto-detect the format of a descriptor source string.
 * Returns null if the format cannot be determined.
 */
export function detectFormat(source: string): FormatName | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Not JSON: the only non-JSON format is the argtype DSL. Recognize it by a
    // `---` frontmatter fence (allowing leading blank lines, as the parser
    // does), an argtype combinator call, or a top-level `name: expr` definition.
    if (
      firstNonBlankLine(source) === "---" ||
      ARGTYPE_COMBINATOR.test(source) ||
      ARGTYPE_DEFINITION.test(source)
    ) {
      return "argtype";
    }
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
