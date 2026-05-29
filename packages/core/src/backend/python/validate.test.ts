import { describe, expect, it } from "vitest";
import type { Expr } from "../../ir/index.js";
import { generate, int, float, lit, namedAlt, opt, path, rep, seq, str } from "./test-helpers.js";

/** int terminal with an attached numeric range. */
function intRange(name: string, min?: number, max?: number): Expr {
  const n = int(name);
  if (min !== undefined) n.attrs.minValue = min;
  if (max !== undefined) n.attrs.maxValue = max;
  return n;
}
function floatRange(name: string, min?: number, max?: number): Expr {
  const n = float(name);
  if (min !== undefined) n.attrs.minValue = min;
  if (max !== undefined) n.attrs.maxValue = max;
  return n;
}
function listCount(node: Expr, name: string, min?: number, max?: number): Expr {
  const r = rep(node, name);
  if (min !== undefined) r.attrs.countMin = min;
  if (max !== undefined) r.attrs.countMax = max;
  return r;
}

describe("Python validation - wiring", () => {
  it("imports StyxValidationError and pathlib", () => {
    const code = generate(seq(lit("tool"), str("name")));
    expect(code).toContain("import pathlib");
    expect(code).toContain("StyxValidationError");
  });

  it("emits a tool-prefixed validate function", () => {
    const code = generate(seq(lit("tool"), str("name")), { app: { id: "bet" } });
    expect(code).toContain("def bet_validate(params:");
  });

  it("calls validate first thing in the execute function", () => {
    const code = generate(seq(lit("tool"), str("name")), { app: { id: "bet" } });
    // validate is invoked before the runner is resolved
    const validateIdx = code.indexOf("bet_validate(params)");
    const runnerIdx = code.indexOf("runner = runner if runner is not None");
    expect(validateIdx).toBeGreaterThan(-1);
    expect(runnerIdx).toBeGreaterThan(validateIdx);
  });

  it("includes validate in __all__", () => {
    const code = generate(seq(lit("tool"), str("name")), { app: { id: "bet" } });
    expect(code).toContain('"bet_validate"');
  });

  it("checks the root params is a dict", () => {
    const code = generate(seq(lit("tool"), str("name")));
    expect(code).toContain("if params is None or not isinstance(params, dict):");
    expect(code).toContain("Params object has the wrong type");
  });
});

describe("Python validation - scalar presence and isinstance", () => {
  it("requires non-optional fields and type-checks them", () => {
    const code = generate(seq(lit("tool"), str("name")));
    expect(code).toContain('if params.get("name", None) is None:');
    expect(code).toContain('raise StyxValidationError("`name` must not be None")');
    expect(code).toContain('if not isinstance(params["name"], str):');
    expect(code).toContain("expected `str`");
  });

  it("type-checks path fields against pathlib.Path/str", () => {
    const code = generate(seq(lit("tool"), path("infile")));
    expect(code).toContain('if not isinstance(params["infile"], (pathlib.Path, str)):');
    expect(code).toContain("expected `InputPathType`");
  });

  it("gates optional fields behind a presence check (no must-not-be-None)", () => {
    const code = generate(seq(lit("tool"), opt(seq(lit("-x"), str("note")))));
    expect(code).toContain('if params.get("note", None) is not None:');
    expect(code).not.toContain("`note` must not be None");
    expect(code).toContain("expected `str | None`");
  });

  it("gates fields with a default (flags) instead of requiring presence", () => {
    // A flag with defaultValue false -> None means 'use default', not invalid.
    const code = generate(seq(lit("tool"), opt(lit("--loud"), { name: "loud", defaultValue: false })));
    expect(code).toContain('if params.get("loud", None) is not None:');
    expect(code).not.toContain("`loud` must not be None");
    expect(code).toContain('if not isinstance(params["loud"], bool):');
  });
});

describe("Python validation - numeric range", () => {
  it("emits a between check when both bounds are set", () => {
    const code = generate(seq(lit("tool"), opt(seq(lit("-n"), intRange("num", 0, 10)))));
    expect(code).toContain('if not (0 <= params["num"] <= 10):');
    expect(code).toContain("Parameter `num` must be between 0 and 10 (inclusive)");
  });

  it("emits a min-only check", () => {
    const code = generate(seq(lit("tool"), intRange("seed", 1)));
    expect(code).toContain('if params["seed"] < 1:');
    expect(code).toContain("Parameter `seed` must be at least 1");
  });

  it("emits a max-only check", () => {
    const code = generate(seq(lit("tool"), intRange("cap", undefined, 5)));
    expect(code).toContain('if params["cap"] > 5:');
    expect(code).toContain("Parameter `cap` must be at most 5");
  });

  it("type-checks float as (float, int) and applies the range", () => {
    const code = generate(seq(lit("tool"), floatRange("ratio", 0, 1)));
    expect(code).toContain('if not isinstance(params["ratio"], (float, int)):');
    expect(code).toContain('if not (0 <= params["ratio"] <= 1):');
  });
});

describe("Python validation - list length", () => {
  it("emits a between-elements check and per-element type check", () => {
    const code = generate(seq(lit("tool"), opt(seq(lit("-r"), listCount(str("items"), "items", 1, 3)))));
    expect(code).toContain('if not isinstance(params["items"], list):');
    expect(code).toContain('if not (1 <= len(params["items"]) <= 3):');
    expect(code).toContain("Parameter `items` must contain between 1 and 3 elements (inclusive)");
    expect(code).toContain('for e in params["items"]:');
    expect(code).toContain("if not isinstance(e, str):");
  });

  it("uses singular 'element' for a min of 1", () => {
    const code = generate(seq(lit("tool"), listCount(path("imgs"), "imgs", 1)));
    expect(code).toContain("Parameter `imgs` must contain at least 1 element");
    expect(code).not.toContain("at least 1 elements");
  });
});

describe("Python validation - unions", () => {
  it("validates discriminated union @type membership and recurses per variant", () => {
    const code = generate(
      seq(lit("tool"), namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url")))),
    );
    expect(code).toContain('if not isinstance(params["source"], dict):');
    expect(code).toContain('if "@type" not in params["source"]:');
    expect(code).toContain("Params object is missing `@type`");
    expect(code).toContain('if params["source"]["@type"] not in ["variant_0", "variant_1"]:');
    expect(code).toMatch(/if params\["source"\]\["@type"\] == "variant_0":/);
    expect(code).toMatch(/elif params\["source"\]\["@type"\] == "variant_1":/);
    // recurses into variant struct fields
    expect(code).toContain('if not isinstance(params["source"]["file"], (pathlib.Path, str)):');
    expect(code).toContain('if not isinstance(params["source"]["url"], str):');
  });

  it("validates an enum (all-literal) choice as membership", () => {
    const code = generate(seq(lit("tool"), namedAlt("mode", lit("fast"), lit("slow"))));
    expect(code).toContain('not in ["fast", "slow"]');
    // the message string escapes the inner double quotes (matches v1 niwrap)
    expect(code).toContain('must be one of [\\"fast\\", \\"slow\\"]');
    // enums are not treated as @type-discriminated dicts
    expect(code).not.toContain('params["mode"]["@type"]');
  });

  it("validates a mixed union (struct + bare-literal variants) by runtime shape", () => {
    const code = generate(
      seq(lit("tool"), namedAlt("mode", lit("fast"), seq(lit("--full"), str("level")))),
    );
    // dict value -> dispatch struct variants by @type
    expect(code).toContain('if isinstance(params["mode"], dict):');
    expect(code).toContain('params["mode"]["@type"] not in ["variant_1"]');
    expect(code).toContain('if params["mode"]["@type"] == "variant_1":');
    expect(code).toContain('if not isinstance(params["mode"]["level"], str):');
    // bare value -> literal membership
    expect(code).toContain("else:");
    expect(code).toContain('if params["mode"] not in ["fast"]:');
  });
});
