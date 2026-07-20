import { describe, expect, it } from "vitest";
import { lit, opt, seq, str } from "../builders.js";
import type { Expr } from "../node.js";
import type { Output } from "../meta.js";
import { defaultPipeline } from "./pipeline.js";
import { flatten } from "./flatten.js";
import { removeEmpty } from "./remove-empty.js";

/**
 * Outputs (`meta.outputs`) surviving optimization is a soundness invariant held
 * by convention across three passes: `simplify` migrates them on collapse,
 * `flatten` refuses to inline a child that has meta, and `remove-empty` refuses
 * to drop a node that has meta. A new pass or collapse branch that bypasses
 * these would silently drop outputs (exactly the class of bug that shipped). We
 * check them at the pass and full-pipeline level.
 */

function out(name: string): Output {
  return { name, tokens: [{ kind: "literal", value: `${name}.txt` }] };
}

/** All output names attached anywhere in the tree, in walk order. */
function outputNames(node: Expr): string[] {
  const acc: string[] = [];
  const walk = (n: Expr): void => {
    for (const o of n.meta?.outputs ?? []) acc.push(o.name ?? "<unnamed>");
    const a = n.attrs as { nodes?: Expr[]; node?: Expr; alts?: Expr[] };
    a.nodes?.forEach(walk);
    if (a.node) walk(a.node);
    a.alts?.forEach(walk);
  };
  walk(node);
  return acc;
}

describe("output survival across IR passes", () => {
  it("flatten does not inline (and thus drop) an output-bearing child sequence", () => {
    const inner = seq(str("a"), str("b"));
    inner.meta = { outputs: [out("o")] };
    const result = flatten.apply(seq(lit("cmd"), inner));
    expect(outputNames(result.expr)).toEqual(["o"]);
  });

  it("remove-empty keeps an EMPTY output-bearing node (only the meta-guard saves it)", () => {
    // The node must be genuinely empty (no children) so that only remove-empty's
    // `if (node.meta) return false` guard prevents its removal - a non-empty node
    // is kept regardless, which would make this a tautology. This is the shape a
    // parameterless output scope reduces to.
    const bearer = seq();
    bearer.meta = { outputs: [out("o")] };
    const result = removeEmpty.apply(seq(lit("cmd"), bearer));
    expect(outputNames(result.expr)).toEqual(["o"]);
  });

  it("defaultPipeline preserves an output when its wrapper collapses", () => {
    // opt(opt(str)) collapses; the outputs on the outer wrapper must migrate down.
    const e = opt(opt(str("x")));
    e.meta = { outputs: [out("o")] };
    const result = defaultPipeline.apply(e);
    expect(outputNames(result.expr)).toEqual(["o"]);
  });

  // (The list-subcommand IR shape `rep(seq{outputs}(...))` is a pipeline identity
  // - no pass transforms it - so a pass-level test here would have no teeth. That
  // invariant is exercised end-to-end, with teeth, by the "subcommand-LIST" case
  // in backend/boutiques/subcommand-outputs.test.ts.)
});
