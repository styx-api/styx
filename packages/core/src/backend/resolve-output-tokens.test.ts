import { describe, expect, it } from "vitest";
import type { Binding, BindingRegistry, GateAtom, ResolvedOutput } from "../bindings/index.js";
import { outputGate } from "./resolve-output-tokens.js";

function bind(id: string, gate: GateAtom[] = []): Binding {
  return {
    id,
    node: { kind: "str", attrs: {} },
    name: id,
    type: { kind: "scalar", scalar: "str" },
    gate,
    access: [],
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
