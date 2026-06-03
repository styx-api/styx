import { describe, expect, it } from "vitest";
import type { BoundType } from "../bindings/index.js";
import { structVariants } from "./union-variants.js";

const struct = (): BoundType => ({ kind: "struct", fields: {} });
const union = (
  ...variants: { name?: string; type: BoundType }[]
): Extract<BoundType, { kind: "union" }> => ({ kind: "union", variants });

describe("structVariants", () => {
  it("returns every struct variant with its index when tags are distinct", () => {
    const u = union(
      { name: "a", type: struct() },
      { name: "b", type: struct() },
      { name: "c", type: struct() },
    );
    expect(structVariants(u).map((r) => ({ name: r.variant.name, i: r.i }))).toEqual([
      { name: "a", i: 0 },
      { name: "b", i: 1 },
      { name: "c", i: 2 },
    ]);
  });

  it("skips non-struct (literal) variants, keeping struct indices", () => {
    const u = union(
      { name: "fast", type: { kind: "literal", value: "fast" } },
      { name: "full", type: struct() },
    );
    expect(structVariants(u)).toEqual([{ variant: { name: "full", type: struct() }, i: 1 }]);
  });

  it("throws on a duplicate-tagged struct variant (a malformed discriminated union)", () => {
    // A duplicate `@type` is unreachable at runtime and a mypy comparison-overlap.
    // Frontends must dodge duplicates before codegen; the backend rejects any
    // that slip through rather than silently emitting a dead branch.
    const u = union(
      { name: "orient", type: struct() },
      { name: "origin", type: struct() },
      { name: "orient", type: struct() },
    );
    expect(() => structVariants(u)).toThrow(/duplicate union variant @type "orient"/);
  });
});
