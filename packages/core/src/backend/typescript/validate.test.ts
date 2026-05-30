import { describe, expect, it } from "vitest";
import type { Expr } from "../../ir/index.js";
import { generate, int, float, lit, namedAlt, opt, path, rep, seq, str } from "./test-helpers.js";

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

describe("TypeScript validation - wiring", () => {
  it("imports StyxValidationError", () => {
    const code = generate(seq(lit("tool"), str("name")));
    expect(code).toContain('import { getGlobalRunner, StyxValidationError } from "styxdefs";');
  });

  it("emits a tool-prefixed validate function", () => {
    const code = generate(seq(lit("tool"), str("name")), { app: { id: "bet" } });
    expect(code).toContain("export function betValidate(params:");
  });

  it("calls validate first thing in the execute function", () => {
    const code = generate(seq(lit("tool"), str("name")), { app: { id: "bet" } });
    const validateIdx = code.indexOf("betValidate(params);");
    const runnerIdx = code.indexOf("runner = runner ?? getGlobalRunner();");
    expect(validateIdx).toBeGreaterThan(-1);
    expect(runnerIdx).toBeGreaterThan(validateIdx);
  });
});

describe("TypeScript validation - scalar presence and isinstance", () => {
  it("requires non-optional fields and type-checks them", () => {
    const code = generate(seq(lit("tool"), str("name")));
    expect(code).toContain("if (params.name == null) {");
    expect(code).toContain('throw new StyxValidationError("`name` must not be null");');
    expect(code).toContain('if (typeof params.name !== "string") {');
  });

  it("type-checks path fields as strings", () => {
    const code = generate(seq(lit("tool"), path("infile")));
    expect(code).toContain('if (typeof params.infile !== "string") {');
    expect(code).toContain("expected InputPathType");
  });

  it("gates optional fields behind a presence check (no must-not-be-null)", () => {
    const code = generate(seq(lit("tool"), opt(seq(lit("-x"), str("note")))));
    expect(code).toContain("if (params.note != null) {");
    expect(code).not.toContain("`note` must not be null");
  });

  it("gates fields with a default (flags) instead of requiring presence", () => {
    const code = generate(
      seq(lit("tool"), opt(lit("--loud"), { name: "loud", defaultValue: false })),
    );
    expect(code).toContain("if (params.loud != null) {");
    expect(code).not.toContain("`loud` must not be null");
    expect(code).toContain('if (typeof params.loud !== "boolean") {');
  });
});

describe("TypeScript validation - numeric range", () => {
  it("emits a between check when both bounds are set", () => {
    const code = generate(seq(lit("tool"), opt(seq(lit("-n"), intRange("num", 0, 10)))));
    expect(code).toContain("if (!(0 <= params.num && params.num <= 10)) {");
    expect(code).toContain("Parameter `num` must be between 0 and 10 (inclusive)");
  });

  it("emits a min-only check", () => {
    const code = generate(seq(lit("tool"), intRange("seed", 1)));
    expect(code).toContain("if (params.seed < 1) {");
    expect(code).toContain("Parameter `seed` must be at least 1");
  });

  it("emits a max-only check", () => {
    const code = generate(seq(lit("tool"), intRange("cap", undefined, 5)));
    expect(code).toContain("if (params.cap > 5) {");
    expect(code).toContain("Parameter `cap` must be at most 5");
  });

  it("type-checks float as number and applies the range", () => {
    const code = generate(seq(lit("tool"), floatRange("ratio", 0, 1)));
    expect(code).toContain('if (typeof params.ratio !== "number") {');
    expect(code).toContain("if (!(0 <= params.ratio && params.ratio <= 1)) {");
  });
});

describe("TypeScript validation - list length", () => {
  it("emits Array.isArray, a between-length check, and per-element check", () => {
    const code = generate(
      seq(lit("tool"), opt(seq(lit("-r"), listCount(str("items"), "items", 1, 3)))),
    );
    expect(code).toContain("if (!Array.isArray(params.items)) {");
    expect(code).toContain("if (!(1 <= params.items.length && params.items.length <= 3)) {");
    expect(code).toContain("Parameter `items` must contain between 1 and 3 elements (inclusive)");
    expect(code).toContain("for (const el of params.items) {");
    expect(code).toContain('if (typeof el !== "string") {');
  });

  it("uses singular 'element' for a min of 1", () => {
    const code = generate(seq(lit("tool"), listCount(path("imgs"), "imgs", 1)));
    expect(code).toContain("Parameter `imgs` must contain at least 1 element");
    expect(code).not.toContain("at least 1 elements");
  });
});

describe("TypeScript validation - unions", () => {
  it("validates discriminated union @type membership and recurses per variant", () => {
    const code = generate(
      seq(
        lit("tool"),
        namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url"))),
      ),
    );
    expect(code).toContain('if (!("@type" in params.source)) {');
    expect(code).toContain("Params object is missing `@type`");
    expect(code).toContain('!["variant_0", "variant_1"].includes(params.source["@type"])');
    expect(code).toContain('switch (params.source["@type"]) {');
    expect(code).toContain('case "variant_0": {');
    expect(code).toContain('case "variant_1": {');
    expect(code).toContain('if (typeof params.source.file !== "string") {');
    expect(code).toContain('if (typeof params.source.url !== "string") {');
  });

  it("validates an enum (all-literal) choice as membership", () => {
    const code = generate(seq(lit("tool"), namedAlt("mode", lit("fast"), lit("slow"))));
    expect(code).toContain('!["fast", "slow"].includes(params.mode)');
    // the message string escapes the inner double quotes
    expect(code).toContain('must be one of [\\"fast\\", \\"slow\\"]');
    expect(code).not.toContain('params.mode["@type"]');
  });

  it("validates a mixed union (struct + bare-literal variants) by runtime shape", () => {
    const code = generate(
      seq(lit("tool"), namedAlt("mode", lit("fast"), seq(lit("--full"), str("level")))),
    );
    // object value -> dispatch struct variants by @type
    expect(code).toContain('if (typeof params.mode === "object" && params.mode !== null) {');
    expect(code).toContain('!["variant_1"].includes(params.mode["@type"])');
    expect(code).toContain('switch (params.mode["@type"]) {');
    expect(code).toContain('case "variant_1": {');
    // bare value -> literal membership
    expect(code).toContain("} else {");
    expect(code).toContain('!["fast"].includes(params.mode)');
  });
});
