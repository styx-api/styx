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
      { subcmd: "inspect" },
      { app: { id: "tool" } },
    );
    expect(inspectOuts).toEqual({ converted: null });
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
