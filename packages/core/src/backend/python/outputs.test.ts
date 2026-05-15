import { describe, expect, it } from "vitest";
import { nodeRef } from "../../ir/index.js";
import { generate, lit, namedAlt, opt, path, rep, seq } from "./test-helpers.js";

describe("python outputs - codegen", () => {
  it("emits an Outputs dataclass and returns it from the wrapper", () => {
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
    expect(code).toContain("@dataclasses.dataclass");
    expect(code).toContain("class Outputs:");
    expect(code).toContain("out_file: OutputPathType");
    expect(code).toContain("-> Outputs:");
    expect(code).toContain("return out");
  });

  it("omits Outputs entirely when no outputs are attached", () => {
    const root = seq(lit("tool"), path("input"));
    const code = generate(root, { app: { id: "tool" } });
    expect(code).not.toContain("class Outputs:");
    expect(code).not.toContain("OutputPathType");
    expect(code).toContain("-> None:");
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
    expect(code).toContain("out_file: OutputPathType | None");
  });

  it("types iterated outputs as lists", () => {
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
    expect(code).toContain("outs: list[OutputPathType]");
    expect(code).toContain('for __o0 in params["inputs"]:');
    expect(code).toMatch(/outs_v\.append\(/);
  });

  it("emits gated output assignment under an is-not-None check", () => {
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
    expect(code).toContain('if params["input"] is not None:');
    expect(code).toContain("out_file_v = execution.output_file(");
  });

  it("emits a strip-extensions helper when needed", () => {
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
    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain("def _strip_extensions(value: str, exts: list[str])");
    expect(code).toContain("_strip_extensions(");
    // The longest extension is sorted first.
    expect(code).toMatch(/_strip_extensions\([^,]+, \[".nii\.gz", "\.nii"\]\)/);
  });

  it("emits variant-gated outputs under an @type check", () => {
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

    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain('if params["subcmd"]["@type"] == "convert":');
    expect(code).toContain("converted_v = execution.output_file(");
  });

  it("uses f-string interpolation for multi-token paths", () => {
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
    expect(code).toMatch(/f'\{params\["input"\]\}\.out'/);
  });

  it("falls back to a literal value when a ref is None and a fallback is set", () => {
    const root = seq(lit("tool"), opt(path("input")));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            { kind: "ref", target: nodeRef("input"), fallback: "default" },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain("if ");
    expect(code).toContain(' is not None else "default"');
  });
});
