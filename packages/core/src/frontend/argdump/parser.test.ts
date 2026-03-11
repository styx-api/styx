import { describe, expect, it } from "vitest";
import type { Alternative, Expr, Optional, Repeat, Sequence } from "../../ir/node.js";
import { ArgdumpParser } from "./parser.js";

const parser = new ArgdumpParser();

function parse(descriptor: Record<string, unknown>): ReturnType<typeof parser.parse> {
  return parser.parse(JSON.stringify(descriptor));
}

function minimalDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prog: "test-tool",
    actions: [],
    ...overrides,
  };
}

function storeAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dest: "input1",
    action_type: "store",
    option_strings: [],
    ...overrides,
  };
}

function optionalAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dest: "flag1",
    action_type: "store",
    option_strings: ["--flag1"],
    ...overrides,
  };
}

/** Get action nodes from the root sequence (skipping the prog literal at index 0). */
function actionNodes(result: ReturnType<typeof parser.parse>): Expr[] {
  const seq = result.expr as Sequence;
  // First node is lit(prog), rest are actions
  return seq.attrs.nodes.slice(1);
}

describe("ArgdumpParser", () => {
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

    it("returns error for missing prog", () => {
      const result = parse({});
      expect(result.errors).toContainEqual({ message: "Descriptor is missing prog" });
    });
  });

  describe("app metadata", () => {
    it("extracts prog as id", () => {
      const result = parse(minimalDescriptor({ prog: "my-tool" }));
      expect(result.meta?.id).toBe("my-tool");
    });

    it("extracts description", () => {
      const result = parse(minimalDescriptor({ description: "A test tool" }));
      expect(result.meta?.doc?.description).toBe("A test tool");
    });

    it("extracts epilog as comment", () => {
      const result = parse(minimalDescriptor({ epilog: "Some extra info" }));
      expect(result.meta?.doc?.comment).toBe("Some extra info");
    });

    it("extracts version from version action", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "version",
              action_type: "version",
              option_strings: ["--version"],
              version: "%(prog)s 1.2.3",
            },
          ],
        }),
      );
      expect(result.meta?.version).toBe("1.2.3");
    });

    it("sets root struct name from prog", () => {
      const result = parse(minimalDescriptor({ prog: "my-tool" }));
      expect(result.expr.meta?.name).toBe("my-tool");
    });

    it("falls back to first word of description when prog is empty", () => {
      const result = parse({
        prog: "",
        description: "fMRIPrep: fMRI PREProcessing workflows v25.2.3",
        actions: [],
      });
      expect(result.errors).toHaveLength(0);
      expect(result.meta?.id).toBe("fMRIPrep");
    });

    it("returns error when prog is empty and no description", () => {
      const result = parse({ prog: "", actions: [] });
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("prog literal", () => {
    it("prepends prog as literal node", () => {
      const result = parse(minimalDescriptor({ prog: "my-tool" }));
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "my-tool" } });
    });

    it("does not prepend literal for empty prog", () => {
      const result = parse({
        prog: "",
        description: "fMRIPrep: some tool",
        actions: [],
      });
      const seq = result.expr as Sequence;
      expect(seq.attrs.nodes).toHaveLength(0);
    });
  });

  describe("store action (positional)", () => {
    it("parses positional string", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction()],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "str" });
    });

    it("parses positional int", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ type_info: { name: "int", builtin: true } })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "int" });
    });

    it("parses positional float", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ type_info: { name: "float", builtin: true } })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "float" });
    });

    it("parses positional path (pathlib.Path)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ type_info: { name: "Path", module: "pathlib" } })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "path" });
    });

    it("parses positional with FileType as path", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ file_type_info: { mode: "r" } })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "path" });
    });

    it("parses positional with choices", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ choices: ["a", "b", "c"] })],
        }),
      );
      const nodes = actionNodes(result);
      const alt = nodes[0] as Alternative;
      expect(alt.kind).toBe("alternative");
      expect(alt.attrs.alts).toHaveLength(3);
      expect(alt.attrs.alts[0]).toMatchObject({ kind: "literal", attrs: { str: "a" } });
    });

    it("attaches name from dest", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ dest: "my_input" })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]?.meta?.name).toBe("my_input");
    });

    it("attaches help as doc description", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ help: "An input file" })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]?.meta?.doc?.description).toBe("An input file");
    });

    it("attaches default value", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ default: "foo" })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]?.meta?.defaultValue).toBe("foo");
    });

    it("ignores SUPPRESS default", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ default: { __argparse__: "SUPPRESS" } })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]?.meta?.defaultValue).toBeUndefined();
    });
  });

  describe("store action (optional)", () => {
    it("wraps in optional(seq(lit, value))", () => {
      const result = parse(
        minimalDescriptor({
          actions: [optionalAction()],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      const inner = opt.attrs.node as Sequence;
      expect(inner.kind).toBe("sequence");
      expect(inner.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "--flag1" } });
      expect(inner.attrs.nodes[1]).toMatchObject({ kind: "str" });
    });

    it("prefers long option string", () => {
      const result = parse(
        minimalDescriptor({
          actions: [optionalAction({ option_strings: ["-f", "--foo"] })],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      const inner = opt.attrs.node as Sequence;
      expect(inner.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "--foo" } });
    });

    it("does not wrap required optional in optional()", () => {
      const result = parse(
        minimalDescriptor({
          actions: [optionalAction({ required: true })],
        }),
      );
      const nodes = actionNodes(result);
      const inner = nodes[0] as Sequence;
      expect(inner.kind).toBe("sequence");
      expect(inner.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "--flag1" } });
    });

    it("hoists metadata to outermost wrapper", () => {
      const result = parse(
        minimalDescriptor({
          actions: [optionalAction({ help: "Some help", dest: "flag1" })],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.meta?.doc?.description).toBe("Some help");
    });
  });

  describe("store_true / store_false", () => {
    it("parses store_true as optional(literal)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "verbose",
              action_type: "store_true",
              option_strings: ["-v", "--verbose"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      expect(opt.attrs.node).toMatchObject({ kind: "literal", attrs: { str: "--verbose" } });
      expect(opt.meta?.defaultValue).toBe(false);
    });

    it("parses store_false with default true", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "no_header",
              action_type: "store_false",
              option_strings: ["--no-header"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      expect(opt.attrs.node).toMatchObject({ kind: "literal", attrs: { str: "--no-header" } });
      expect(opt.meta?.defaultValue).toBe(true);
    });
  });

  describe("store_const", () => {
    it("parses store_const as optional(literal)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "mode",
              action_type: "store_const",
              option_strings: ["--fast"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      expect(opt.attrs.node).toMatchObject({ kind: "literal", attrs: { str: "--fast" } });
    });
  });

  describe("boolean_optional", () => {
    it("parses as optional(alt(--flag, --no-flag))", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "color",
              action_type: "boolean_optional",
              option_strings: ["--color", "--no-color"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      const alt = opt.attrs.node as Alternative;
      expect(alt.kind).toBe("alternative");
      expect(alt.attrs.alts).toHaveLength(2);
      expect(alt.attrs.alts[0]).toMatchObject({ kind: "literal", attrs: { str: "--color" } });
      expect(alt.attrs.alts[1]).toMatchObject({ kind: "literal", attrs: { str: "--no-color" } });
      expect(opt.meta?.defaultValue).toBe(false);
    });
  });

  describe("count", () => {
    it("parses as repeat(literal)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "verbose",
              action_type: "count",
              option_strings: ["-v", "--verbose"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const rep = nodes[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      expect(rep.attrs.node).toMatchObject({ kind: "literal", attrs: { str: "--verbose" } });
      expect(rep.attrs.countMin).toBe(0);
    });
  });

  describe("append / extend", () => {
    it("parses append with flag as rep(seq(lit, value))", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "include",
              action_type: "append",
              option_strings: ["--include"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const rep = nodes[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      const inner = rep.attrs.node as Sequence;
      expect(inner.kind).toBe("sequence");
      expect(inner.attrs.nodes[0]).toMatchObject({
        kind: "literal",
        attrs: { str: "--include" },
      });
      expect(inner.attrs.nodes[1]).toMatchObject({ kind: "str" });
    });

    it("parses extend with flag same as append", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "paths",
              action_type: "extend",
              option_strings: ["--path"],
              type_info: { name: "Path", module: "pathlib" },
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const rep = nodes[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      const inner = rep.attrs.node as Sequence;
      expect(inner.attrs.nodes[1]).toMatchObject({ kind: "path" });
    });
  });

  describe("nargs variants", () => {
    it("null nargs -> bare value", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ nargs: null })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "str" });
    });

    it("? nargs -> optional", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ nargs: "?" })],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      expect(opt.attrs.node).toMatchObject({ kind: "str" });
    });

    it("* nargs -> repeat(min:0)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ nargs: "*" })],
        }),
      );
      const nodes = actionNodes(result);
      const rep = nodes[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      expect(rep.attrs.countMin).toBe(0);
    });

    it("+ nargs -> repeat(min:1)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ nargs: "+" })],
        }),
      );
      const nodes = actionNodes(result);
      const rep = nodes[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      expect(rep.attrs.countMin).toBe(1);
    });

    it("N nargs -> repeat(min:N, max:N)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ nargs: 3 })],
        }),
      );
      const nodes = actionNodes(result);
      const rep = nodes[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      expect(rep.attrs.countMin).toBe(3);
      expect(rep.attrs.countMax).toBe(3);
    });

    it("nargs=1 -> bare value (no repeat)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ nargs: 1 })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "str" });
    });

    it("REMAINDER nargs -> repeat(str())", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ nargs: { __argparse__: "REMAINDER" } })],
        }),
      );
      const nodes = actionNodes(result);
      const rep = nodes[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      expect(rep.attrs.node).toMatchObject({ kind: "str" });
      expect(rep.attrs.countMin).toBe(0);
    });
  });

  describe("type resolution", () => {
    it("no type_info -> str", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction()],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "str" });
    });

    it("non-serializable type -> str + warning", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            storeAction({
              type_info: { name: "<lambda>", serializable: false },
            }),
          ],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "str" });
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]?.message).toContain("Non-serializable");
    });

    it("unknown type -> str + warning", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            storeAction({
              type_info: { name: "MyCustomType", module: "mymodule" },
            }),
          ],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]).toMatchObject({ kind: "str" });
      expect(result.warnings.some((w) => w.message.includes("Unknown type"))).toBe(true);
    });

    it("str type_info -> str (no warning)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ type_info: { name: "str", builtin: true } })],
        }),
      );
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("subparsers", () => {
    it("parses subparsers as alternative", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "command",
              action_type: "parsers",
              subparsers: {
                add: {
                  prog: "test-tool add",
                  actions: [
                    { dest: "name", action_type: "store", option_strings: [] },
                  ],
                },
                remove: {
                  prog: "test-tool remove",
                  actions: [
                    { dest: "id", action_type: "store", option_strings: [] },
                  ],
                },
              },
              subparsers_required: true,
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const alt = nodes[0] as Alternative;
      expect(alt.kind).toBe("alternative");
      expect(alt.attrs.alts).toHaveLength(2);

      // Each alt is seq(lit(name), ...subparser_actions)
      const addSeq = alt.attrs.alts[0] as Sequence;
      expect(addSeq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "add" } });
      expect(addSeq.attrs.nodes[1]).toMatchObject({ kind: "str" });
      expect(addSeq.meta?.name).toBe("add");
    });

    it("wraps non-required subparsers in optional", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "command",
              action_type: "parsers",
              subparsers: {
                sub1: { prog: "t sub1", actions: [] },
                sub2: { prog: "t sub2", actions: [] },
              },
              subparsers_required: false,
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      const alt = opt.attrs.node as Alternative;
      expect(alt.kind).toBe("alternative");
    });

    it("attaches aliases in doc", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "command",
              action_type: "parsers",
              subparsers: {
                checkout: { prog: "git checkout", actions: [] },
              },
              subparsers_aliases: { checkout: ["co"] },
              subparsers_required: true,
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      // Single subparser -> unwrapped
      const subSeq = nodes[0] as Sequence;
      expect(subSeq.meta?.doc?.description).toContain("aliases: co");
    });

    it("recursive subparsers", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "command",
              action_type: "parsers",
              subparsers: {
                remote: {
                  prog: "git remote",
                  actions: [
                    {
                      dest: "subcmd",
                      action_type: "parsers",
                      subparsers: {
                        add: {
                          prog: "git remote add",
                          actions: [
                            { dest: "name", action_type: "store", option_strings: [] },
                            { dest: "url", action_type: "store", option_strings: [] },
                          ],
                        },
                      },
                      subparsers_required: true,
                    },
                  ],
                },
              },
              subparsers_required: true,
            },
          ],
        }),
      );
      expect(result.errors).toHaveLength(0);
      const nodes = actionNodes(result);
      // Single subparser -> unwrapped to seq
      const remoteSeq = nodes[0] as Sequence;
      expect(remoteSeq.attrs.nodes[0]).toMatchObject({
        kind: "literal",
        attrs: { str: "remote" },
      });
      // The nested subparser "add" is also a single -> unwrapped
      const addSeq = remoteSeq.attrs.nodes[1] as Sequence;
      expect(addSeq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "add" } });
    });
  });

  describe("mutual exclusion groups", () => {
    it("rewrites grouped actions into alt()", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "json",
              action_type: "store_true",
              option_strings: ["--json"],
            },
            {
              dest: "xml",
              action_type: "store_true",
              option_strings: ["--xml"],
            },
          ],
          mutually_exclusive_groups: [
            {
              required: false,
              actions: ["json", "xml"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      // Should have one optional(alt(...)) instead of two separate optionals
      expect(nodes).toHaveLength(1);
      const opt = nodes[0] as Optional;
      expect(opt.kind).toBe("optional");
      const alt = opt.attrs.node as Alternative;
      expect(alt.kind).toBe("alternative");
      expect(alt.attrs.alts).toHaveLength(2);
    });

    it("required group -> alt() without optional wrapper", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "json",
              action_type: "store_true",
              option_strings: ["--json"],
            },
            {
              dest: "xml",
              action_type: "store_true",
              option_strings: ["--xml"],
            },
          ],
          mutually_exclusive_groups: [
            {
              required: true,
              actions: ["json", "xml"],
            },
          ],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes).toHaveLength(1);
      const alt = nodes[0] as Alternative;
      expect(alt.kind).toBe("alternative");
    });
  });

  describe("skip actions", () => {
    it("skips help action", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            { dest: "help", action_type: "help", option_strings: ["-h", "--help"] },
            storeAction({ dest: "input" }),
          ],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.meta?.name).toBe("input");
    });

    it("skips version action", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "version",
              action_type: "version",
              option_strings: ["--version"],
              version: "1.0",
            },
            storeAction({ dest: "input" }),
          ],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("handles deprecated action (still parses)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ deprecated: true })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes).toHaveLength(1);
    });

    it("handles unknown custom_action_class with warning", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            {
              dest: "custom",
              action_type: "unknown",
              option_strings: ["--custom"],
              custom_action_class: "mymodule.MyAction",
            },
          ],
        }),
      );
      expect(result.warnings.some((w) => w.message.includes("custom class"))).toBe(true);
    });

    it("handles SUPPRESS help (no doc)", () => {
      const result = parse(
        minimalDescriptor({
          actions: [storeAction({ help: { __argparse__: "SUPPRESS" } })],
        }),
      );
      const nodes = actionNodes(result);
      expect(nodes[0]?.meta?.doc).toBeUndefined();
    });

    it("handles empty actions array", () => {
      const result = parse(minimalDescriptor({ actions: [] }));
      expect(result.errors).toHaveLength(0);
      const nodes = actionNodes(result);
      expect(nodes).toHaveLength(0);
    });

    it("positionals come before optionals", () => {
      const result = parse(
        minimalDescriptor({
          actions: [
            optionalAction({ dest: "opt1" }),
            storeAction({ dest: "pos1" }),
            optionalAction({ dest: "opt2", option_strings: ["--opt2"] }),
            storeAction({ dest: "pos2" }),
          ],
        }),
      );
      const nodes = actionNodes(result);
      // pos1, pos2, opt1, opt2
      expect(nodes).toHaveLength(4);
      // First two are positionals (str)
      expect(nodes[0]).toMatchObject({ kind: "str" });
      expect(nodes[1]).toMatchObject({ kind: "str" });
      // Next two are optionals
      expect(nodes[2]?.kind).toBe("optional");
      expect(nodes[3]?.kind).toBe("optional");
    });
  });

  describe("integration: realistic CLI tool", () => {
    const toolDescriptor = {
      prog: "mytool",
      description: "A sample CLI tool",
      actions: [
        {
          dest: "input_file",
          action_type: "store",
          option_strings: [],
          type_info: { name: "Path", module: "pathlib" },
          help: "Input file path",
        },
        {
          dest: "output",
          action_type: "store",
          option_strings: ["-o", "--output"],
          type_info: { name: "str", builtin: true },
          help: "Output path",
          required: false,
        },
        {
          dest: "verbose",
          action_type: "count",
          option_strings: ["-v", "--verbose"],
          help: "Increase verbosity",
        },
        {
          dest: "format",
          action_type: "store",
          option_strings: ["-f", "--format"],
          choices: ["json", "csv", "tsv"],
          help: "Output format",
        },
        {
          dest: "dry_run",
          action_type: "store_true",
          option_strings: ["--dry-run"],
          help: "Dry run mode",
        },
        { dest: "help", action_type: "help", option_strings: ["-h", "--help"] },
        {
          dest: "version",
          action_type: "version",
          option_strings: ["--version"],
          version: "%(prog)s 2.0.0",
        },
      ],
    };

    it("parses without errors", () => {
      const result = parse(toolDescriptor);
      expect(result.errors).toHaveLength(0);
      expect(result.meta?.id).toBe("mytool");
      expect(result.meta?.version).toBe("2.0.0");
    });

    it("has correct structure", () => {
      const result = parse(toolDescriptor);
      const seq = result.expr as Sequence;

      // lit("mytool") + 1 positional + 4 optionals (help/version skipped)
      expect(seq.attrs.nodes[0]).toMatchObject({ kind: "literal", attrs: { str: "mytool" } });

      const nodes = actionNodes(result);
      expect(nodes).toHaveLength(5);

      // input_file (positional path)
      expect(nodes[0]).toMatchObject({ kind: "path" });

      // output (optional str with flag)
      const output = nodes[1] as Optional;
      expect(output.kind).toBe("optional");

      // verbose (count -> repeat)
      const verbose = nodes[2] as Repeat;
      expect(verbose.kind).toBe("repeat");

      // format (optional with choices)
      const format = nodes[3] as Optional;
      expect(format.kind).toBe("optional");

      // dry_run (store_true flag)
      const dryRun = nodes[4] as Optional;
      expect(dryRun.kind).toBe("optional");
      expect(dryRun.meta?.defaultValue).toBe(false);
    });
  });
});
