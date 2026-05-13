import { describe, expect, it } from "vitest";
import type { ResolvedOutput, ResolvedToken } from "../bindings/index.js";
import {
  compactTokens,
  outputCardinality,
  outputGuard,
  planOutput,
} from "./resolve-output-tokens.js";

function output(overrides: Partial<ResolvedOutput> = {}): ResolvedOutput {
  return {
    name: "out",
    tokens: [],
    branchCondition: [[]],
    listScope: [],
    optional: false,
    ...overrides,
  };
}

describe("outputCardinality", () => {
  it("returns 'always' when not optional and no listScope", () => {
    expect(outputCardinality(output())).toBe("always");
  });

  it("returns 'optional' when optional and no listScope", () => {
    expect(outputCardinality(output({ optional: true }))).toBe("optional");
  });

  it("returns 'list' when listScope present and not optional", () => {
    expect(outputCardinality(output({ listScope: ["b1"] }))).toBe("list");
  });

  it("returns 'list-optional' when both listScope and optional", () => {
    expect(outputCardinality(output({ listScope: ["b1"], optional: true }))).toBe(
      "list-optional",
    );
  });
});

describe("outputGuard", () => {
  it("returns 'always' for empty branchCondition", () => {
    expect(outputGuard(output({ branchCondition: [] }))).toEqual({ kind: "always" });
  });

  it("returns 'always' for single empty path", () => {
    expect(outputGuard(output({ branchCondition: [[]] }))).toEqual({ kind: "always" });
  });

  it("returns 'any-of' for non-empty branchCondition", () => {
    const guard = outputGuard(
      output({
        branchCondition: [
          [{ kind: "present", binding: "b1" }],
          [
            { kind: "present", binding: "b2" },
            { kind: "variant", binding: "u1", variant: "add" },
          ],
        ],
      }),
    );
    expect(guard).toEqual({
      kind: "any-of",
      clauses: [
        { atoms: [{ kind: "present", binding: "b1" }] },
        {
          atoms: [
            { kind: "present", binding: "b2" },
            { kind: "variant", binding: "u1", variant: "add" },
          ],
        },
      ],
    });
  });

  it("does NOT collapse a single non-empty path", () => {
    const guard = outputGuard(output({ branchCondition: [[{ kind: "present", binding: "b1" }]] }));
    expect(guard).toEqual({
      kind: "any-of",
      clauses: [{ atoms: [{ kind: "present", binding: "b1" }] }],
    });
  });
});

describe("compactTokens", () => {
  it("merges consecutive literal tokens", () => {
    const tokens: ResolvedToken[] = [
      { kind: "literal", value: "a" },
      { kind: "literal", value: "b" },
      { kind: "literal", value: "c" },
    ];
    expect(compactTokens(tokens)).toEqual([{ kind: "literal", value: "abc" }]);
  });

  it("preserves refs and merges literals around them", () => {
    const tokens: ResolvedToken[] = [
      { kind: "literal", value: "pre-" },
      { kind: "literal", value: "fix" },
      { kind: "ref", binding: "b1" },
      { kind: "literal", value: ".out" },
    ];
    expect(compactTokens(tokens)).toEqual([
      { kind: "literal", value: "pre-fix" },
      { kind: "ref", binding: "b1" },
      { kind: "literal", value: ".out" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(compactTokens([])).toEqual([]);
  });
});

describe("planOutput", () => {
  it("packages cardinality, guard, listScope, and compacted tokens", () => {
    const resolved = output({
      name: "log",
      tokens: [
        { kind: "literal", value: "log-" },
        { kind: "literal", value: "file" },
        { kind: "ref", binding: "b1" },
      ],
      branchCondition: [[{ kind: "present", binding: "b2" }]],
      listScope: ["b3"],
      optional: true,
    });
    const plan = planOutput(resolved);
    expect(plan.name).toBe("log");
    expect(plan.cardinality).toBe("list-optional");
    expect(plan.guard).toEqual({
      kind: "any-of",
      clauses: [{ atoms: [{ kind: "present", binding: "b2" }] }],
    });
    expect(plan.listScope).toEqual(["b3"]);
    expect(plan.tokens).toEqual([
      { kind: "literal", value: "log-file" },
      { kind: "ref", binding: "b1" },
    ]);
    expect(plan.resolved).toBe(resolved);
  });

  it("preserves ref token's stripExtensions and fallback through compacting", () => {
    const resolved = output({
      tokens: [
        { kind: "ref", binding: "b1", stripExtensions: [".nii"], fallback: "x" },
      ],
    });
    const plan = planOutput(resolved);
    expect(plan.tokens[0]).toEqual({
      kind: "ref",
      binding: "b1",
      stripExtensions: [".nii"],
      fallback: "x",
    });
  });
});
