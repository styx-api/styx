import type { Expr } from "../../ir/index.js";
import { describe, expect, it } from "vitest";
import { generate, lit, opt, path, rep, seq } from "./test-helpers.js";

/** A path terminal carrying the given attrs (the `path()` helper takes none). */
function attrPath(name: string, attrs: { mutable?: boolean; resolveParent?: boolean }): Expr {
  return { kind: "path", attrs, meta: { name } };
}

describe("Python cargs - mutable / resolve-parent inputs", () => {
  it("marks a mutable input via input_file(mutable=True) on the command line", () => {
    const code = generate(seq(lit("tool"), attrPath("infile", { mutable: true })));
    expect(code).toContain('execution.input_file(params["infile"], mutable=True)');
  });

  it("passes resolve_parent=True to input_file for a non-mutable input", () => {
    const code = generate(seq(lit("tool"), attrPath("infile", { resolveParent: true })));
    expect(code).toContain('execution.input_file(params["infile"], resolve_parent=True)');
    expect(code).not.toContain("mutable");
  });

  it("emits a plain input_file call for ordinary path inputs", () => {
    const code = generate(seq(lit("tool"), path("infile")));
    expect(code).toContain('execution.input_file(params["infile"])');
    expect(code).not.toContain("mutable");
  });
});

describe("Python - mutable inputs surface as outputs", () => {
  it("declares the mutated copy as an OutputPathType field via mutable_copy", () => {
    const code = generate(seq(lit("tool"), attrPath("infile", { mutable: true })));
    expect(code).toContain("infile: OutputPathType");
    expect(code).toContain("from styxdefs import");
    expect(code).toContain("OutputPathType");
    // The build function resolves the mutated copy's host path via mutable_copy.
    expect(code).toContain('infile_v: OutputPathType = execution.mutable_copy(params["infile"])');
    expect(code).toContain("infile=infile_v,");
  });

  it("gates an optional mutable input", () => {
    const code = generate(seq(lit("tool"), opt(attrPath("infile", { mutable: true }))));
    // Outputs dataclass field (unchanged - dataclasses don't use NotRequired).
    expect(code).toContain("infile: OutputPathType | None");
    // Params TypedDict input field is NotRequired; the present-gate binds a
    // narrowed local via .get() and surfaces the mutable copy from it.
    expect(code).toContain("infile: typing.NotRequired[InputPathType | None]");
    // The mutable copy surfaces from the outputs gate's narrowed local (.get()).
    const mc = code.match(/execution\.mutable_copy\((\w+)\)/);
    expect(mc).toBeTruthy();
    expect(code).toContain(`${mc![1]} = params.get("infile")`);
    expect(code).toContain(`if ${mc![1]} is not None:`);
  });

  it("collects a repeated mutable input into a list", () => {
    const code = generate(seq(lit("tool"), rep(attrPath("infile", { mutable: true }), "infiles")));
    expect(code).toContain("list[OutputPathType]");
    expect(code).toMatch(/for __o\d+ in params\["infiles"\]:/);
    expect(code).toMatch(/\.append\(execution\.mutable_copy\(__o\d+\)\)/);
  });
});
