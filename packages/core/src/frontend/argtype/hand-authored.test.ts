/**
 * Hand-authored fixture suite: realistic argtype tools written the way a human
 * (or an LLM) actually authors them, compiled end-to-end through the full
 * pipeline (parse -> IR passes -> solve -> resolve outputs -> codegen).
 *
 * Where `spec.test.ts` exercises each language feature with a minimal snippet,
 * these fixtures exercise the ergonomic sugar in combination on tools shaped
 * like their real counterparts: a digit-led AFNI name that must be quoted, an
 * FSL enum with a default variant plus numeric bounds, and a Workbench
 * subcommand whose id differs from the executable. Each must compile with zero
 * errors AND zero warnings, and a few structural facts are pinned so a
 * regression is legible rather than a bare "it stopped compiling".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Expr } from "../../ir/node.js";
import { defaultPipeline } from "../../ir/index.js";
import { createContext } from "../../manifest/context.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { generatePython } from "../../backend/python/python.js";
import { generateTypeScript } from "../../backend/typescript/typescript.js";
import { ArgtypeParser } from "./parser-frontend.js";

const parser = new ArgtypeParser();

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

/** Direct children of any node, regardless of kind. */
function kids(e: Expr): Expr[] {
  switch (e.kind) {
    case "sequence":
      return e.attrs.nodes;
    case "alternative":
      return e.attrs.alts;
    case "optional":
    case "repeat":
      return [e.attrs.node];
    default:
      return [];
  }
}

/** Depth-first search for the first node whose meta.name matches. */
function find(e: Expr, name: string): Expr | undefined {
  if (e.meta?.name === name) return e;
  for (const c of kids(e)) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** The root sequence's direct children. */
function rootKids(e: Expr): Expr[] {
  return e.kind === "sequence" ? e.attrs.nodes : [];
}

/**
 * Drive a fixture through the whole compiler, asserting the parse produced no
 * errors and no warnings (these are meant to be pristine, idiomatic sources)
 * and the output resolution produced no errors. Returns the artifacts so each
 * test can pin structural facts and generated-code content.
 */
function compileFixture(name: string) {
  const parseResult = parser.parse(fixture(name));
  expect(parseResult.errors, `${name}: parse errors`).toEqual([]);
  expect(parseResult.warnings, `${name}: parse warnings`).toEqual([]);

  const optimized = defaultPipeline.apply(parseResult.expr);
  const solveResult = solve(optimized.expr);
  const outputs = resolveOutputs(optimized.expr, solveResult);
  expect(outputs.diagnostics.errors, `${name}: output resolution errors`).toEqual([]);

  const ctx = createContext(optimized.expr, solveResult, outputs, {
    app: parseResult.meta ?? { id: "tool" },
    package: { name: "pkg" },
  });

  const ts = generateTypeScript(ctx);
  const py = generatePython(ctx);
  const allOutputs = outputs.scopes.flatMap((s) => s.outputs);
  return { parseResult, expr: optimized.expr, ctx, outputs, allOutputs, ts, py };
}

describe("argtype hand-authored fixtures", () => {
  it("afni-3dtstat: quoted digit-led name, rep+join, resolved output", () => {
    const { parseResult, expr, ctx, allOutputs, ts, py } = compileFixture("afni-3dtstat.argtype");

    // The tool id is the quoted digit-led root label; the exe is prepended as
    // the command's first literal token.
    expect(parseResult.meta?.id).toBe("3dTstat");
    expect(parseResult.meta?.version).toBe("24.2.06");
    const first = rootKids(expr)[0];
    expect(first?.kind === "literal" && first.attrs.str).toBe("3dTstat");

    // The colon-joined percentile list survived as a repeat with its separator.
    const percentiles = find(expr, "percentiles");
    expect(percentiles?.kind).toBe("repeat");
    expect(percentiles?.kind === "repeat" && percentiles.attrs.join).toBe(":");

    // The `{prefix}+orig.HEAD` template resolves to the `prefix` binding (nested
    // inside the `-prefix` opt) plus the literal suffix.
    const statfile = allOutputs.find((o) => o.name === "statfile");
    expect(statfile).toBeDefined();
    expect(statfile!.tokens[0]?.kind).toBe("ref");
    expect(statfile!.tokens[1]).toEqual({ kind: "literal", value: "+orig.HEAD" });
    if (statfile!.tokens[0]?.kind === "ref") {
      expect(ctx.bindings.get(statfile!.tokens[0].binding)?.name).toBe("prefix");
    }

    for (const field of ["prefix", "percentiles", "input"]) {
      expect(ts).toContain(field);
      expect(py).toContain(field);
    }
  });

  it("fsl-flirt: enum default variant, numeric bounds, value flags", () => {
    const { parseResult, expr, allOutputs, ts, py } = compileFixture("fsl-flirt.argtype");

    expect(parseResult.meta?.id).toBe("flirt");
    expect(parseResult.meta?.version).toBe("6.0.4");

    // The union keeps its default variant (kept, per the #72 union-default fix).
    const interp = find(expr, "interp");
    expect(interp?.kind).toBe("alternative");
    expect(interp?.meta?.defaultValue).toBe("trilinear");
    const cost = find(expr, "cost");
    expect(cost?.kind).toBe("alternative");
    expect(cost?.meta?.defaultValue).toBe("corratio");

    // Numeric bounds + defaults sink onto the value terminals.
    const dof = find(expr, "dof");
    expect(dof?.kind === "int" && dof.attrs.minValue).toBe(3);
    expect(dof?.kind === "int" && dof.attrs.maxValue).toBe(12);
    expect(dof?.meta?.defaultValue).toBe(12);
    expect(find(expr, "bins")?.meta?.defaultValue).toBe(256);

    // The `-out` value flag produces a resolvable output.
    const outvol = allOutputs.find((o) => o.name === "outvol");
    expect(outvol).toBeDefined();
    expect(outvol!.tokens[0]?.kind).toBe("ref");

    for (const field of ["infile", "reference", "cost", "interp", "dof"]) {
      expect(ts).toContain(field);
      expect(py).toContain(field);
    }
  });

  it("wb-command-sub: exe/id distinction, subcommand literal, enum, output", () => {
    const { parseResult, expr, ctx, allOutputs, ts, py } = compileFixture("wb-command-sub.argtype");

    // The id is the root label, distinct from the `wb_command` executable.
    expect(parseResult.meta?.id).toBe("volume_reduce");
    const literals = rootKids(expr)
      .filter((n) => n.kind === "literal")
      .map((n) => (n.kind === "literal" ? n.attrs.str : ""));
    expect(literals[0]).toBe("wb_command");
    expect(literals[1]).toBe("-volume-reduce");

    // The operation enum kept all its arms.
    const operation = find(expr, "operation");
    expect(operation?.kind).toBe("alternative");
    expect(operation && kids(operation).length).toBe(7);

    // The output template resolves to the `volume_out` binding.
    const reduced = allOutputs.find((o) => o.name === "reduced");
    expect(reduced).toBeDefined();
    if (reduced!.tokens[0]?.kind === "ref") {
      expect(ctx.bindings.get(reduced!.tokens[0].binding)?.name).toBe("volume_out");
    }

    for (const field of ["volume_in", "operation", "volume_out"]) {
      expect(ts).toContain(field);
      expect(py).toContain(field);
    }
  });
});
