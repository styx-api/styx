import { describe, expect, it } from "vitest";
import { alt, lit, seq, str } from "../builders.js";
import type { Alternative } from "../node.js";
import { canonicalize } from "./canonicalize.js";

describe("canonicalize", () => {
  it("deduplicates structurally identical alternatives", () => {
    const result = canonicalize.apply(alt(lit("x"), lit("x"), lit("y")));
    expect(result.expr.kind).toBe("alternative");
    const alts = (result.expr as Alternative).attrs.alts;
    expect(alts.map((a) => (a.kind === "literal" ? a.attrs.str : a.kind))).toEqual(["x", "y"]);
  });

  it("does not merge arms that share a shape but differ by variant tag", () => {
    // Two sub-commands with the same inner shape but distinct @type tags: merging
    // them would drop a variant and make it unreachable.
    const a = seq(str("field"));
    a.meta = { variantTag: "VariousString" };
    const b = seq(str("field"));
    b.meta = { variantTag: "VariousFile" };

    const result = canonicalize.apply(alt(a, b));
    expect(result.expr.kind).toBe("alternative");
    const tags = (result.expr as Alternative).attrs.alts.map((n) => n.meta?.variantTag).sort();
    expect(tags).toEqual(["VariousFile", "VariousString"]);
  });
});
