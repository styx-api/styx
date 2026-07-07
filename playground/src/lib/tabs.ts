import {
  format,
  formatSolveResult,
  ArgtypeBackend,
  BoutiquesBackend,
  JsonSchemaBackend,
  NipypeBackend,
  PydraBackend,
  PythonBackend,
  TypeScriptBackend,
} from "@styx-api/core";
import type { Backend } from "@styx-api/core";
import type { BundledLanguage } from "shiki";
import type { Compilation, SolvedParseResult } from "./compiler.js";

export interface TabDef {
  id: string;
  label: string;
  lang: BundledLanguage | "ir" | "bindings";
  compute: (c: Compilation) => Map<string, string>;
}

const argtypeBackend = new ArgtypeBackend();
const boutiquesBackend = new BoutiquesBackend();
const jsonSchemaBackend = new JsonSchemaBackend();
const nipypeBackend = new NipypeBackend();
const pydraBackend = new PydraBackend();
const pythonBackend = new PythonBackend();
const typescriptBackend = new TypeScriptBackend();

function single(name: string, content: string): Map<string, string> {
  return new Map([[name, content]]);
}

/** Unwrap the guarded solve, throwing its error so the tab renders it. */
function solved(c: Compilation): SolvedParseResult {
  if (!c.solved.ok) throw new Error(c.solved.error);
  return c.solved.value;
}

/**
 * Emit a backend's per-tool file(s) plus, for backends with a package tier,
 * the suite-level wrapper for a synthesized one-app package (e.g. Python's
 * `__init__.py`, TypeScript's `index.ts`). The wrapper files appear as
 * additional sub-tabs; backends without `emitPackage` just yield the app file.
 */
function emitWithPackage(backend: Backend, c: Compilation): Map<string, string> {
  const app = backend.emitApp(solved(c).ctx);
  const files = new Map(app.files);
  if (backend.emitPackage) {
    for (const [name, content] of backend.emitPackage({}, [app]).files) {
      files.set(name, content);
    }
  }
  return files;
}

export const tabs: [TabDef, ...TabDef[]] = [
  {
    id: "ir",
    label: "IR",
    lang: "ir",
    compute: (c) => single("ir", format(c.parse.expr)),
  },
  {
    id: "bindings",
    label: "Bindings",
    lang: "bindings",
    compute: (c) => {
      const { solveResult, parseResult, ctx } = solved(c);
      return single(
        "bindings",
        formatSolveResult(solveResult, parseResult.expr, {
          scopes: ctx.outputScopes,
          diagnostics: ctx.outputDiagnostics,
        }),
      );
    },
  },
  {
    id: "schema",
    label: "JSON Schema",
    lang: "json",
    compute: (c) => emitWithPackage(jsonSchemaBackend, c),
  },
  {
    id: "typescript",
    label: "TypeScript",
    lang: "typescript" as BundledLanguage,
    compute: (c) => emitWithPackage(typescriptBackend, c),
  },
  {
    id: "python",
    label: "Python",
    lang: "python" as BundledLanguage,
    compute: (c) => emitWithPackage(pythonBackend, c),
  },
  {
    id: "nipype",
    label: "Nipype",
    lang: "python" as BundledLanguage,
    compute: (c) => emitWithPackage(nipypeBackend, c),
  },
  {
    id: "pydra",
    label: "Pydra",
    lang: "python" as BundledLanguage,
    compute: (c) => emitWithPackage(pydraBackend, c),
  },
  {
    id: "boutiques",
    label: "Boutiques",
    lang: "json",
    compute: (c) => emitWithPackage(boutiquesBackend, c),
  },
  {
    id: "argtype",
    label: "argtype",
    // No dedicated shiki grammar; argtype is TypeScript-types-like, so borrow
    // its highlighting (strings, comments, backtick templates render sensibly).
    lang: "typescript" as BundledLanguage,
    compute: (c) => emitWithPackage(argtypeBackend, c),
  },
];
