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

/** Output categories; a typo here fails typecheck instead of silently falling back. */
export type TabGroupName = "Debug" | "Schema" | "Languages" | "Workflows" | "Descriptors";

export interface TabDef {
  id: string;
  label: string;
  /** Category the output belongs to; drives the grouped selector UI. */
  group: TabGroupName;
  lang: BundledLanguage | "ir" | "bindings" | "argtype";
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
    group: "Debug",
    lang: "ir",
    compute: (c) => single("ir", format(c.parse.expr)),
  },
  {
    id: "bindings",
    label: "Bindings",
    group: "Debug",
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
    group: "Schema",
    lang: "json",
    compute: (c) => emitWithPackage(jsonSchemaBackend, c),
  },
  {
    id: "python",
    label: "Python",
    group: "Languages",
    lang: "python" as BundledLanguage,
    compute: (c) => emitWithPackage(pythonBackend, c),
  },
  {
    id: "typescript",
    label: "TypeScript",
    group: "Languages",
    lang: "typescript" as BundledLanguage,
    compute: (c) => emitWithPackage(typescriptBackend, c),
  },
  {
    id: "nipype",
    label: "Nipype",
    group: "Workflows",
    lang: "python" as BundledLanguage,
    compute: (c) => emitWithPackage(nipypeBackend, c),
  },
  {
    id: "pydra",
    label: "Pydra",
    group: "Workflows",
    lang: "python" as BundledLanguage,
    compute: (c) => emitWithPackage(pydraBackend, c),
  },
  {
    id: "boutiques",
    label: "Boutiques",
    group: "Descriptors",
    lang: "json",
    compute: (c) => emitWithPackage(boutiquesBackend, c),
  },
  {
    id: "argtype",
    label: "argtype",
    group: "Descriptors",
    lang: "argtype",
    compute: (c) => emitWithPackage(argtypeBackend, c),
  },
];

export interface TabGroup {
  label: TabGroupName;
  /** Hue that color-codes the group: worn by its label, pills, and active state. */
  accent: string;
  tabs: [TabDef, ...TabDef[]];
}

/** Per-group hues; kept light so they read on the dark surface. */
const GROUP_ACCENTS: Record<TabGroupName, string> = {
  Debug: "#a5b0ff",
  Schema: "#f5b544",
  Languages: "#5fb4f0",
  Workflows: "#4ec98a",
  Descriptors: "#f07aa8",
};

/** The flat tab list grouped by `group`, preserving first-seen order. */
export const tabGroups: [TabGroup, ...TabGroup[]] = (() => {
  const byLabel = new Map<TabGroupName, [TabDef, ...TabDef[]]>();
  for (const tab of tabs) {
    const existing = byLabel.get(tab.group);
    if (existing) existing.push(tab);
    else byLabel.set(tab.group, [tab]);
  }
  return [...byLabel.entries()].map(([label, groupTabs]) => ({
    label,
    accent: GROUP_ACCENTS[label],
    tabs: groupTabs,
  })) as [TabGroup, ...TabGroup[]];
})();

/** Tab selected on first load: the flagship generated output, not a debug view. */
export const defaultTabId = "python";

// Fail fast in dev if the default is ever renamed/removed, rather than silently
// falling back to the first tab with no pill showing active.
if (!tabs.some((t) => t.id === defaultTabId)) {
  throw new Error(`defaultTabId "${defaultTabId}" is not a known tab id`);
}
