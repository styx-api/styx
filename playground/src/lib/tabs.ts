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
  compute: (solved: SolvedParseResult) => Map<string, string>;
}

const boutiquesBackend = new BoutiquesBackend();
const jsonSchemaBackend = new JsonSchemaBackend();
const pythonBackend = new PythonBackend();
const typescriptBackend = new TypeScriptBackend();

function single(name: string, content: string): Map<string, string> {
  return new Map([[name, content]]);
}

export const tabs: TabDef[] = [
  {
    id: "ir",
    label: "IR",
    lang: "ir",
    compute: ({ parseResult }) => single("ir", format(parseResult.expr)),
  },
  {
    id: "bindings",
    label: "Bindings",
    lang: "bindings",
    compute: ({ solveResult, parseResult, ctx }) =>
      single(
        "bindings",
        formatSolveResult(solveResult, parseResult.expr, {
          scopes: ctx.outputScopes,
          diagnostics: ctx.outputDiagnostics,
        }),
      ),
  },
  {
    id: "schema",
    label: "JSON Schema",
    lang: "json",
    compute: ({ ctx }) => jsonSchemaBackend.emit(ctx).files,
  },
  {
    id: "typescript",
    label: "TypeScript",
    lang: "typescript" as BundledLanguage,
    compute: ({ ctx }) => typescriptBackend.emit(ctx).files,
  },
  {
    id: "python",
    label: "Python",
    lang: "python" as BundledLanguage,
    compute: ({ ctx }) => pythonBackend.emit(ctx).files,
  },
  {
    id: "boutiques",
    label: "Boutiques",
    lang: "json",
    compute: ({ ctx }) => boutiquesBackend.emit(ctx).files,
  },
];
