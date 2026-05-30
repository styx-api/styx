import { describe, expect, it } from "vitest";
import { nodeRef } from "../../ir/index.js";
import {
  executeWithOutputs,
  generate,
  lit,
  namedAlt,
  opt,
  path,
  rep,
  seq,
  str,
} from "./test-helpers.js";

describe("typescript outputs - codegen", () => {
  it("emits an Outputs interface and returns it from the wrapper", () => {
    const root = seq(lit("tool"), path("input"));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain("export interface ToolOutputs {");
    expect(code).toContain("out_file: OutputPathType");
    expect(code).toContain("): ToolOutputs {");
    expect(code).toContain("return out;");
  });

  it("omits Outputs entirely when no outputs are attached", () => {
    const root = seq(lit("tool"), path("input"));
    const code = generate(root, { app: { id: "tool" } });
    expect(code).not.toContain("ToolOutputs");
    expect(code).not.toContain("OutputPathType");
    expect(code).toContain("): void {");
  });

  it("types gated outputs as nullable", () => {
    const root = seq(lit("tool"), opt(path("input")));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain("out_file: OutputPathType | null");
  });

  it("types iterated outputs as arrays", () => {
    const root = seq(lit("tool"), rep(path("inputs")));
    root.meta = {
      outputs: [
        {
          name: "outs",
          tokens: [
            { kind: "ref", target: nodeRef("inputs") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain("outs: OutputPathType[]");
    expect(code).toContain("for (const __o0 of params.inputs)");
    expect(code).toContain("outputs.outs.push");
  });

  it("resolves outputs referencing a field inside a list-of-struct", () => {
    // Regression: the inner struct field used to have no access-map entry (the
    // old walkAccess stopped at `repeat`), so its ref rendered an unresolved
    // placeholder. Solver-attached paths give it `iter(items) + field(file)`.
    // References the first field `file`, which collides with the (derived) name
    // of its enclosing struct - the ref must still reach the scalar field.
    const root = seq(lit("tool"), rep(seq(path("file"), str("id")), "items"));
    root.meta = {
      outputs: [
        {
          name: "per_item",
          tokens: [
            { kind: "ref", target: nodeRef("file") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const code = generate(root, { app: { id: "tool" } });
    expect(code).not.toContain("unresolved binding");
    expect(code).not.toContain("unresolved loop var");
    expect(code).toContain("per_item: OutputPathType[]");
    expect(code).toMatch(/for \(const __o\d+ of params\.items\)/);
    expect(code).toMatch(/__o\d+\.file/);
  });
});

describe("typescript outputs - execution", () => {
  it("returns a literal-only output unconditionally", () => {
    const root = seq(lit("tool"));
    root.meta = { outputs: [{ name: "log", tokens: [{ kind: "literal", value: "run.log" }] }] };
    const { outputs } = executeWithOutputs(root, {}, { app: { id: "tool" } });
    expect(outputs).toEqual({ log: "run.log" });
  });

  it("interpolates a required ref into the path template", () => {
    const root = seq(lit("tool"), path("input"));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const { outputs } = executeWithOutputs(root, { input: "/data/x" }, { app: { id: "tool" } });
    expect(outputs).toEqual({ out_file: "/data/x.out" });
  });

  it("emits one output per element for a field inside a list-of-struct", () => {
    const root = seq(lit("tool"), rep(seq(path("file"), str("id")), "items"));
    root.meta = {
      outputs: [
        {
          name: "per_item",
          tokens: [
            { kind: "ref", target: nodeRef("file") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const { outputs } = executeWithOutputs(
      root,
      {
        items: [
          { file: "/data/a", id: "a" },
          { file: "/data/b", id: "b" },
        ],
      },
      { app: { id: "tool" } },
    );
    expect(outputs).toEqual({ per_item: ["/data/a.out", "/data/b.out"] });
  });

  it("leaves a gated output null when the optional input is absent", () => {
    const root = seq(lit("tool"), opt(path("input")));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const { outputs } = executeWithOutputs(root, {}, { app: { id: "tool" } });
    expect(outputs).toEqual({ out_file: null });
  });

  it("populates a gated output when the optional input is present", () => {
    const root = seq(lit("tool"), opt(path("input")));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const { outputs } = executeWithOutputs(root, { input: "/data/x" }, { app: { id: "tool" } });
    expect(outputs).toEqual({ out_file: "/data/x.out" });
  });

  it("emits one output per element of a list ref", () => {
    const root = seq(lit("tool"), rep(path("inputs")));
    root.meta = {
      outputs: [
        {
          name: "outs",
          tokens: [
            { kind: "ref", target: nodeRef("inputs") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const { outputs } = executeWithOutputs(
      root,
      { inputs: ["a", "b", "c"] },
      { app: { id: "tool" } },
    );
    expect(outputs).toEqual({ outs: ["a.out", "b.out", "c.out"] });
  });

  it("returns an empty list when the iterated ref is empty", () => {
    const root = seq(lit("tool"), rep(path("inputs")));
    root.meta = {
      outputs: [
        {
          name: "outs",
          tokens: [
            { kind: "ref", target: nodeRef("inputs") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const { outputs } = executeWithOutputs(root, { inputs: [] }, { app: { id: "tool" } });
    expect(outputs).toEqual({ outs: [] });
  });

  it("only populates an alt-arm output when that arm is selected", () => {
    const convert = seq(lit("convert"), path("src"));
    convert.meta = {
      name: "convert",
      outputs: [
        {
          name: "converted",
          tokens: [
            { kind: "ref", target: nodeRef("src") },
            { kind: "literal", value: ".conv" },
          ],
        },
      ],
    };
    const inspect = seq(lit("inspect"));
    inspect.meta = { name: "inspect" };
    const root = seq(lit("tool"), namedAlt("subcmd", convert, inspect));

    const { outputs: convertOuts } = executeWithOutputs(
      root,
      { subcmd: { "@type": "convert", src: "/data/x" } },
      { app: { id: "tool" } },
    );
    expect(convertOuts).toEqual({ converted: "/data/x.conv" });

    const { outputs: inspectOuts } = executeWithOutputs(
      root,
      { subcmd: { "@type": "inspect", inspect: true } },
      { app: { id: "tool" } },
    );
    expect(inspectOuts).toEqual({ converted: null });
  });

  // Regression: when multiple union arms declare the same output name (e.g.
  // ants `antsApplyTransforms` -> `output_image_outfile` across 3 variants),
  // the Outputs interface must collapse to one field; otherwise TS2300
  // (duplicate identifier) and TS1117 (duplicate object literal property).
  it("dedupes same-named outputs across union arms into one interface field", () => {
    const armA = seq(lit("a"), path("aSrc"));
    armA.meta = {
      name: "a",
      outputs: [{ name: "result", tokens: [{ kind: "ref", target: nodeRef("aSrc") }] }],
    };
    const armB = seq(lit("b"), path("bSrc"));
    armB.meta = {
      name: "b",
      outputs: [{ name: "result", tokens: [{ kind: "ref", target: nodeRef("bSrc") }] }],
    };
    const root = seq(lit("tool"), namedAlt("mode", armA, armB));
    const code = generate(root, { app: { id: "tool" } });
    // One interface field, one initializer entry.
    const interfaceMatches = code.match(/result: OutputPathType \| null;/g) ?? [];
    expect(interfaceMatches.length).toBe(1);
    const initMatches = code.match(/^\s*result: null,$/gm) ?? [];
    expect(initMatches.length).toBe(1);
    // But two variant-gated assignments, one per arm.
    expect(code).toContain('if (params.mode["@type"] === "a") {');
    expect(code).toContain('if (params.mode["@type"] === "b") {');
  });

  it("populates the deduped field from whichever union arm is selected", () => {
    const armA = seq(lit("a"), path("aSrc"));
    armA.meta = {
      name: "a",
      outputs: [{ name: "result", tokens: [{ kind: "ref", target: nodeRef("aSrc") }] }],
    };
    const armB = seq(lit("b"), path("bSrc"));
    armB.meta = {
      name: "b",
      outputs: [{ name: "result", tokens: [{ kind: "ref", target: nodeRef("bSrc") }] }],
    };
    const root = seq(lit("tool"), namedAlt("mode", armA, armB));
    const { outputs: aOuts } = executeWithOutputs(
      root,
      { mode: { "@type": "a", aSrc: "/data/a" } },
      { app: { id: "tool" } },
    );
    expect(aOuts).toEqual({ result: "/data/a" });
    const { outputs: bOuts } = executeWithOutputs(
      root,
      { mode: { "@type": "b", bSrc: "/data/b" } },
      { app: { id: "tool" } },
    );
    expect(bOuts).toEqual({ result: "/data/b" });
  });

  // Regression: when an output ref points at a binding nested inside a
  // binding-less wrapper sequence (the shape Boutiques produces for
  // `command-line-flag` inputs like `seq(lit("-out"), str("out_file"))`),
  // the access path must still be the struct-relative `params.<name>`, not
  // `params`. The old structural walk dropped the name (-> TS2345 on flirt).
  it("resolves output refs through binding-less wrapper sequences", () => {
    const root = seq(lit("tool"), seq(lit("-out"), str("out_file")));
    root.meta = {
      outputs: [
        {
          name: "out",
          tokens: [{ kind: "ref", target: nodeRef("out_file") }],
        },
      ],
    };
    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain("execution.outputFile(params.out_file)");
    expect(code).not.toMatch(/execution\.outputFile\(params[,)]/);
    const { outputs } = executeWithOutputs(root, { out_file: "/data/x" }, { app: { id: "tool" } });
    expect(outputs).toEqual({ out: "/data/x" });
  });

  it("applies a stripExtensions list to ref tokens", () => {
    const root = seq(lit("tool"), path("input"));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            {
              kind: "ref",
              target: nodeRef("input"),
              stripExtensions: [".nii.gz", ".nii"],
            },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const { outputs } = executeWithOutputs(
      root,
      { input: "/data/x.nii.gz" },
      { app: { id: "tool" } },
    );
    expect(outputs).toEqual({ out_file: "/data/x.out" });
  });
});
