import { describe, expect, it } from "vitest";
import type {
  Binding,
  BindingRegistry,
  GateAtom,
  ResolvedOutput,
  ResolvedToken,
} from "../bindings/index.js";
import {
  compactTokens,
  isGated,
  isIterated,
  outputGate,
  planOutput,
} from "./resolve-output-tokens.js";

function bind(id: string, gate: GateAtom[] = []): Binding {
  return {
    id,
    node: { kind: "str", attrs: {} },
    name: id,
    type: { kind: "scalar", scalar: "str" },
    gate,
  };
}

function registry(bindings: Binding[]): BindingRegistry {
  const map = new Map<string, Binding>();
  for (const b of bindings) map.set(b.id, b);
  return map;
}

function output(overrides: Partial<ResolvedOutput> = {}): ResolvedOutput {
  return { name: "out", tokens: [], ...overrides };
}

describe("outputGate", () => {
  it("returns just the scope gate when there are no refs", () => {
    const scopeGate: GateAtom[] = [{ kind: "present", binding: "scope1" }];
    expect(outputGate(scopeGate, output(), registry([]))).toEqual(scopeGate);
  });

  it("concatenates scope gate with each ref's binding gate", () => {
    const b1 = bind("b1", [{ kind: "present", binding: "b1" }]);
    const reg = registry([b1]);
    const gate = outputGate(
      [{ kind: "variant", binding: "u1", variant: "alpha" }],
      output({ tokens: [{ kind: "ref", binding: "b1" }] }),
      reg,
    );
    expect(gate).toEqual([
      { kind: "variant", binding: "u1", variant: "alpha" },
      { kind: "present", binding: "b1" },
    ]);
  });

  it("dedupes atoms by binding+kind across scope and refs", () => {
    const shared: GateAtom = { kind: "present", binding: "shared" };
    const b1 = bind("b1", [shared]);
    const b2 = bind("b2", [shared, { kind: "iter", binding: "i1" }]);
    const reg = registry([b1, b2]);
    const gate = outputGate(
      [shared],
      output({
        tokens: [
          { kind: "ref", binding: "b1" },
          { kind: "ref", binding: "b2" },
        ],
      }),
      reg,
    );
    expect(gate).toEqual([shared, { kind: "iter", binding: "i1" }]);
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
});

describe("planOutput", () => {
  it("packages name, gate, and compacted tokens", () => {
    const b1 = bind("b1", [{ kind: "present", binding: "b1" }]);
    const reg = registry([b1]);
    const resolved = output({
      name: "log",
      tokens: [
        { kind: "literal", value: "log-" },
        { kind: "literal", value: "file" },
        { kind: "ref", binding: "b1" },
      ],
    });
    const plan = planOutput([], resolved, reg);
    expect(plan.name).toBe("log");
    expect(plan.gate).toEqual([{ kind: "present", binding: "b1" }]);
    expect(plan.tokens).toEqual([
      { kind: "literal", value: "log-file" },
      { kind: "ref", binding: "b1" },
    ]);
    expect(plan.resolved).toBe(resolved);
  });

  it("preserves ref token's stripExtensions and fallback through compacting", () => {
    const reg = registry([bind("b1")]);
    const resolved = output({
      tokens: [{ kind: "ref", binding: "b1", stripExtensions: [".nii"], fallback: "x" }],
    });
    const plan = planOutput([], resolved, reg);
    expect(plan.tokens[0]).toEqual({
      kind: "ref",
      binding: "b1",
      stripExtensions: [".nii"],
      fallback: "x",
    });
  });
});

describe("isGated / isIterated", () => {
  it("isGated true when present or variant atom is present", () => {
    const b1 = bind("b1", [{ kind: "present", binding: "b1" }]);
    const reg = registry([b1]);
    const plan = planOutput([], output({ tokens: [{ kind: "ref", binding: "b1" }] }), reg);
    expect(isGated(plan)).toBe(true);
    expect(isIterated(plan)).toBe(false);
  });

  it("isIterated true when iter atom is present, isGated false if no present/variant", () => {
    const b1 = bind("b1", [{ kind: "iter", binding: "list1" }]);
    const reg = registry([b1]);
    const plan = planOutput([], output({ tokens: [{ kind: "ref", binding: "b1" }] }), reg);
    expect(isIterated(plan)).toBe(true);
    expect(isGated(plan)).toBe(false);
  });
});
