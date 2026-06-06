export type FormatName = "boutiques" | "argdump" | "workbench" | "mrtrix";

/**
 * Auto-detect the format of a JSON descriptor source string.
 * Returns null if the format cannot be determined.
 */
export function detectFormat(source: string): FormatName | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
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
