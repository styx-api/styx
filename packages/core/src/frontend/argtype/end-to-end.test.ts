import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultPipeline } from "../../ir/index.js";
import { createContext } from "../../manifest/context.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { generatePython } from "../../backend/python/python.js";
import { generateTypeScript } from "../../backend/typescript/typescript.js";
import { generateSchema } from "../../backend/schema/jsonschema.js";
import { ArgtypeParser } from "./parser-frontend.js";

const parser = new ArgtypeParser();

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

function run(source: string) {
  const parseResult = parser.parse(source);
  expect(parseResult.errors).toEqual([]);
  const optimized = defaultPipeline.apply(parseResult.expr);
  const solveResult = solve(optimized.expr);
  const outputs = resolveOutputs(optimized.expr, solveResult);
  expect(outputs.diagnostics.errors).toEqual([]);
  const ctx = createContext(optimized.expr, solveResult, outputs, {
    app: parseResult.meta ?? { id: "tool" },
    package: { name: "pkg" },
  });
  return { parseResult, ctx, outputs };
}

describe("argtype end-to-end: bet", () => {
  it("compiles bet.argtype through to TypeScript and Python", () => {
    const { parseResult, ctx, outputs } = run(fixture("bet.argtype"));

    // Frontmatter -> AppMeta.
    expect(parseResult.meta?.id).toBe("bet");
    expect(parseResult.meta?.version).toBe("6.0.4");

    const ts = generateTypeScript(ctx);
    const py = generatePython(ctx);
    const schema = generateSchema(ctx) as Record<string, unknown>;

    // Core parameters survive into the typed interface.
    for (const field of ["infile", "maskfile", "fractional_intensity", "center_of_gravity"]) {
      expect(ts).toContain(field);
      expect(py).toContain(field);
    }

    // The output-file declarations are collected and resolved.
    const allOutputs = outputs.scopes.flatMap((s) => s.outputs);
    const outNames = allOutputs.map((o) => o.name);
    expect(outNames).toContain("outfile");
    expect(outNames).toContain("binary_mask");

    // The `{maskfile}_mask.nii.gz` template resolves to a ref to the maskfile
    // binding plus the literal suffix - not just present-by-name.
    const binaryMask = allOutputs.find((o) => o.name === "binary_mask")!;
    expect(binaryMask.tokens).toHaveLength(2);
    expect(binaryMask.tokens[0]?.kind).toBe("ref");
    expect(binaryMask.tokens[1]).toEqual({ kind: "literal", value: "_mask.nii.gz" });
    if (binaryMask.tokens[0]?.kind === "ref") {
      expect(ctx.bindings.get(binaryMask.tokens[0].binding)?.name).toBe("maskfile");
    }

    // bet's option group is an anonymous `set(...)` whose only meta is the
    // outputs its members declared, so `flatten` merges it into the root: the
    // flags are plain `bet(...)` parameters, not a nested struct the caller has
    // to build first, and the set's outputs join the root's on the one scope.
    expect(py).not.toContain("BetStruct");
    expect(py).not.toContain("struct1");
    const signature = py.slice(
      py.indexOf("def bet(\n"),
      py.indexOf(") -> BetOutputs:", py.indexOf("def bet(\n")),
    );
    expect(signature).toContain("fractional_intensity");
    expect(signature).toContain("additional_surfaces_t2");
    expect(outputs.scopes).toHaveLength(1);
    expect(allOutputs).toHaveLength(15);

    // Sanity: generated code is non-trivial and references the executable.
    expect(ts.length).toBeGreaterThan(200);
    expect(ts).toContain("bet");
    expect(schema).toBeTruthy();
  });

  it("models the 3-coordinate center as a fixed-count list", () => {
    const { ctx } = run(`tool: set(
      opt("--center", center: rep(float).count(3)),
      input: path,
    )`);
    const ts = generateTypeScript(ctx);
    expect(ts).toContain("center");
  });
});

/**
 * An `opt`/`rep` is an output scope for whatever it wraps, and how many children
 * it happens to wrap is not part of that.
 *
 * `wrapChildren` used to hand a lone child the *enclosing* sink, so an output
 * declared inside a single-child wrapper escaped the wrapper that gates it: the
 * generated `tool_outputs` assigned it unconditionally and the interface typed
 * it non-nullable. Adding one unrelated literal to the same `opt` moved it into
 * the implicit sequence and flipped the type back - which is what makes this a
 * bug and not a convention.
 *
 * The gating that did survive came from output templates that happened to
 * reference a binding inside the wrapper (the ref's own gate carries `present`),
 * so the shape that exposes it is a template referencing an *outer* binding.
 *
 * The wrapper must stay invisible to the *input* surface, which is the property
 * asserted here: each spelling is compared against the same spelling with the
 * `.output()` removed. (Its two-child twin is the wrong baseline - a multi-child
 * flag is synthetically named whether or not outputs are involved, so the two
 * spellings legitimately disagree.) Scoping the outputs on a sequence originally
 * cost the flag its `boolean` type, its `false` default and its author-given
 * name, turning `m?: boolean` into an empty `param_2?: ToolParam2`.
 */
describe("argtype: a single-child opt/rep still opens an output scope", () => {
  /** The `ToolOutputs` field declaration plus the `tool_outputs` body. */
  function outputSurface(source: string): { iface: string; body: string } {
    const { ctx } = run(source);
    const ts = generateTypeScript(ctx);
    const ifaceStart = ts.indexOf("export interface ToolOutputs");
    const bodyStart = ts.indexOf("export function tool_outputs");
    return {
      iface: ts.slice(ifaceStart, ts.indexOf("}", ifaceStart) + 1),
      body: ts.slice(bodyStart, ts.indexOf("\n}", bodyStart)),
    };
  }

  /** The `Tool` params interface - what the caller actually passes. */
  function inputSurface(source: string): string {
    const { ctx } = run(source);
    const ts = generateTypeScript(ctx);
    const start = ts.indexOf("export interface Tool ");
    return ts.slice(start, ts.indexOf("}", start) + 1);
  }

  it("gates an output declared on the lone child of an opt", () => {
    const one = outputSurface(
      'tool: seq("mytool", in: path, opt(m: "-m".output(mask: `{in}_mask.nii`)))',
    );
    const two = outputSurface(
      'tool: seq("mytool", in: path, opt(m: "-m".output(mask: `{in}_mask.nii`), "-x"))',
    );

    // Present in both - the naive fix (hanging the outputs on the lone child's
    // own meta rather than on a sequence) dropped the output entirely, because
    // only a sequence is force-bound as an output scope.
    expect(one.iface).toContain("mask");
    expect(two.iface).toContain("mask");

    // Nullable in both, and assigned under a guard in both.
    expect(one.iface).toContain("mask: OutputPathType | null");
    expect(two.iface).toContain("mask: OutputPathType | null");
    expect(one.body).toContain("if (");
    expect(two.body).toContain("if (");
  });

  it("declaring an output does not disturb the flag it is declared on", () => {
    // The scoping sequence is an implementation detail of the output plumbing;
    // it must not reach the caller. Baseline is the same source without the
    // `.output()`, not the two-child spelling.
    expect(
      inputSurface('tool: seq("mytool", in: path, opt(m: "-m".output(mask: `{in}_mask.nii`)))'),
    ).toBe(inputSurface('tool: seq("mytool", in: path, opt(m: "-m"))'));

    // Spelled out, so a regression names what it broke: a bool, not a struct.
    expect(
      inputSurface('tool: seq("mytool", in: path, opt(m: "-m".output(mask: `{in}_mask.nii`)))'),
    ).toContain("m?: boolean");
  });

  it("keeps an output declared on the lone child of a rep per-iteration", () => {
    const one = outputSurface('tool: seq("mytool", in: path, rep(f: path.output(o: `{in}.txt`)))');
    const two = outputSurface(
      'tool: seq("mytool", in: path, rep("-f", f: path.output(o: `{in}.txt`)))',
    );
    expect(one.iface).toContain("o: OutputPathType[]");
    expect(one.iface).toBe(two.iface);
  });

  it("leaves a lone child that declares no output unwrapped", () => {
    // The wrapper is only added when there is a scope to open, so the common
    // case keeps the flat IR it had before.
    const { ctx } = run('tool: seq("mytool", opt(v: path))');
    const opt = ctx.expr.kind === "sequence" ? ctx.expr.attrs.nodes[1] : undefined;
    expect(opt?.kind).toBe("optional");
    expect(opt?.kind === "optional" && opt.attrs.node.kind).toBe("path");
  });
});
