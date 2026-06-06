import { describe, expect, it } from "vitest";
import type { Output } from "../../ir/index.js";
import type { Alternative, Expr, Literal, Optional, Repeat, Sequence } from "../../ir/node.js";
import { MrtrixParser } from "./parser.js";

const parser = new MrtrixParser();

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

function arg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "in_image",
    description: "an input",
    type: "image in",
    optional: false,
    allow_multiple: false,
    ...overrides,
  };
}

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "opt",
    description: "an option",
    optional: true,
    allow_multiple: false,
    arguments: [],
    ...overrides,
  };
}

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "mycmd",
    synopsis: "My command",
    author: "Author",
    version: "3.0.4",
    description: [],
    references: [],
    examples: [],
    requires_at_least_one_argument: false,
    arguments: [],
    option_groups: [],
    ...overrides,
  };
}

const root = (r: ReturnType<typeof parser.parse>): Sequence => r.expr as Sequence;
/** Non-literal children of the root sequence (drops the leading command literal). */
const params = (r: ReturnType<typeof parser.parse>): Expr[] =>
  root(r).attrs.nodes.filter((n) => n.kind !== "literal");

describe("MrtrixParser", () => {
  describe("parse errors", () => {
    it("errors on invalid JSON", () => {
      expect(parser.parse("not json").errors.length).toBeGreaterThan(0);
    });

    it("errors on non-object JSON", () => {
      expect(parser.parse('"x"').errors).toContainEqual({
        message: "JSON source is not an object",
      });
    });

    it("errors when 'name' is missing", () => {
      const r = parse(minimal({ name: undefined }));
      expect(r.errors.some((e) => /missing required 'name'/.test(e.message))).toBe(true);
      expect(r.meta).toBeUndefined();
    });
  });

  describe("metadata", () => {
    it("maps synopsis/description/author/references to structured doc", () => {
      const r = parse(
        minimal({
          synopsis: "Synopsis line",
          description: ["Para one.", "Para two."],
          author: "Jane Doe",
          references: ["Ref A", "Ref B"],
        }),
      );
      expect(r.meta?.id).toBe("mycmd");
      expect(r.meta?.version).toBe("3.0.4");
      expect(r.meta?.doc?.title).toBe("Synopsis line");
      expect(r.meta?.doc?.description).toBe("Para one.\n\nPara two.");
      expect(r.meta?.doc?.authors).toEqual(["Jane Doe"]);
      expect(r.meta?.doc?.literature).toEqual(["Ref A", "Ref B"]);
      expect(r.meta?.doc?.urls?.[0]).toContain("mrtrix.readthedocs.io");
    });

    it("starts the command with the tool name literal", () => {
      const first = root(parse(minimal())).attrs.nodes[0] as Literal;
      expect(first).toEqual({ kind: "literal", attrs: { str: "mycmd" } });
    });
  });

  describe("positional arguments", () => {
    it("maps an input image to a required path terminal", () => {
      const r = parse(minimal({ arguments: [arg({ id: "in_image", type: "image in" })] }));
      const [p] = params(r);
      expect(p?.kind).toBe("path");
      expect(p?.meta?.name).toBe("in_image");
    });

    it.each([
      ["integer", "int"],
      ["float", "float"],
      ["text", "str"],
      ["choice", "str"],
      ["undefined", "str"],
      ["file in", "path"],
      ["tracks in", "path"],
    ])("maps type %s to %s", (type, kind) => {
      const r = parse(minimal({ arguments: [arg({ type })] }));
      expect(params(r)[0]?.kind).toBe(kind);
    });

    it("maps an output type to a str + Output referencing it", () => {
      const r = parse(minimal({ arguments: [arg({ id: "out_file", type: "image out" })] }));
      const [p] = params(r);
      expect(p?.kind).toBe("str");
      const outs = collectOutputs(r.expr);
      expect(outs).toHaveLength(1);
      expect(outs[0]?.name).toBe("out_file");
      expect(outs[0]?.tokens).toEqual([
        { kind: "ref", target: { kind: "node-ref", name: "out_file" } },
      ]);
      expect(outs[0]?.mediaTypes).toEqual(["mrtrix/image out"]);
    });

    it("wraps allow_multiple in a repeat and optional in an optional", () => {
      const r = parse(
        minimal({ arguments: [arg({ type: "image in", optional: true, allow_multiple: true })] }),
      );
      const p = params(r)[0] as Optional;
      expect(p.kind).toBe("optional");
      expect(p.attrs.node.kind).toBe("repeat");
    });

    it("maps int/float seq to a repeat (comma-joined only when described so)", () => {
      const plain = parse(minimal({ arguments: [arg({ type: "int seq" })] }));
      const repPlain = params(plain)[0] as Repeat;
      expect(repPlain.kind).toBe("repeat");
      expect(repPlain.attrs.node.kind).toBe("int");
      expect(repPlain.attrs.join).toBeUndefined();

      const comma = parse(
        minimal({
          synopsis: "uses a comma-separated list",
          arguments: [arg({ type: "float seq" })],
        }),
      );
      const repComma = params(comma)[0] as Repeat;
      expect(repComma.attrs.node.kind).toBe("float");
      expect(repComma.attrs.join).toBe(",");
    });

    it("maps `various` to a str|file union of single-field structs with variantTags", () => {
      const r = parse(minimal({ arguments: [arg({ id: "operand", type: "various" })] }));
      const u = params(r)[0] as Alternative;
      expect(u.kind).toBe("alternative");
      expect(u.attrs.alts.map((a) => a.meta?.variantTag)).toEqual(["VariousString", "VariousFile"]);
      const stringArm = u.attrs.alts[0] as Sequence;
      expect(stringArm.attrs.nodes[0]?.kind).toBe("str");
    });
  });

  describe("options", () => {
    it("maps a 0-arg option to an optional bool flag defaulting to false", () => {
      const r = parse(
        minimal({ option_groups: [{ name: "g", options: [option({ id: "force" })] }] }),
      );
      const o = params(r)[0] as Optional;
      expect(o.kind).toBe("optional");
      expect(o.attrs.node).toEqual({ kind: "literal", attrs: { str: "-force" } });
      expect(o.meta?.name).toBe("force");
      expect(o.meta?.defaultValue).toBe(false);
    });

    it("maps a 1-arg option to opt(seq(flag, value))", () => {
      const r = parse(
        minimal({
          option_groups: [
            {
              name: "g",
              options: [
                option({ id: "nthreads", arguments: [arg({ id: "number", type: "integer" })] }),
              ],
            },
          ],
        }),
      );
      const o = params(r)[0] as Optional;
      const seq = o.attrs.node as Sequence;
      expect(seq.kind).toBe("sequence");
      expect((seq.attrs.nodes[0] as Literal).attrs.str).toBe("-nthreads");
      expect(seq.attrs.nodes[1]?.kind).toBe("int");
    });

    it("maps a repeatable multi-arg option to rep(seq(flag, a, b))", () => {
      const r = parse(
        minimal({
          option_groups: [
            {
              name: "g",
              options: [
                option({
                  id: "config",
                  allow_multiple: true,
                  arguments: [arg({ id: "key", type: "text" }), arg({ id: "value", type: "text" })],
                }),
              ],
            },
          ],
        }),
      );
      const rep = params(r)[0] as Repeat;
      expect(rep.kind).toBe("repeat");
      const seq = rep.attrs.node as Sequence;
      expect((seq.attrs.nodes[0] as Literal).attrs.str).toBe("-config");
      expect(seq.attrs.nodes.map((n) => n.meta?.name)).toEqual([undefined, "key", "value"]);
      expect(seq.meta?.name).toBe("config");
    });

    it("collects an option's output-type argument as an Output", () => {
      const r = parse(
        minimal({
          option_groups: [
            {
              name: "g",
              options: [
                option({ id: "export", arguments: [arg({ id: "path", type: "file out" })] }),
              ],
            },
          ],
        }),
      );
      expect(collectOutputs(r.expr).map((o) => o.name)).toContain("export");
    });
  });

  describe("structure", () => {
    it("emits positionals before options", () => {
      const r = parse(
        minimal({
          arguments: [arg({ id: "in_image", type: "image in" })],
          option_groups: [{ name: "g", options: [option({ id: "force" })] }],
        }),
      );
      const kinds = params(r).map((n) => n.kind);
      expect(kinds).toEqual(["path", "optional"]);
    });

    it("disambiguates a positional/option name collision, keeping the raw flag", () => {
      const r = parse(
        minimal({
          arguments: [arg({ id: "directions", type: "image in" })],
          option_groups: [
            {
              name: "g",
              options: [
                option({ id: "directions", arguments: [arg({ id: "file", type: "file in" })] }),
              ],
            },
          ],
        }),
      );
      const [pos, opt] = params(r);
      expect(pos?.meta?.name).toBe("directions");
      const seq = (opt as Optional).attrs.node as Sequence;
      // flag token keeps the raw id; only the binding name is suffixed
      expect((seq.attrs.nodes[0] as Literal).attrs.str).toBe("-directions");
      expect((seq.attrs.nodes[1] as Expr).meta?.name).toBe("directions_2");
      expect(r.warnings.some((w) => /Duplicate id 'directions'/.test(w.message))).toBe(true);
    });
  });
});
