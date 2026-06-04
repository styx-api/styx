import { describe, expect, it } from "vitest";
import { nodeRef } from "../../ir/index.js";
import { generate, lit, namedAlt, opt, path, rep, seq, str } from "./test-helpers.js";

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
    expect(code).toContain("class ToolOutputs:");
    expect(code).toContain("out_file: OutputPathType");
    expect(code).toContain("-> ToolOutputs:");
    expect(code).toContain("return out");
  });

  it("reassigns (not re-declares) a second ungated output sharing a name", () => {
    // Regression (afni v_3d_detrend, v_3d_skull_strip, ...): two `output-files`
    // share an id with no gate. The required-single branch used to emit a
    // second annotated declaration (`out_file_v: OutputPathType = ...`), which
    // mypy --strict flags as `no-redef`. Now the first contributor declares and
    // later ones reassign the already-declared local.
    const root = seq(lit("tool"), path("input"));
    root.meta = {
      outputs: [
        {
          name: "out_file",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: "_detrend" },
          ],
        },
        {
          name: "out_file",
          tokens: [{ kind: "literal", value: "out_file" }],
        },
      ],
    };
    const code = generate(root, { app: { id: "tool" } });
    // Exactly one annotated declaration of the shared local...
    expect(code.match(/out_file_v: OutputPathType =/g)?.length).toBe(1);
    // ...and the second contributor reassigns without re-annotating.
    expect(code).toContain('out_file_v = execution.output_file("out_file")');
  });

  it("still emits Outputs with only the root field when no outputs are attached", () => {
    const root = seq(lit("tool"), path("input"));
    const code = generate(root, { app: { id: "tool" } });
    expect(code).toContain("class ToolOutputs:");
    expect(code).toContain("root: OutputPathType");
    expect(code).toContain("-> ToolOutputs:");
    expect(code).toContain('root_v: OutputPathType = execution.output_file(".")');
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
    expect(code).toContain("per_item: list[OutputPathType]");
    expect(code).toMatch(/for __o\d+ in params\["items"\]:/);
    expect(code).toMatch(/__o\d+\["file"\]/);
  });

  it("resolves an output owned by a variant of a repeated union (c3d -o pattern)", () => {
    // Regression (c3d/c2d/c4d): an output attached to one variant of a repeated
    // discriminated union is gated as `iter(operations) + variant(union,
    // "output")`. The variant atom's union binding used to be absent from the
    // bindings map, so the gate rendered as
    // `if None  # unresolved binding binding_N["@type"] == "output":`. Solver-
    // owned access paths now register the union binding, so it resolves.
    const outVar = seq(lit("-o"), str("outfile"));
    outVar.meta = {
      name: "output",
      outputs: [
        {
          name: "out",
          tokens: [
            { kind: "ref", target: nodeRef("outfile") },
            { kind: "literal", value: ".nii" },
          ],
        },
      ],
    };
    const scaleVar = seq(lit("-s"), str("scale"));
    scaleVar.meta = { name: "scaleop" };
    const root = seq(lit("tool"), rep(namedAlt("op", outVar, scaleVar), "operations"));
    const code = generate(root, { app: { id: "tool" } });
    expect(code).not.toContain("unresolved binding");
    expect(code).not.toContain("unresolved loop var");
    expect(code).toContain("out: list[OutputPathType]");
    expect(code).toMatch(/for __o\d+ in params\["operations"\]:/);
    expect(code).toMatch(/if __o\d+\["@type"\] == "output":/);
    expect(code).toMatch(/__o\d+\["outfile"\]/);
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
    // Optional present-gate binds a narrowed local read via .get() (the key is
    // NotRequired / may be absent), then guards on it.
    const m = code.match(/(\w+) = params\.get\("input"\)/);
    expect(m).toBeTruthy();
    expect(code).toContain(`if ${m![1]} is not None:`);
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

  // Regression: when multiple union arms declare the same output name (e.g.
  // ants `antsApplyTransforms` -> `output_image_outfile` across 3 variants),
  // the dataclass must collapse to one field and the constructor to one
  // keyword argument; otherwise Python raises SyntaxError on the duplicate
  // kwargs. The shared local var is initialized exactly once.
  it("dedupes same-named outputs across union arms into one dataclass field", () => {
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
    // One dataclass field declaration.
    const fieldDecls = code.match(/^ {4}result: OutputPathType \| None$/gm) ?? [];
    expect(fieldDecls.length).toBe(1);
    // Exactly one init for the shared local var (not re-initialized between arms).
    const inits = code.match(/^ {4}result_v: OutputPathType \| None = None$/gm) ?? [];
    expect(inits.length).toBe(1);
    // Two variant-gated assignments.
    expect(code).toContain('if params["mode"]["@type"] == "a":');
    expect(code).toContain('if params["mode"]["@type"] == "b":');
    // The shared output is one keyword argument (no duplicate kwargs), after the
    // always-present root.
    expect(code).toMatch(/return ToolOutputs\(\n\s+root=root_v,\n\s+result=result_v,\n\s+\)/);
  });

  // Regression: a binding nested inside a binding-less wrapper sequence (the
  // shape Boutiques produces for `command-line-flag` inputs like
  // `seq(lit("-out"), str("out_file"))`) must still resolve to its
  // struct-relative `params["<name>"]` access, not the bare struct root. The
  // old structural walk dropped the name (broke flirt / antsApplyTransforms).
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
    expect(code).toContain('execution.output_file(params["out_file"])');
    expect(code).not.toMatch(/execution\.output_file\(params\)/);
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
