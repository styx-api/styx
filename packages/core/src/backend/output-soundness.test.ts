import { describe, expect, it } from "vitest";
import { defaultPipeline } from "../ir/index.js";
import { resolveOutputs, solve } from "../solver/index.js";
import { BoutiquesParser } from "../frontend/boutiques/parser.js";
import { createContext } from "../manifest/context.js";
import type { CodegenContext } from "../manifest/index.js";
import { generatePython } from "./python/python.js";
import { generateTypeScript } from "./typescript/typescript.js";
import { generateOutputsSchema } from "./schema/jsonschema.js";
import { generateNipype } from "./nipype/nipype.js";
import { generatePydra } from "./pydra/pydra.js";
import { generateBoutiques } from "./boutiques/boutiques.js";

/**
 * Cross-backend output soundness. The unit tests elsewhere are per-backend
 * example tests; this table asserts the invariant that let a whole class of bug
 * through: an output declared in the source must SURFACE in every backend that
 * emits outputs, with the backends agreeing on the field set. Data-driven so a
 * new scenario is one row, not a new test per backend.
 */

const parser = new BoutiquesParser();

function compileCtx(descriptor: Record<string, unknown>): CodegenContext {
  const { expr, meta } = parser.parse(JSON.stringify(descriptor));
  const optimized = defaultPipeline.apply(expr).expr;
  const solveResult = solve(optimized);
  const outputs = resolveOutputs(optimized, solveResult);
  return createContext(optimized, solveResult, outputs, { app: meta });
}

// Field-name extractors for the two typed language backends (robust to docstring
// / JSDoc lines, which never match `name:`).
function pyOutputFields(code: string): string[] {
  const cls = code.match(/class \w*Outputs[^:]*:\n([\s\S]*?)(?=\ndef |\nclass |\n@|\n\n\S|$)/);
  return cls ? [...cls[1]!.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]!) : [];
}
function tsOutputFields(code: string): string[] {
  const iface = code.match(/interface \w*Outputs \{\n([\s\S]*?)\n\}/);
  return iface ? [...iface[1]!.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!) : [];
}
function schemaOutputFields(ctx: CodegenContext): string[] {
  const props = generateOutputsSchema(ctx).properties as Record<string, unknown> | undefined;
  return props ? Object.keys(props) : [];
}
// Every output-files id anywhere in the Boutiques descriptor (root, union arms,
// nested subcommand descriptors).
function boutiquesOutputIds(bt: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const scan = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const rec = o as Record<string, unknown>;
    for (const f of (rec["output-files"] as { id: string }[] | undefined) ?? []) ids.push(f.id);
    for (const inp of (rec.inputs as unknown[]) ?? []) {
      const t = (inp as Record<string, unknown>).type;
      if (Array.isArray(t)) t.forEach(scan);
      else scan(t);
    }
  };
  scan(bt);
  return ids;
}

interface Scenario {
  name: string;
  descriptor: Record<string, unknown>;
  /** Declared output field names that must surface in the typed backends. */
  declared: string[];
  /** Declared *file* outputs that must round-trip as Boutiques output-files. */
  boutiquesFiles: string[];
}

const input = (id: string, key: string, extra: Record<string, unknown> = {}) => ({
  id,
  "value-key": key,
  type: "String",
  ...extra,
});
const out = (id: string, template: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  "path-template": template,
  ...extra,
});
const multiSub = (id: string, cmd: string, o: string) => ({
  id,
  "command-line": `${cmd} [${id}A] [${id}B]`,
  inputs: [input("a", `[${id}A]`), input("b", `[${id}B]`)],
  "output-files": [out(o, `[${id}A].${o}`)],
});

const scenarios: Scenario[] = [
  {
    name: "simple root output",
    descriptor: {
      name: "t",
      "command-line": "t [IN]",
      inputs: [input("in", "[IN]")],
      "output-files": [out("res", "[IN].res")],
    },
    declared: ["res"],
    boutiquesFiles: ["res"],
  },
  {
    name: "optional output (gated)",
    descriptor: {
      name: "t",
      "command-line": "t [IN]",
      inputs: [input("in", "[IN]", { optional: true })],
      "output-files": [out("res", "[IN].res")],
    },
    declared: ["res"],
    boutiquesFiles: ["res"],
  },
  {
    name: "list output (iterated)",
    descriptor: {
      name: "t",
      "command-line": "t [IN]",
      inputs: [input("in", "[IN]", { list: true })],
      "output-files": [out("res", "[IN].res")],
    },
    declared: ["res"],
    boutiquesFiles: ["res"],
  },
  {
    name: "strip-extensions + fallback",
    descriptor: {
      name: "t",
      "command-line": "t [IN]",
      inputs: [input("in", "[IN]", { optional: true })],
      "output-files": [
        out("res", "[IN].res", { "path-template-stripped-extensions": [".nii", ".gz"] }),
      ],
    },
    declared: ["res"],
    boutiquesFiles: ["res"],
  },
  {
    name: "union arms each with an output",
    descriptor: {
      name: "t",
      "command-line": "t [S]",
      inputs: [
        {
          id: "s",
          "value-key": "[S]",
          type: [multiSub("ma", "runA", "out_a"), multiSub("mb", "runB", "out_b")],
        },
      ],
    },
    declared: ["out_a", "out_b"],
    boutiquesFiles: ["out_a", "out_b"],
  },
  {
    name: "nested plain subcommand output",
    descriptor: {
      name: "t",
      "command-line": "t [S]",
      inputs: [{ id: "s", "value-key": "[S]", type: multiSub("sub", "run", "res") }],
    },
    declared: ["res"],
    boutiquesFiles: ["res"],
  },
  {
    name: "nested list subcommand output",
    descriptor: {
      name: "t",
      "command-line": "t [S]",
      inputs: [
        { id: "s", "value-key": "[S]", list: true, type: multiSub("item", "item", "item_out") },
      ],
    },
    declared: ["item_out"],
    boutiquesFiles: ["item_out"],
  },
  {
    // A lone subcommand collapses into the root command. Because it carries an
    // output the solver force-binds it, so it takes the struct path (not the
    // unbound-sequence path, which is only reached for output-less collapses)
    // and the output must survive the collapse.
    name: "lone subcommand collapsing into root, with output",
    descriptor: {
      name: "t",
      "command-line": "t [S]",
      inputs: [
        {
          id: "s",
          "value-key": "[S]",
          type: {
            id: "sub",
            "command-line": "--name [NAME] [COUNT]",
            inputs: [input("name", "[NAME]"), input("count", "[COUNT]", { type: "Number" })],
            "output-files": [out("sub_out", "[NAME].out")],
          },
        },
      ],
    },
    declared: ["sub_out"],
    boutiquesFiles: ["sub_out"],
  },
  {
    name: "stdout / stderr streams",
    descriptor: {
      name: "t",
      "command-line": "t [IN]",
      inputs: [input("in", "[IN]")],
      "stdout-output": { id: "log", name: "Log" },
      "stderr-output": { id: "err", name: "Err" },
    },
    declared: ["log", "err"],
    boutiquesFiles: [], // streams are stdout-output/stderr-output, not output-files
  },
  {
    name: "mutable input as output",
    descriptor: {
      name: "t",
      "command-line": "t [IN]",
      inputs: [input("infile", "[IN]", { type: "File", mutable: true })],
    },
    declared: ["infile"],
    boutiquesFiles: [], // mutable round-trips as an input with mutable:true, not output-files
  },
];

describe("output soundness (cross-backend)", () => {
  for (const s of scenarios) {
    it(`${s.name}: every declared output surfaces and backends agree`, () => {
      const ctx = compileCtx(s.descriptor);
      const py = pyOutputFields(generatePython(ctx));
      const ts = tsOutputFields(generateTypeScript(ctx));
      const schema = schemaOutputFields(ctx);

      // Each declared output is present in every typed backend.
      for (const name of s.declared) {
        expect(py, `python missing ${name}`).toContain(name);
        expect(ts, `typescript missing ${name}`).toContain(name);
        expect(schema, `schema missing ${name}`).toContain(name);
      }

      // The typed backends agree on the field set (same names, order-independent).
      expect([...ts].sort(), "ts vs python field set").toEqual([...py].sort());
      expect([...schema].sort(), "schema vs python field set").toEqual([...py].sort());

      // The synthetic root output is always present.
      expect(py).toContain("root");

      // nipype/pydra embed the module + their own spec: the declared output names
      // must appear in their generated source.
      const nip = generateNipype(ctx);
      const pyd = generatePydra(ctx);
      for (const name of s.declared) {
        expect(nip.includes(name), `nipype missing ${name}`).toBe(true);
        expect(pyd.includes(name), `pydra missing ${name}`).toBe(true);
      }

      // Declared file outputs round-trip through the Boutiques backend.
      const btIds = boutiquesOutputIds(
        generateBoutiques(ctx).descriptor as Record<string, unknown>,
      );
      for (const id of s.boutiquesFiles) {
        expect(btIds, `boutiques missing ${id}`).toContain(id);
      }
    });
  }
});
