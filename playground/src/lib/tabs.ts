import {
  format,
  formatSolveResult,
  BoutiquesBackend,
  JsonSchemaBackend,
  PythonBackend,
  TypeScriptBackend,
  type ParseResult,
  type CodegenContext,
  type SolveResult,
} from "@styx/core";
import type { BundledLanguage } from "shiki";

export interface SolvedParseResult {
  parseResult: ParseResult;
  solveResult: SolveResult;
  ctx: CodegenContext;
}

export interface TabDef {
  id: string;
  label: string;
  lang: BundledLanguage | "ir" | "bindings";
  compute: (solved: SolvedParseResult) => string;
}

const boutiquesBackend = new BoutiquesBackend();
const jsonSchemaBackend = new JsonSchemaBackend();
const pythonBackend = new PythonBackend();
const typescriptBackend = new TypeScriptBackend();

/** Concatenate emitted files with a comment-prefixed header per file. */
function joinFiles(files: Map<string, string>, commentPrefix: string): string {
  const parts: string[] = [];
  for (const [name, content] of files) {
    const bar = "=".repeat(60);
    parts.push(`${commentPrefix}${bar}\n${commentPrefix}${name}\n${commentPrefix}${bar}\n${content}`);
  }
  return parts.join("\n\n");
}

export const tabs: TabDef[] = [
  {
    id: "ir",
    label: "IR",
    lang: "ir",
    compute: ({ parseResult }) => format(parseResult.expr),
  },
  {
    id: "bindings",
    label: "Bindings",
    lang: "bindings",
    compute: ({ solveResult, parseResult, ctx }) =>
      formatSolveResult(solveResult, parseResult.expr, {
        scopes: ctx.outputScopes,
        diagnostics: ctx.outputDiagnostics,
      }),
  },
  {
    id: "schema",
    label: "JSON Schema",
    lang: "json",
    compute: ({ ctx }) => jsonSchemaBackend.emit(ctx).files.get("schema.json") ?? "{}",
  },
  {
    id: "typescript",
    label: "TypeScript",
    lang: "typescript" as BundledLanguage,
    compute: ({ ctx }) => joinFiles(typescriptBackend.emit(ctx).files, "// "),
  },
  {
    id: "python",
    label: "Python",
    lang: "python" as BundledLanguage,
    compute: ({ ctx }) => joinFiles(pythonBackend.emit(ctx).files, "# "),
  },
  {
    id: "boutiques",
    label: "Boutiques",
    lang: "json",
    compute: ({ ctx }) => boutiquesBackend.emit(ctx).files.get("descriptor.json") ?? "{}",
  },
];
