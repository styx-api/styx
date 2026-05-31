import type { Expr } from "../../ir/index.js";
import { describe, expect, it } from "vitest";
import { executeWithOutputs, generate, lit, opt, path, rep, seq } from "./test-helpers.js";

/** A path terminal carrying the given attrs (the `path()` helper takes none). */
function attrPath(name: string, attrs: { mutable?: boolean; resolveParent?: boolean }): Expr {
  return { kind: "path", attrs, meta: { name } };
}

describe("TypeScript cargs - mutable / resolve-parent inputs", () => {
  it("marks a mutable input via inputFile(host, false, true) on the command line", () => {
    const code = generate(seq(lit("tool"), attrPath("infile", { mutable: true })));
    expect(code).toContain("cargs.push(execution.inputFile(params.infile, false, true));");
  });

  it("passes resolveParent to inputFile for a non-mutable input", () => {
    const code = generate(seq(lit("tool"), attrPath("infile", { resolveParent: true })));
    expect(code).toContain("execution.inputFile(params.infile, true)");
  });

  it("emits a plain inputFile call for ordinary path inputs", () => {
    const code = generate(seq(lit("tool"), path("infile")));
    expect(code).toContain("execution.inputFile(params.infile)");
  });
});

describe("TypeScript - mutable inputs surface as outputs", () => {
  it("declares the mutated copy as an OutputPathType field via mutableCopy", () => {
    const code = generate(seq(lit("tool"), attrPath("infile", { mutable: true })));
    expect(code).toContain("infile: OutputPathType;");
    expect(code).toContain("OutputPathType");
    expect(code).toContain("outputs.infile = execution.mutableCopy(params.infile);");
  });

  it("gates an optional mutable input", () => {
    const code = generate(seq(lit("tool"), opt(attrPath("infile", { mutable: true }))));
    expect(code).toContain("infile: OutputPathType | null;");
    expect(code).toContain("if (params.infile !== null && params.infile !== undefined)");
    expect(code).toContain("execution.mutableCopy(params.infile)");
  });

  it("collects a repeated mutable input into a list", () => {
    const code = generate(seq(lit("tool"), rep(attrPath("infile", { mutable: true }), "infiles")));
    expect(code).toContain("infile: OutputPathType[];");
    expect(code).toMatch(/for \(const __o\d+ of params\.infiles\)/);
    expect(code).toMatch(/outputs\.infile\.push\(execution\.mutableCopy\(__o\d+\)\)/);
  });

  it("uses bracket access for a non-identifier mutable output name", () => {
    const code = generate(seq(lit("tool"), attrPath("in-file", { mutable: true })));
    expect(code).toContain('"in-file": OutputPathType;');
    expect(code).toContain('outputs["in-file"] = execution.mutableCopy(params["in-file"]);');
  });

  it("runs and returns the staged mutable path as an output", () => {
    const { outputs } = executeWithOutputs(
      seq(lit("tool"), attrPath("infile", { mutable: true })),
      {
        infile: "/data/scan.nii",
      },
    );
    expect(outputs).toMatchObject({ infile: "/data/scan.nii" });
  });
});
