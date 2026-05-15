import { describe, expect, it } from "vitest";
import type { Output } from "../../ir/index.js";
import type { Alternative, Expr, Optional, Repeat, Sequence } from "../../ir/node.js";
import { BoutiquesParser } from "./parser.js";

const parser = new BoutiquesParser();

function parse(descriptor: Record<string, unknown>): ReturnType<typeof parser.parse> {
  return parser.parse(JSON.stringify(descriptor));
}

/** Gather every `Output` attached to nodes in an IR tree, in tree-walk order. */
function collectOutputs(node: Expr): Output[] {
  const acc: Output[] = [];
  function walk(n: Expr): void {
    if (n.meta?.outputs) acc.push(...n.meta.outputs);
    switch (n.kind) {
      case "sequence":
        for (const c of n.attrs.nodes) walk(c);
        break;
      case "optional":
      case "repeat":
        walk(n.attrs.node);
        break;
      case "alternative":
        for (const a of n.attrs.alts) walk(a);
        break;
    }
  }
  walk(node);
  return acc;
}

function minimalDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-tool",
    "command-line": "test",
    inputs: [],
    ...overrides,
  };
}

function minimalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "input1",
    name: "Input 1",
    type: "String",
    "value-key": "[INPUT1]",
    ...overrides,
  };
}

describe("BoutiquesParser", () => {
  describe("parse errors", () => {
    it("returns error for invalid JSON", () => {
      const result = parser.parse("not json");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.message).toContain("JSON");
    });

    it("returns error for non-object JSON", () => {
      const result = parser.parse('"string"');
      expect(result.errors).toContainEqual({ message: "JSON source is not an object" });
    });

    it("returns error for missing id/name", () => {
      const result = parse({});
      expect(result.errors).toContainEqual({ message: "Descriptor is missing id/name" });
    });

    it("returns error for input missing type", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [{ id: "input1", "value-key": "[INPUT1]" }],
        }),
      );
      expect(result.errors[0]?.message).toContain("type is missing");
    });

    it("returns error for unknown input type", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "Unknown" })],
        }),
      );
      expect(result.errors[0]?.message).toContain("Unknown input type");
    });

    it("returns error for file input with value-choices", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "File", "value-choices": ["a", "b"] })],
        }),
      );
      expect(result.errors[0]?.message).toContain("cannot have value-choices");
    });

    it("returns error for flag missing command-line-flag", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "Flag" })],
        }),
      );
      expect(result.errors[0]?.message).toContain("missing command-line-flag");
    });
  });

  describe("app metadata", () => {
    it("extracts id from name", () => {
      const result = parse(minimalDescriptor({ name: "my-tool" }));
      expect(result.meta?.id).toBe("my-tool");
    });

    it("prefers id over name", () => {
      const result = parse(minimalDescriptor({ id: "tool-id", name: "tool-name" }));
      expect(result.meta?.id).toBe("tool-id");
    });

    it("extracts version", () => {
      const result = parse(minimalDescriptor({ "tool-version": "1.2.3" }));
      expect(result.meta?.version).toBe("1.2.3");
    });

    it("extracts documentation", () => {
      const result = parse(
        minimalDescriptor({
          name: "My Tool",
          description: "A test tool",
        }),
      );
      expect(result.meta?.doc?.title).toBe("My Tool");
      expect(result.meta?.doc?.description).toBe("A test tool");
    });

    it("extracts author", () => {
      const result = parse(minimalDescriptor({ author: "Jane Doe" }));
      expect(result.meta?.authors).toEqual(["Jane Doe"]);
    });

    it("extracts url", () => {
      const result = parse(minimalDescriptor({ url: "https://example.com" }));
      expect(result.meta?.urls).toEqual(["https://example.com"]);
    });

    it("extracts container image", () => {
      const result = parse(
        minimalDescriptor({
          "container-image": { image: "docker/image:tag", type: "docker" },
        }),
      );
      expect(result.meta?.container).toEqual({ image: "docker/image:tag", type: "docker" });
    });

    it("extracts stdout output", () => {
      const result = parse(
        minimalDescriptor({
          "stdout-output": { id: "stdout", name: "Standard Output", description: "Output" },
        }),
      );
      expect(result.meta?.stdout?.name).toBe("stdout");
      expect(result.meta?.stdout?.doc?.title).toBe("Standard Output");
    });

    it("extracts stderr output", () => {
      const result = parse(
        minimalDescriptor({
          "stderr-output": { id: "stderr", name: "Standard Error" },
        }),
      );
      expect(result.meta?.stderr?.name).toBe("stderr");
    });
  });

  describe("output-files", () => {
    it("attaches a literal-only output to the root node", () => {
      const result = parse(
        minimalDescriptor({
          "output-files": [
            {
              id: "log_file",
              name: "Log file",
              description: "Run log",
              "path-template": "run.log",
            },
          ],
        }),
      );
      expect(result.errors).toEqual([]);
      // literal-only -> hosted on the root sequence
      expect(result.expr.meta?.outputs).toHaveLength(1);
      const outputs = collectOutputs(result.expr);
      expect(outputs).toHaveLength(1);
      const out = outputs[0]!;
      expect(out.name).toBe("log_file");
      expect(out.doc?.title).toBe("Log file");
      expect(out.doc?.description).toBe("Run log");
      expect(out.tokens).toEqual([{ kind: "literal", value: "run.log" }]);
    });

    it("tokenizes path-template into literals and node refs", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT_FILE]",
          inputs: [minimalInput({ id: "input_file", "value-key": "[INPUT_FILE]", type: "File" })],
          "output-files": [{ id: "out_file", name: "Output", "path-template": "[INPUT_FILE].out" }],
        }),
      );
      expect(result.errors).toEqual([]);
      expect(collectOutputs(result.expr)[0]?.tokens).toEqual([
        { kind: "ref", target: { kind: "node-ref", name: "input_file" } },
        { kind: "literal", value: ".out" },
      ]);
    });

    it("attaches outputs to the descriptor's rootSeq, not to inner nodes", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT_FILE]",
          inputs: [minimalInput({ id: "input_file", "value-key": "[INPUT_FILE]", type: "File" })],
          "output-files": [{ id: "out_file", name: "Output", "path-template": "[INPUT_FILE].out" }],
        }),
      );
      const seq = result.expr as Sequence;
      expect(result.expr.meta?.outputs).toHaveLength(1);
      // Inner nodes don't carry outputs anymore - per-ref gating comes from
      // the binding's `gate` after solving.
      expect(seq.attrs.nodes[1]?.meta?.outputs).toBeUndefined();
    });

    it("adds an empty-string fallback to refs of optional inputs", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT_FILE]",
          inputs: [
            minimalInput({
              id: "input_file",
              "value-key": "[INPUT_FILE]",
              type: "File",
              optional: true,
            }),
          ],
          "output-files": [{ id: "out_file", name: "Output", "path-template": "[INPUT_FILE].out" }],
        }),
      );
      const tokens = collectOutputs(result.expr)[0]?.tokens;
      expect(tokens?.[0]).toEqual({
        kind: "ref",
        target: { kind: "node-ref", name: "input_file" },
        fallback: "",
      });
    });

    it("does not carry the source's `optional: true` hint into the IR (re-derived at emit time)", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT_FILE]",
          inputs: [minimalInput({ id: "input_file", "value-key": "[INPUT_FILE]", type: "File" })],
          "output-files": [
            { id: "out_a", name: "A", "path-template": "[INPUT_FILE].a", optional: true },
            { id: "out_b", name: "B", "path-template": "[INPUT_FILE].b" },
          ],
        }),
      );
      const outs = collectOutputs(result.expr);
      expect(outs.find((o) => o.name === "out_a")).toBeDefined();
      expect(outs.find((o) => o.name === "out_b")).toBeDefined();
      // No `optional` field on the IR Output type.
      for (const out of outs) {
        expect((out as { optional?: boolean }).optional).toBeUndefined();
      }
    });

    it("attaches stripExtensions to ref tokens", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT_FILE]",
          inputs: [minimalInput({ id: "input_file", "value-key": "[INPUT_FILE]", type: "File" })],
          "output-files": [
            {
              id: "out_file",
              name: "Out",
              "path-template": "[INPUT_FILE].out",
              "path-template-stripped-extensions": [".nii", ".nii.gz"],
            },
          ],
        }),
      );
      const tokens = collectOutputs(result.expr)[0]?.tokens;
      expect(tokens?.[0]).toEqual({
        kind: "ref",
        target: { kind: "node-ref", name: "input_file" },
        stripExtensions: [".nii", ".nii.gz"],
      });
      expect(tokens?.[1]).toEqual({ kind: "literal", value: ".out" });
    });

    it("handles multiple output files", () => {
      const result = parse(
        minimalDescriptor({
          "output-files": [
            { id: "a", name: "A", "path-template": "a.out" },
            { id: "b", name: "B", "path-template": "b.out" },
          ],
        }),
      );
      expect(collectOutputs(result.expr).map((o) => o.name)).toEqual(["a", "b"]);
    });

    it("errors on missing path-template", () => {
      const result = parse(
        minimalDescriptor({ "output-files": [{ id: "broken", name: "Broken" }] }),
      );
      expect(result.errors[0]?.message).toContain("missing path-template");
    });

    it("errors on missing id", () => {
      const result = parse(
        minimalDescriptor({ "output-files": [{ name: "x", "path-template": "x.out" }] }),
      );
      expect(result.errors[0]?.message).toContain("missing id");
    });

    it("attaches no outputs when output-files is absent", () => {
      const result = parse(minimalDescriptor());
      expect(collectOutputs(result.expr)).toEqual([]);
    });

    it("warns on non-object output-files entry", () => {
      const result = parse(minimalDescriptor({ "output-files": ["not-an-object"] }));
      expect(result.warnings.some((w) => w.message.includes("Skipping"))).toBe(true);
    });
  });

  describe("terminal nodes", () => {
    it("parses string input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String" })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "str" });
    });

    it("parses integer input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "Number", integer: true })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "int" });
    });

    it("parses integer with constraints", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [
            minimalInput({
              type: "Number",
              integer: true,
              minimum: 0,
              maximum: 100,
            }),
          ],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({
        kind: "int",
        attrs: { minValue: 0, maxValue: 100 },
      });
    });

    it("handles exclusive minimum/maximum for integers", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [
            minimalInput({
              type: "Number",
              integer: true,
              minimum: 0,
              maximum: 100,
              "exclusive-minimum": true,
              "exclusive-maximum": true,
            }),
          ],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({
        kind: "int",
        attrs: { minValue: 1, maxValue: 99 },
      });
    });

    it("parses float input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "Number", integer: false })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "float" });
    });

    it("parses float with constraints", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [
            minimalInput({
              type: "Number",
              minimum: 0.0,
              maximum: 1.0,
            }),
          ],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({
        kind: "float",
        attrs: { minValue: 0.0, maxValue: 1.0 },
      });
    });

    it("parses file input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "File" })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "path" });
    });

    it("parses file with resolve-parent", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "File", "resolve-parent": true })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({
        kind: "path",
        attrs: { resolveParent: true },
      });
    });

    it("parses file with mutable", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "File", mutable: true })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({
        kind: "path",
        attrs: { mutable: true },
      });
    });

    it("parses flag input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "Flag", "command-line-flag": "-v" })],
        }),
      );
      const seq = result.expr as Sequence;
      const opt = seq.attrs.nodes[1] as Optional;
      expect(opt.kind).toBe("optional");
      expect(opt.attrs.node).toMatchObject({ kind: "literal", attrs: { str: "-v" } });
    });
  });

  describe("enum alternatives", () => {
    it("parses string enum", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String", "value-choices": ["a", "b", "c"] })],
        }),
      );
      const seq = result.expr as Sequence;
      const alt = seq.attrs.nodes[1] as Alternative;
      expect(alt.kind).toBe("alternative");
      expect(alt.attrs.alts).toHaveLength(3);
      expect(alt.attrs.alts[0]).toMatchObject({ kind: "literal", attrs: { str: "a" } });
    });

    it("parses integer enum", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "Number", integer: true, "value-choices": [1, 2, 3] })],
        }),
      );
      const seq = result.expr as Sequence;
      const alt = seq.attrs.nodes[1] as Alternative;
      expect(alt.kind).toBe("alternative");
      expect(alt.attrs.alts[0]).toMatchObject({ kind: "literal", attrs: { str: "1" } });
    });

    it("warns on invalid enum choices", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String", "value-choices": ["a", {}, "b"] })],
        }),
      );
      expect(result.warnings.length).toBeGreaterThan(0);
      const alt = (result.expr as Sequence).attrs.nodes[1] as Alternative;
      expect(alt.attrs.alts).toHaveLength(2);
    });
  });

  describe("node metadata", () => {
    it("attaches name from input id", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ id: "my_input" })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]?.meta?.name).toBe("my_input");
    });

    it("attaches documentation", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ name: "My Input", description: "An input" })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]?.meta?.doc?.title).toBe("My Input");
      expect(seq.attrs.nodes[1]?.meta?.doc?.description).toBe("An input");
    });
  });

  describe("optional wrapping", () => {
    it("wraps optional input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String", optional: true })],
        }),
      );
      const seq = result.expr as Sequence;
      const opt = seq.attrs.nodes[1] as Optional;
      expect(opt.kind).toBe("optional");
      expect(opt.attrs.node).toMatchObject({ kind: "str" });
    });

    it("does not wrap required input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String", optional: false })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]?.kind).toBe("str");
    });
  });

  describe("repeat wrapping", () => {
    it("wraps list input", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String", list: true })],
        }),
      );
      const seq = result.expr as Sequence;
      const rep = seq.attrs.nodes[1] as Repeat;
      expect(rep.kind).toBe("repeat");
      expect(rep.attrs.node).toMatchObject({ kind: "str" });
    });

    it("includes list separator", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String", list: true, "list-separator": "," })],
        }),
      );
      const seq = result.expr as Sequence;
      const rep = seq.attrs.nodes[1] as Repeat;
      expect(rep.attrs.join).toBe(",");
    });

    it("includes list constraints", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [
            minimalInput({
              type: "String",
              list: true,
              "min-list-entries": 1,
              "max-list-entries": 5,
            }),
          ],
        }),
      );
      const seq = result.expr as Sequence;
      const rep = seq.attrs.nodes[1] as Repeat;
      expect(rep.attrs.countMin).toBe(1);
      expect(rep.attrs.countMax).toBe(5);
    });
  });

  describe("command-line-flag wrapping", () => {
    it("prepends flag to value", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String", "command-line-flag": "-i" })],
        }),
      );
      const seq = result.expr as Sequence;
      const inner = seq.attrs.nodes[1] as Sequence;
      expect(inner.kind).toBe("sequence");
      expect(inner.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "-i" } });
      expect(inner.attrs.nodes[1]).toMatchObject({ kind: "str" });
    });

    it("includes flag separator", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [
            minimalInput({
              type: "String",
              "command-line-flag": "--input",
              "command-line-flag-separator": "=",
            }),
          ],
        }),
      );
      const seq = result.expr as Sequence;
      const inner = seq.attrs.nodes[1] as Sequence;
      expect(inner.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "--input=" } });
    });
  });

  describe("wrapping order", () => {
    it("wraps in order: repeat -> flag -> optional", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [
            minimalInput({
              type: "Number",
              optional: true,
              list: true,
              "command-line-flag": "-n",
              "min-list-entries": 1,
              "max-list-entries": 3,
            }),
          ],
        }),
      );

      const seq = result.expr as Sequence;
      // optional
      const opt = seq.attrs.nodes[1] as Optional;
      expect(opt.kind).toBe("optional");
      // sequence with flag
      const flagSeq = opt.attrs.node as Sequence;
      expect(flagSeq.kind).toBe("sequence");
      expect(flagSeq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "-n" } });
      // repeat
      const rep = flagSeq.attrs.nodes[1] as Repeat;
      expect(rep.kind).toBe("repeat");
      expect(rep.attrs.countMin).toBe(1);
      expect(rep.attrs.countMax).toBe(3);
      // terminal
      expect(rep.attrs.node).toMatchObject({ kind: "float" });
    });
  });

  describe("command-line parsing", () => {
    it("parses literals", () => {
      const result = parse(minimalDescriptor({ "command-line": "tool --verbose" }));
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes).toHaveLength(2);
      expect(seq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "tool" } });
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "literal", attrs: { str: "--verbose" } });
    });

    it("substitutes inputs", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool [INPUT1] [INPUT2]",
          inputs: [
            minimalInput({ id: "input1", "value-key": "[INPUT1]", type: "String" }),
            minimalInput({ id: "input2", "value-key": "[INPUT2]", type: "File" }),
          ],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes).toHaveLength(3);
      expect(seq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "tool" } });
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "str" });
      expect(seq.attrs.nodes[2]).toMatchObject({ kind: "path" });
    });

    it("handles mixed literal and input in single arg", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool --prefix=[INPUT1]",
          inputs: [minimalInput({ type: "String" })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes).toHaveLength(2);
      const inner = seq.attrs.nodes[1] as Sequence;
      expect(inner.kind).toBe("sequence");
      expect(inner.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "--prefix=" } });
      expect(inner.attrs.nodes[1]).toMatchObject({ kind: "str" });
    });

    it("handles quoted arguments", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool 'hello world' [INPUT1]",
          inputs: [minimalInput({ type: "String" })],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "literal", attrs: { str: "hello world" } });
    });

    it("ignores inputs not in command-line", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool [INPUT1]",
          inputs: [
            minimalInput({ id: "input1", "value-key": "[INPUT1]", type: "String" }),
            minimalInput({ id: "input2", "value-key": "[INPUT2]", type: "String" }),
          ],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes).toHaveLength(2);
    });

    it("joins mixed literal and input without space", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool --prefix=[INPUT1]",
          inputs: [minimalInput({ type: "String" })],
        }),
      );
      const seq = result.expr as Sequence;
      const inner = seq.attrs.nodes[1] as Sequence;
      expect(inner.kind).toBe("sequence");
      expect(inner.attrs.join).toBe("");
    });
  });

  describe("subcommands", () => {
    it("parses subcommand", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool [SUBCMD]",
          inputs: [
            {
              id: "subcmd",
              "value-key": "[SUBCMD]",
              type: {
                "command-line": "sub [ARG]",
                inputs: [{ id: "arg", "value-key": "[ARG]", type: "String" }],
              },
            },
          ],
        }),
      );
      const seq = result.expr as Sequence;
      const subSeq = seq.attrs.nodes[1] as Sequence;
      expect(subSeq.kind).toBe("sequence");
      expect(subSeq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "sub" } });
      expect(subSeq.attrs.nodes[1]).toMatchObject({ kind: "str" });
    });

    it("parses subcommand union", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool [SUBCMD]",
          inputs: [
            {
              id: "subcmd",
              "value-key": "[SUBCMD]",
              type: [
                {
                  "command-line": "add [X]",
                  inputs: [{ id: "x", "value-key": "[X]", type: "Number", integer: true }],
                },
                {
                  "command-line": "remove [Y]",
                  inputs: [{ id: "y", "value-key": "[Y]", type: "String" }],
                },
              ],
            },
          ],
        }),
      );
      const seq = result.expr as Sequence;
      const alt = seq.attrs.nodes[1] as Alternative;
      expect(alt.kind).toBe("alternative");
      expect(alt.attrs.alts).toHaveLength(2);
    });

    it("unwraps single-alternative union", () => {
      const result = parse(
        minimalDescriptor({
          "command-line": "tool [SUBCMD]",
          inputs: [
            {
              id: "subcmd",
              "value-key": "[SUBCMD]",
              type: [
                {
                  "command-line": "only [X]",
                  inputs: [{ id: "x", "value-key": "[X]", type: "String" }],
                },
              ],
            },
          ],
        }),
      );
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[1]?.kind).toBe("sequence");
    });
  });

  describe("real-world: bet descriptor", () => {
    const betDescriptor = {
      name: "bet",
      author: "FMRIB Analysis Group, University of Oxford",
      description: "Automated brain extraction tool for FSL",
      "command-line": "bet [INFILE] [MASKFILE] [FRACTIONAL_INTENSITY] [VERBOSE]",
      inputs: [
        { id: "infile", "value-key": "[INFILE]", type: "File", optional: false },
        { id: "maskfile", "value-key": "[MASKFILE]", type: "String", optional: false },
        {
          id: "fractional_intensity",
          "value-key": "[FRACTIONAL_INTENSITY]",
          type: "Number",
          "command-line-flag": "-f",
          minimum: 0,
          maximum: 1,
          optional: true,
        },
        { id: "verbose", "value-key": "[VERBOSE]", type: "Flag", "command-line-flag": "-v" },
      ],
    };

    it("parses correctly", () => {
      const result = parse(betDescriptor);
      expect(result.errors).toHaveLength(0);
      expect(result.meta?.id).toBe("bet");
      expect(result.meta?.authors).toEqual(["FMRIB Analysis Group, University of Oxford"]);
    });

    it("has correct structure", () => {
      const result = parse(betDescriptor);
      const seq = result.expr as Sequence;

      // bet
      expect(seq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "bet" } });
      // infile (required path)
      expect(seq.attrs.nodes[1]).toMatchObject({ kind: "path" });
      // maskfile (required str)
      expect(seq.attrs.nodes[2]).toMatchObject({ kind: "str" });
      // fractional_intensity (optional float with flag)
      const fi = seq.attrs.nodes[3] as Optional;
      expect(fi.kind).toBe("optional");
      const fiSeq = fi.attrs.node as Sequence;
      expect(fiSeq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "-f" } });
      expect(fiSeq.attrs.nodes[1]).toMatchObject({
        kind: "float",
        attrs: { minValue: 0, maxValue: 1 },
      });
      // verbose (optional flag)
      const verbose = seq.attrs.nodes[4] as Optional;
      expect(verbose.kind).toBe("optional");
      expect(verbose.attrs.node).toMatchObject({ kind: "literal", attrs: { str: "-v" } });
    });
  });
});
