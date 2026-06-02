import { ArgdumpParser } from "./frontend/argdump/index.js";
import { BoutiquesParser } from "./frontend/boutiques/index.js";
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

  const format = options.format ?? detectFormat(source);

  if (!format) {
    return {
      expr: { kind: "sequence", attrs: { nodes: [] } },
      errors: [{ message: "Could not detect input format. Specify format explicitly." }],
      warnings: [],
    };
  }

  const parser =
    format === "argdump"
      ? new ArgdumpParser()
      : format === "workbench"
        ? new WorkbenchParser()
        : new BoutiquesParser();
  return parser.parse(source, options.filename);
}
