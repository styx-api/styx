import { ArgdumpParser } from "./frontend/argdump/index.js";
import { ArgtypeParser } from "./frontend/argtype/index.js";
import { BoutiquesParser } from "./frontend/boutiques/index.js";
import { MrtrixParser } from "./frontend/mrtrix/index.js";
import { WorkbenchParser } from "./frontend/workbench/index.js";
import { detectFormat } from "./frontend/detect-format.js";
import type { FormatName } from "./frontend/detect-format.js";
import type { ParseResult } from "./frontend/frontend.js";

export * from "./backend/index.js";
export * from "./bindings/index.js";
export * from "./frontend/index.js";
export * from "./ir/index.js";
export * from "./manifest/index.js";
export * from "./solver/index.js";

export function compile(
  source: string,
  filenameOrOptions?: string | { format?: FormatName; filename?: string },
): ParseResult {
  const options =
    typeof filenameOrOptions === "string"
      ? { filename: filenameOrOptions }
      : (filenameOrOptions ?? {});

  // An explicit `.argtype` filename selects the DSL frontend even though the
  // source is not JSON (detection by content is a fallback).
  const byExtension = options.filename?.endsWith(".argtype") ? "argtype" : undefined;
  const format = options.format ?? byExtension ?? detectFormat(source);

  if (!format) {
    return {
      expr: { kind: "sequence", attrs: { nodes: [] } },
      errors: [{ message: "Could not detect input format. Specify format explicitly." }],
      warnings: [],
    };
  }

  const parser = ((): { parse: (s: string, f?: string) => ParseResult } => {
    switch (format) {
      case "argdump":
        return new ArgdumpParser();
      case "argtype":
        return new ArgtypeParser();
      case "workbench":
        return new WorkbenchParser();
      case "mrtrix":
        return new MrtrixParser();
      case "boutiques":
        return new BoutiquesParser();
      default: {
        const _exhaustive: never = format;
        return new BoutiquesParser();
      }
    }
  })();
  return parser.parse(source, options.filename);
}
