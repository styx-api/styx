import { describe, expect, it } from "vitest";
import type { Expr } from "../ir/index.js";
import { lit, opt, path, seq, str } from "../ir/index.js";
import { createContext } from "../manifest/context.js";
import { resolveOutputs, solve } from "../solver/index.js";
import { generatePython } from "./python/python.js";
import { generateSchema } from "./schema/jsonschema.js";
import { generateTypeScript } from "./typescript/typescript.js";

/**
 * Cross-backend optionality-model contract.
 *
 * The JSON Schema, TypeScript, and Python backends must describe the SAME
 * {omittable, nullable} set for every field, so a config valid against one is
 * valid/correct against the others. The unified model:
 * - omittable (key may be absent) iff the field is `optional` OR carries a
 *   default (which includes flags).
 * - never nullable: the solver has no nullable type, so a present value is never
 *   null/None. Omittability is the only "unset".
 */

interface FieldContract {
  omittable: boolean;
  nullable: boolean;
}

/** A field per category, with its expected unified contract. */
const FIELDS: Array<{ name: string; node: Expr; expected: FieldContract }> = [
  // Required input (non-optional, no default).
  { name: "req_in", node: path("req_in"), expected: { omittable: false, nullable: false } },
  // Defaulted scalar (non-optional, has a default - e.g. an output basename).
  {
    name: "def_out",
    node: { kind: "str", attrs: {}, meta: { name: "def_out", defaultValue: "out" } },
    expected: { omittable: true, nullable: false },
  },
  // Flag (bool, default false).
  {
    name: "flag",
    node: opt(seq(lit("--flag")), { name: "flag", defaultValue: false }),
    expected: { omittable: true, nullable: false },
  },
  // Optional, no default.
  {
    name: "opt_val",
    node: opt(seq(lit("--opt"), str("opt_val"))),
    expected: { omittable: true, nullable: false },
  },
];

function emitAll(): { ts: string; py: string; schema: Record<string, unknown> } {
  const expr = seq(lit("tool"), ...FIELDS.map((f) => f.node));
  const sr = solve(expr);
  const outputs = resolveOutputs(expr, sr);
  const ctx = createContext(expr, sr, outputs, { app: { id: "tool" }, package: { name: "pkg" } });
  return {
    ts: generateTypeScript(ctx),
    py: generatePython(ctx),
    schema: generateSchema(ctx) as unknown as Record<string, unknown>,
  };
}

/** Parse a field's contract from the emitted TS interface. */
function tsContract(code: string, name: string): FieldContract {
  const m = code.match(new RegExp(`^\\s*${name}(\\??): ([^;]+);`, "m"));
  if (!m) throw new Error(`TS: field ${name} not found`);
  return { omittable: m[1] === "?", nullable: /\bnull\b/.test(m[2]!) };
}

/**
 * Parse a field's contract from the emitted Python TypedDict. Scopes to the type
 * declarations (which precede all `def`s) so a same-named factory-signature
 * parameter can't be mistaken for the field, and handles both class syntax
 * (`name: type`) and functional syntax (`"name": type,` - used when a `@type`
 * discriminator is present).
 */
function pyContract(code: string, name: string): FieldContract {
  const declEnd = code.indexOf("\ndef ");
  const decls = declEnd >= 0 ? code.slice(0, declEnd) : code;
  const m = decls.match(new RegExp(`^\\s*"?${name}"?: (.+?),?$`, "m"));
  if (!m) throw new Error(`Python: field ${name} not found in TypedDict`);
  const type = m[1]!;
  return { omittable: type.includes("typing.NotRequired["), nullable: /\bNone\b/.test(type) };
}

/** Parse a field's contract from the emitted JSON Schema. */
function schemaContract(schema: Record<string, unknown>, name: string): FieldContract {
  const required = (schema.required as string[] | undefined) ?? [];
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const prop = props[name];
  if (!prop) throw new Error(`Schema: field ${name} not found`);
  // A JSON Schema field is "nullable" if it admits the null type anywhere.
  const json = JSON.stringify(prop);
  const nullable = /"type":\s*"null"/.test(json) || /"null"/.test(json);
  return { omittable: !required.includes(name), nullable };
}

describe("cross-backend optionality model", () => {
  const emitted = emitAll();

  for (const { name, expected } of FIELDS) {
    it(`agrees on {omittable, nullable} for ${name}`, () => {
      const ts = tsContract(emitted.ts, name);
      const py = pyContract(emitted.py, name);
      const sc = schemaContract(emitted.schema, name);
      // All three backends match the expected unified contract...
      expect(ts).toEqual(expected);
      expect(py).toEqual(expected);
      expect(sc).toEqual(expected);
      // ...hence each other.
      expect(ts).toEqual(py);
      expect(py).toEqual(sc);
    });
  }

  it("never marks any field nullable (solver has no nullable type)", () => {
    for (const { name } of FIELDS) {
      expect(tsContract(emitted.ts, name).nullable).toBe(false);
      expect(pyContract(emitted.py, name).nullable).toBe(false);
      expect(schemaContract(emitted.schema, name).nullable).toBe(false);
    }
  });
});
