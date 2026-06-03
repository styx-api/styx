import { describe, expect, it } from "vitest";
import { alt, lit, opt, path, seq, str } from "../ir/builders.js";
import { solve } from "./solver.js";

describe("solver union @type tags", () => {
  it("derives the variant tag from variantTag, surviving a single-field collapse", () => {
    // The mrcalc shape: two distinct sub-commands (VariousString / VariousFile)
    // each collapse onto a single inner field both named "obj". Using `name`
    // alone would tag both `obj` (the second arm unreachable at runtime);
    // `variantTag` carries the sub-command id through the collapse so the tags
    // stay distinct and both arms are reachable.
    const asStr = str({ name: "obj", variantTag: "VariousString" });
    const asFile = path({ name: "obj", variantTag: "VariousFile" });
    const altNode = alt(asStr, asFile);
    const expr = seq(lit("tool"), altNode);
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    const u = resolve(altNode);
    expect(u?.type.kind).toBe("union");
    const tags = u?.type.kind === "union" ? u.type.variants.map((v) => v.name) : [];
    expect(tags).toEqual(["VariousString", "VariousFile"]);
  });

  it("falls back to name when no variantTag is present", () => {
    const a = seq(lit("--file"), path("file"));
    a.meta = { name: "fromFile" };
    const b = seq(lit("--url"), str("url"));
    b.meta = { name: "fromUrl" };
    const altNode = alt(a, b);
    const expr = seq(lit("tool"), altNode);
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    const u = resolve(altNode);
    const tags = u?.type.kind === "union" ? u.type.variants.map((v) => v.name) : [];
    expect(tags).toEqual(["fromFile", "fromUrl"]);
  });
});

describe("solver root-binding fixup", () => {
  it("wraps a single collapsed field in a root struct", () => {
    // seq(lit, scalar) collapses to the scalar; the fixup must still produce a
    // root struct so backends emit a params interface with the field.
    const expr = seq(lit("bet"), str("input"));
    expr.meta = { name: "bet" };
    const { resolve } = solve(expr);
    const root = resolve(expr);
    expect(root?.type.kind).toBe("struct");
    expect(root?.type.kind === "struct" && Object.keys(root.type.fields)).toEqual(["input"]);
  });

  it("recovers a field buried in a collapsed inner sequence (is-surface shape)", () => {
    // A single-input tool whose input carries a command-line-flag parses to
    // seq(lit, seq(lit, scalar)). When the inner sequence carries a `meta.doc`
    // (but no name), flatten preserves it nested; it then collapses to the
    // scalar, leaving the binding buried one level down. The root fixup must
    // still find it (by recursing through the collapsed sequence) so the params
    // interface gets the `infile` field that cargs references as `params.infile`.
    const infileNode = path("infile");
    const inner = seq(lit("-surface"), infileNode);
    inner.meta = { doc: { title: "Input file", description: "Input to check." } };
    const expr = seq(lit("is-surface"), inner);
    expr.meta = { name: "is-surface" };
    const { resolve } = solve(expr);
    const root = resolve(expr);
    expect(root?.type.kind).toBe("struct");
    expect(root?.type.kind === "struct" && Object.keys(root.type.fields)).toEqual(["infile"]);
    // The struct field name must equal the binding's access-path field, so the
    // emitted interface field matches `params.infile` in cargs.
    const infile = resolve(infileNode);
    expect(infile?.name).toBe("infile");
    expect(infile?.access).toEqual([{ kind: "field", name: "infile" }]);
  });

  it("keeps a single-optional-field sequence as a struct (does not collapse)", () => {
    // An option with no value of its own but a nested sub-flag, e.g.
    // `-whole-file [-demean]`: opt(seq[whole_file](lit, opt[demean](lit))).
    // The flag can be present while the sub-flag is absent, so collapsing the
    // single field would conflate the two optional states and drop `demean`.
    // The sequence must stay a struct so `demean` is addressable as
    // `params.whole_file.demean` (not promoted to a non-existent root field).
    const demean = opt(lit("-demean"), { name: "demean" });
    const inner = seq(lit("-whole-file"), demean);
    inner.meta = { name: "whole_file" };
    const expr = seq(lit("tool"), opt(inner));
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);

    const struct = resolve(inner);
    expect(struct?.type.kind).toBe("struct");
    expect(struct?.type.kind === "struct" && Object.keys(struct.type.fields)).toEqual(["demean"]);

    const demeanBinding = resolve(demean);
    expect(demeanBinding?.access).toEqual([
      { kind: "field", name: "whole_file" },
      { kind: "field", name: "demean" },
    ]);
  });

  it("still collapses a single required-value field (-x <val> shape)", () => {
    // The collapse exception is narrow: a required scalar field stays collapsed,
    // so `-x <val>` reads as one optional value, not a struct wrapper.
    const val = str("val");
    const inner = seq(lit("-x"), val);
    inner.meta = { name: "x" };
    const expr = seq(lit("tool"), opt(inner));
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    // The inner sequence collapsed - no struct binding registered for it.
    expect(resolve(inner)).toBeUndefined();
    expect(resolve(val)?.access).toEqual([{ kind: "field", name: "x" }]);
  });

  it("emits an empty root struct for a no-input tool", () => {
    const expr = seq(lit("tool"));
    expr.meta = { name: "tool" };
    const { resolve } = solve(expr);
    const root = resolve(expr);
    expect(root?.type.kind).toBe("struct");
    expect(root?.type.kind === "struct" && Object.keys(root.type.fields)).toEqual([]);
  });
});
