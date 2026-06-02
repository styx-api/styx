import { describe, expect, it } from "vitest";
import type { Output } from "../../ir/index.js";
import type { Alternative, Expr, Optional, Path, Repeat, Sequence } from "../../ir/node.js";
import { WorkbenchParser } from "./parser.js";

const parser = new WorkbenchParser();

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

function param(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: 1, short_name: "in-file", description: "an input", type: "String", ...overrides };
}

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 1,
    option_switch: "-opt",
    description: "an option",
    params: [],
    outputs: [],
    options: [],
    repeatable_options: [],
    ...overrides,
  };
}

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: "-my-command",
    short_description: "MY COMMAND",
    help_text: "Long help.",
    version_info: [],
    params: [],
    outputs: [],
    options: [],
    repeatable_options: [],
    ...overrides,
  };
}

const root = (r: ReturnType<typeof parser.parse>): Sequence => r.expr as Sequence;

describe("WorkbenchParser", () => {
  describe("parse errors", () => {
    it("returns error for invalid JSON", () => {
      const result = parser.parse("not json");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("returns error for non-object JSON", () => {
      const result = parser.parse('"a string"');
      expect(result.errors).toContainEqual({ message: "JSON source is not an object" });
    });

    it("returns error when 'command' is missing", () => {
      const result = parse({ short_description: "x" });
      expect(result.errors.some((e) => /missing required 'command'/.test(e.message))).toBe(true);
      expect(result.meta).toBeUndefined();
    });

    it("errors when a param is missing short_name/type", () => {
      const result = parse(minimal({ params: [{ key: 1, description: "d" }] }));
      expect(result.errors.some((e) => /param missing 'short_name'\/'type'/.test(e.message))).toBe(
        true,
      );
    });

    it("errors when an option is missing option_switch", () => {
      const result = parse(minimal({ options: [{ key: 1, description: "d" }] }));
      expect(result.errors.some((e) => /option missing 'option_switch'/.test(e.message))).toBe(
        true,
      );
    });

    it("warns and skips a non-object entry rather than crashing", () => {
      const result = parse(minimal({ params: ["oops"], options: [42] }));
      expect(result.warnings.length).toBeGreaterThan(0);
      // The command prefix is still emitted; the junk entries are dropped.
      expect(root(result).attrs.nodes).toHaveLength(2);
    });
  });

  describe("app metadata", () => {
    it("derives id from command, stripping the leading dash", () => {
      const result = parse(minimal({ command: "-border-merge" }));
      expect(result.meta?.id).toBe("border_merge");
    });

    it("maps short_description -> title and help_text -> description", () => {
      const result = parse(minimal({ short_description: "TITLE", help_text: "BODY" }));
      expect(result.meta?.doc?.title).toBe("TITLE");
      expect(result.meta?.doc?.description).toBe("BODY");
    });

    it("extracts a clean version from version_info lines", () => {
      const result = parse(minimal({ version_info: ["Connectome Workbench", "Version: 2.1.0"] }));
      expect(result.meta?.version).toBe("2.1.0");
    });

    it("leaves version unset when version_info has no Version line", () => {
      const result = parse(minimal({ version_info: ["Connectome Workbench"] }));
      expect(result.meta?.version).toBeUndefined();
    });
  });

  describe("command prefix", () => {
    it("emits wb_command and the command switch as the first two literals", () => {
      const seq = root(parse(minimal({ command: "-foo" })));
      expect(seq.attrs.nodes[0]).toEqual({ kind: "literal", attrs: { str: "wb_command" } });
      expect(seq.attrs.nodes[1]).toEqual({ kind: "literal", attrs: { str: "-foo" } });
    });
  });

  describe("positional params", () => {
    it("maps each scalar/file type to the right terminal", () => {
      const seq = root(
        parse(
          minimal({
            params: [
              param({ short_name: "s", type: "String" }),
              param({ short_name: "i", type: "Integer" }),
              param({ short_name: "f", type: "Floating Point" }),
              param({ short_name: "surf", type: "Surface File" }),
            ],
          }),
        ),
      );
      const kinds = seq.attrs.nodes.slice(2).map((n) => n.kind);
      expect(kinds).toEqual(["str", "int", "float", "path"]);
    });

    it("names params via snake_case and carries the description", () => {
      const seq = root(parse(minimal({ params: [param({ short_name: "in-file" })] })));
      const node = seq.attrs.nodes[2]!;
      expect(node.meta?.name).toBe("in_file");
      expect(node.meta?.doc?.description).toBe("an input");
    });

    it("tags file params with the workbench media type", () => {
      const seq = root(
        parse(minimal({ params: [param({ short_name: "b", type: "Border File" })] })),
      );
      const node = seq.attrs.nodes[2] as Path;
      expect(node.attrs.mediaTypes).toEqual(["workbench/Border File"]);
    });

    it("maps a Boolean param to a true/false literal choice", () => {
      const seq = root(parse(minimal({ params: [param({ short_name: "b", type: "Boolean" })] })));
      const node = seq.attrs.nodes[2] as Alternative;
      expect(node.kind).toBe("alternative");
      expect(node.attrs.alts).toEqual([
        { kind: "literal", attrs: { str: "true" } },
        { kind: "literal", attrs: { str: "false" } },
      ]);
    });

    it("errors on an unknown param type", () => {
      const result = parse(minimal({ params: [param({ type: "Bogus" })] }));
      expect(result.errors.some((e) => /Unknown workbench type 'Bogus'/.test(e.message))).toBe(
        true,
      );
    });
  });

  describe("outputs", () => {
    it("emits a str terminal plus an Output referencing it", () => {
      const result = parse(
        minimal({
          outputs: [
            { key: 1, short_name: "out-file", description: "the output", type: "Border File" },
          ],
        }),
      );
      const seq = root(result);
      const node = seq.attrs.nodes[2]!;
      expect(node.kind).toBe("str");
      expect(node.meta?.name).toBe("out_file");

      const outputs = collectOutputs(result.expr);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({
        name: "out_file",
        tokens: [{ kind: "ref", target: { kind: "node-ref", name: "out_file" } }],
        mediaTypes: ["workbench/Border File"],
      });
    });

    it("rejects an output with a non-file type", () => {
      const result = parse(
        minimal({ outputs: [{ key: 1, short_name: "x", description: "", type: "String" }] }),
      );
      expect(result.errors.some((e) => /non-file type 'String'/.test(e.message))).toBe(true);
    });
  });

  describe("options", () => {
    it("maps a pure-flag option to an optional flag with defaultValue false", () => {
      const seq = root(
        parse(minimal({ options: [option({ option_switch: "-separate-pieces" })] })),
      );
      const optNode = seq.attrs.nodes[2] as Optional;
      expect(optNode.kind).toBe("optional");
      expect(optNode.attrs.node).toEqual({ kind: "literal", attrs: { str: "-separate-pieces" } });
      expect(optNode.meta?.name).toBe("separate_pieces");
      expect(optNode.meta?.defaultValue).toBe(false);
    });

    it("maps an option with a param to an optional switch+value struct", () => {
      const seq = root(
        parse(
          minimal({
            options: [
              option({
                option_switch: "-corrected-areas",
                params: [param({ short_name: "area-metric", type: "Metric File" })],
              }),
            ],
          }),
        ),
      );
      const optNode = seq.attrs.nodes[2] as Optional;
      expect(optNode.kind).toBe("optional");
      expect(optNode.meta?.doc?.description).toBe("an option");
      const inner = optNode.attrs.node as Sequence;
      expect(inner.kind).toBe("sequence");
      expect(inner.meta?.name).toBe("corrected_areas");
      expect(inner.attrs.nodes[0]).toEqual({ kind: "literal", attrs: { str: "-corrected-areas" } });
      expect(inner.attrs.nodes[1]?.kind).toBe("path");
    });

    it("maps a repeatable option with content to a repeat-of-struct", () => {
      const seq = root(
        parse(
          minimal({
            repeatable_options: [
              option({
                option_switch: "-border",
                params: [param({ short_name: "f", type: "Border File" })],
              }),
            ],
          }),
        ),
      );
      const repNode = seq.attrs.nodes[2] as Repeat;
      expect(repNode.kind).toBe("repeat");
      expect((repNode.attrs.node as Sequence).kind).toBe("sequence");
    });

    it("maps a repeatable pure-flag option to a repeat-of-literal (count)", () => {
      const seq = root(parse(minimal({ repeatable_options: [option({ option_switch: "-v" })] })));
      const repNode = seq.attrs.nodes[2] as Repeat;
      expect(repNode.kind).toBe("repeat");
      expect(repNode.attrs.node).toEqual({ kind: "literal", attrs: { str: "-v" } });
    });

    it("nests options recursively (border -> select -> up-to -> reverse)", () => {
      const result = parse(
        minimal({
          repeatable_options: [
            option({
              option_switch: "-border",
              params: [param({ short_name: "f", type: "Border File" })],
              repeatable_options: [
                option({
                  option_switch: "-select",
                  params: [param({ short_name: "n", type: "String" })],
                  options: [
                    option({
                      option_switch: "-up-to",
                      params: [param({ short_name: "last", type: "String" })],
                      options: [option({ option_switch: "-reverse" })],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      );
      expect(result.errors).toEqual([]);

      // Walk down to the deepest -reverse flag to confirm full nesting.
      const border = (root(result).attrs.nodes[2] as Repeat).attrs.node as Sequence;
      const select = border.attrs.nodes.find((n) => n.kind === "repeat") as Repeat;
      const selectSeq = select.attrs.node as Sequence;
      const upTo = selectSeq.attrs.nodes.find((n) => n.kind === "optional") as Optional;
      const upToSeq = upTo.attrs.node as Sequence;
      const reverse = upToSeq.attrs.nodes.find((n) => n.kind === "optional") as Optional;
      expect(reverse.attrs.node).toEqual({ kind: "literal", attrs: { str: "-reverse" } });
      expect(reverse.meta?.name).toBe("reverse");
    });

    it("attaches an option's outputs to its struct sequence", () => {
      const result = parse(
        minimal({
          options: [
            option({
              option_switch: "-from-gifti-ext",
              params: [param({ short_name: "gifti-in", type: "String" })],
              outputs: [
                { key: 9, short_name: "cifti-out", description: "out", type: "Cifti File" },
              ],
            }),
          ],
        }),
      );
      const outputs = collectOutputs(result.expr);
      expect(outputs.map((o) => o.name)).toEqual(["cifti_out"]);
    });
  });
});
