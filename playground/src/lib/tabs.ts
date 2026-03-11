import {
  format,
  formatSolveResult,
  BoutiquesBackend,
  JsonSchemaBackend,
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
const typescriptBackend = new TypeScriptBackend();

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
    compute: ({ solveResult, parseResult }) => formatSolveResult(solveResult, parseResult.expr),
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
    compute: ({ ctx }) => [...typescriptBackend.emit(ctx).files.values()][0] ?? "",
  },
  {
    id: "boutiques",
    label: "Boutiques",
    lang: "json",
    compute: ({ ctx }) => boutiquesBackend.emit(ctx).files.get("descriptor.json") ?? "{}",
  },
];
