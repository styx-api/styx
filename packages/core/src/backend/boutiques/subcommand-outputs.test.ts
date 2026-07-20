import { describe, expect, it } from "vitest";
import { defaultPipeline } from "../../ir/index.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { BoutiquesParser } from "../../frontend/boutiques/parser.js";
import { createContext } from "../../manifest/context.js";
import { generatePython } from "../python/python.js";
import { generateBoutiques } from "./boutiques.js";

const parser = new BoutiquesParser();

function pipeline(descriptor: Record<string, unknown>) {
  const { expr, meta } = parser.parse(JSON.stringify(descriptor));
  const optimized = defaultPipeline.apply(expr).expr;
  const solveResult = solve(optimized);
  const outputs = resolveOutputs(optimized, solveResult);
  const ctx = createContext(optimized, solveResult, outputs, { app: meta });
  return {
    outputNames: outputs.scopes.flatMap((s) => s.outputs.map((o) => o.name)),
    python: generatePython(ctx),
    boutiques: generateBoutiques(ctx).descriptor as Record<string, unknown>,
  };
}

// A multi-field subcommand so it stays a real struct (single-field ones collapse).
function sub(id: string, cmd: string, out: string): Record<string, unknown> {
  return {
    id,
    "command-line": `${cmd} [A] [B]`,
    inputs: [
      { id: "a", "value-key": "[A]", type: "String" },
      { id: "b", "value-key": "[B]", type: "String" },
    ],
    "output-files": [{ id: out, name: out, "path-template": `[A].${out}` }],
  };
}

type BtLike = Record<string, unknown>;
const outIds = (o: unknown): string[] | undefined =>
  (o as { "output-files"?: { id: string }[] })["output-files"]?.map((f) => f.id);

function armOutputs(bt: Record<string, unknown>): Record<string, string[]> {
  const res: Record<string, string[]> = {};
  const root = outIds(bt);
  if (root?.length) res.root = root;
  for (const inp of (bt.inputs as BtLike[]) ?? []) {
    const type = inp.type;
    if (Array.isArray(type)) {
      for (const arm of type as BtLike[]) {
        const ids = outIds(arm);
        if (ids?.length) res[`arm:${arm.id as string}`] = ids;
      }
    } else if (type && typeof type === "object") {
      const ids = outIds(type);
      if (ids?.length) res[`subcmd:${inp.id as string}`] = ids;
    }
  }
  return res;
}

describe("subcommand outputs are retained", () => {
  it("plain subcommand output survives (solver, python, round-trip)", () => {
    const r = pipeline({
      name: "t",
      "command-line": "t [S]",
      inputs: [{ id: "s", "value-key": "[S]", type: sub("run", "run", "res") }],
    });
    expect(r.outputNames).toContain("res");
    expect(r.python).toContain("res: OutputPathType");
    expect(armOutputs(r.boutiques)).toMatchObject({ root: ["res"] });
  });

  it("subcommand-union: each arm keeps its own output", () => {
    const r = pipeline({
      name: "t",
      "command-line": "t [S]",
      inputs: [
        {
          id: "s",
          "value-key": "[S]",
          type: [sub("modeA", "runA", "out_a"), sub("modeB", "runB", "out_b")],
        },
      ],
    });
    expect(r.outputNames.sort()).toEqual(["out_a", "out_b"]);
    expect(r.python).toContain("out_a: OutputPathType");
    expect(r.python).toContain("out_b: OutputPathType");
    expect(armOutputs(r.boutiques)).toMatchObject({
      "arm:modeA": ["out_a"],
      "arm:modeB": ["out_b"],
    });
  });

  it("subcommand-LIST: the repeated subcommand's output is retained and list-typed", () => {
    const r = pipeline({
      name: "t",
      "command-line": "t [S]",
      inputs: [{ id: "s", "value-key": "[S]", list: true, type: sub("item", "item", "item_out") }],
    });
    expect(r.outputNames).toContain("item_out");
    // A list-scoped output is a list of paths.
    expect(r.python).toContain("item_out: list[OutputPathType]");
    // Round-trips onto the nested subcommand descriptor, flagged as a list.
    const inp = (r.boutiques.inputs as BtLike[])[0]!;
    const outFile = (inp.type as { "output-files": { id: string; list?: boolean }[] })[
      "output-files"
    ][0]!;
    expect(outFile.id).toBe("item_out");
    expect(outFile.list).toBe(true);
  });
});
