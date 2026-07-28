import { describe, expect, it } from "vitest";
import { outputGate } from "../../bindings/index.js";
import { resolveOutputs, solve } from "../../solver/index.js";
import { float, lit, opt, path, seq, seqJoin, str } from "../builders.js";
import type { Expr } from "../node.js";
import { nodeRef, type NodeMeta, type Output } from "../meta.js";
import { defaultPipeline } from "./pipeline.js";
import { flatten } from "./flatten.js";
import { removeEmpty } from "./remove-empty.js";

/**
 * Outputs (`meta.outputs`) surviving optimization is a soundness invariant held
 * by convention across three passes: `simplify` migrates them on collapse,
 * `flatten`'s sequence branch hoists them out of a child it inlines (its
 * alternative branch inlines nothing that has meta at all), and `remove-empty`
 * refuses to drop a node that has meta. A new pass or collapse branch that
 * bypasses these would silently drop outputs (exactly the class of bug that
 * shipped). We check them at the pass and full-pipeline level.
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

/** The direct children of a sequence node (narrowing helper for assertions). */
function children(node: Expr): Expr[] {
  if (node.kind !== "sequence") throw new Error(`expected a sequence, got '${node.kind}'`);
  return node.attrs.nodes;
}

describe("output survival across IR passes", () => {
  it("flatten hoists (rather than drops) the outputs of a child sequence it inlines", () => {
    const inner = seq(str("a"), str("b"));
    inner.meta = { outputs: [out("o")] };
    const result = flatten.apply(seq(lit("cmd"), inner));
    // The child is gone; its outputs landed on the parent, which is now the
    // scope they describe.
    expect(children(result.expr).map((n) => n.kind)).toEqual(["literal", "str", "str"]);
    expect(result.expr.meta?.outputs?.map((o) => o.name)).toEqual(["o"]);
    expect(outputNames(result.expr)).toEqual(["o"]);
  });

  it("flatten appends hoisted outputs after the parent's own, and keeps the parent's other meta", () => {
    const inner = seq(str("a"));
    inner.meta = { outputs: [out("inner")] };
    const parent = seq(lit("cmd"), inner);
    // A union arm: the hoist rewrites `meta`, so everything else on it has to
    // ride along or the arm loses its `@type` discriminator and its name.
    parent.meta = {
      name: "sub",
      variantTag: "SubCmd",
      doc: { title: "Sub" },
      outputs: [out("outer")],
    };
    const result = flatten.apply(parent);
    expect(outputNames(result.expr)).toEqual(["outer", "inner"]);
    expect(result.expr.meta).toMatchObject({
      name: "sub",
      variantTag: "SubCmd",
      doc: { title: "Sub" },
    });
  });

  it("flatten hoists through a chain of nested sequences in one pass", () => {
    const grandchild = seq(str("c"));
    grandchild.meta = { outputs: [out("gc")] };
    const child = seq(str("b"), grandchild);
    child.meta = { outputs: [out("c")] };
    const parent = seq(lit("cmd"), child);
    parent.meta = { outputs: [out("p")] };
    const result = flatten.apply(parent);
    // Children are visited before the merge, so the whole chain collapses in
    // one application, outermost scope's outputs first.
    expect(children(result.expr).map((n) => n.kind)).toEqual(["literal", "str", "str"]);
    expect(outputNames(result.expr)).toEqual(["p", "c", "gc"]);
  });

  it("flatten keeps a child whose join differs, outputs and all", () => {
    // The child renders as one joined argv token; inlining would splice its
    // members into the parent's own (differently joined) rendering.
    const inner = seqJoin(",", str("a"), str("b"));
    inner.meta = { outputs: [out("o")] };
    const result = flatten.apply(seq(lit("cmd"), inner));
    expect(children(result.expr).map((n) => n.kind)).toEqual(["literal", "sequence"]);
    expect(result.expr.meta?.outputs).toBeUndefined();
    expect(outputNames(result.expr)).toEqual(["o"]);
  });

  it("flatten refuses a merge that would collide two bindings of the same name", () => {
    // `dedupeSiblingNames` runs in the frontend, per scope, long before this
    // pass, so it never sees the merged namespace. The solver keys struct
    // fields by name and silently overwrites on a duplicate, which would drop
    // one of the two `dup` parameters and re-point its argv slot at the other.
    const inner = seq(str("dup"), str("b"));
    inner.meta = { outputs: [out("o")] };
    const result = flatten.apply(seq(lit("cmd"), str("dup"), inner));
    expect(children(result.expr).map((n) => n.kind)).toEqual(["literal", "str", "sequence"]);
    expect(outputNames(result.expr)).toEqual(["o"]);
  });

  it("flatten refuses a merge that would re-resolve a hoisted output's ref", () => {
    // A hoisted output's refs resolve against its scope's subtree, which the
    // merge widens. `target` is bound twice in the tree, so widening the search
    // would find the sibling `target` instead of the one the global fallback
    // reached - a different parameter in the output path.
    const inner = seq(str("a"));
    inner.meta = { outputs: [{ name: "o", tokens: [{ kind: "ref", target: nodeRef("target") }] }] };
    const result = flatten.apply(seq(lit("cmd"), str("target"), inner, seq(str("target"))));
    expect(children(result.expr)[2]!.kind).toBe("sequence");
    expect(outputNames(result.expr)).toEqual(["o"]);
  });

  it("flatten merges when a hoisted output's ref names an unambiguous binding", () => {
    // The bet case: `{maskfile}` is bound once in the whole tree, so it resolves
    // to the same binding whether the search is scope-local or the global
    // fallback. Widening the scope changes nothing, so the merge is allowed.
    const inner = seq(str("a"));
    inner.meta = {
      outputs: [{ name: "o", tokens: [{ kind: "ref", target: nodeRef("maskfile") }] }],
    };
    const result = flatten.apply(seq(lit("cmd"), str("maskfile"), inner));
    expect(children(result.expr).map((n) => n.kind)).toEqual(["literal", "str", "str"]);
    expect(result.expr.meta?.outputs?.map((o) => o.name)).toEqual(["o"]);
  });

  it("flatten leaves a MEMBERLESS output-bearing child in place", () => {
    // Inlining zero members gains nothing, and it would move the outputs onto a
    // sequence that is now itself empty - which `remove-empty` then drops out
    // from under the `optional`, taking the outputs with it.
    const bearer = seq();
    bearer.meta = { outputs: [out("o")] };
    const expr = seq(lit("cmd"), opt(seq(bearer)), str("x"));
    expect(outputNames(defaultPipeline.apply(expr).expr)).toEqual(["o"]);
  });

  it("flatten still refuses to inline a child sequence whose meta is not just outputs", () => {
    // `name`, `variantTag`, `doc` and `defaultValue` all belong to the child
    // node itself and have nowhere to land in the parent, so each one keeps the
    // child a distinct node (with its outputs still on it). (`defaultValue` is
    // defensive: argtype warns and strips a `= value` on a seq/set, so no
    // frontend emits a sequence carrying one today.)
    const metas: NodeMeta[] = [
      { name: "grp", outputs: [out("o")] },
      { variantTag: "Grp", outputs: [out("o")] },
      { doc: { title: "Group" }, outputs: [out("o")] },
      { defaultValue: "x", outputs: [out("o")] },
    ];
    for (const meta of metas) {
      const inner = seq(str("a"), str("b"));
      inner.meta = meta;
      const result = flatten.apply(seq(lit("cmd"), inner));
      expect(children(result.expr).map((n) => n.kind)).toEqual(["literal", "sequence"]);
      expect(result.expr.meta?.outputs).toBeUndefined();
      expect(outputNames(result.expr)).toEqual(["o"]);
    }
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

  it("bet's anonymous option set merges into the root scope with its outputs intact", () => {
    // A reduced model of what argtype lowers `bet` to: an anonymous `set(...)`
    // of flags, whose only meta is the outputs its members declared (a member
    // `.output()` bubbles up to its nearest enclosing output scope, which for
    // these is the set). 3 of the fixture's 20 members, plus a `t2_report` the
    // fixture does not declare, to cover a ref to an optional binding. The set
    // is what used to survive as a `BetStruct1` the caller had to construct;
    // flattening it away must keep every output, its scope gate, and its refs.
    const maskfile = str("maskfile");
    const options = seq(
      opt(seq(lit("-f"), float("fractional_intensity"))),
      opt(lit("-m"), "binary_mask_flag"),
      opt(seq(lit("-A2"), path("additional_surfaces_t2"))),
    );
    options.meta = {
      outputs: [
        { name: "binary_mask", tokens: [{ kind: "ref", target: nodeRef("maskfile") }] },
        { name: "t2_report", tokens: [{ kind: "ref", target: nodeRef("additional_surfaces_t2") }] },
      ],
    };
    const expr = seq(lit("bet"), path("infile"), maskfile, options);
    expr.meta = {
      name: "bet",
      doc: { title: "Automated brain extraction tool for FSL" },
      outputs: [{ name: "outfile", tokens: [{ kind: "ref", target: nodeRef("maskfile") }] }],
    };

    const optimized = defaultPipeline.apply(expr).expr;

    // The set is gone: the flags are direct members of the root sequence, and
    // the root kept the name and doc the hoist had to rewrite `meta` around.
    expect(children(optimized).some((n) => n.kind === "sequence")).toBe(false);
    expect(optimized.meta).toMatchObject({
      name: "bet",
      doc: { title: "Automated brain extraction tool for FSL" },
    });

    const solved = solve(optimized);
    const resolution = resolveOutputs(optimized, solved);
    expect(resolution.diagnostics.errors).toEqual([]);

    // One scope now (it was two), holding the root's own output plus the set's.
    expect(resolution.scopes).toHaveLength(1);
    const scope = resolution.scopes[0]!;
    expect(scope.outputs.map((o) => o.name)).toEqual(["outfile", "binary_mask", "t2_report"]);

    // Relocating the outputs did not gate them: the set was an ungated member of
    // an ungated root, so the scope gate is still empty. (Read the binding
    // without a fallback - a missing one would look identical to an empty gate.)
    const scopeBinding = solved.bindings.get(scope.scope);
    expect(scopeBinding).toBeDefined();
    const scopeGate = scopeBinding!.gate;
    expect(scopeGate).toEqual([]);

    // `ref(maskfile)` still resolves - maskfile is now a same-scope sibling of
    // the hoisted outputs rather than a field of the enclosing struct.
    const maskfileBinding = solved.resolve(maskfile)!;
    expect(maskfileBinding.type.kind).toBe("scalar");
    for (const name of ["outfile", "binary_mask"]) {
      const output = scope.outputs.find((o) => o.name === name)!;
      expect(output.tokens[0]).toEqual({ kind: "ref", binding: maskfileBinding.id });
    }

    // A per-output gate still comes from the ref'd binding: the optional
    // `-A2` argument makes `t2_report` conditional on its presence.
    const t2Report = scope.outputs.find((o) => o.name === "t2_report")!;
    const gate = outputGate(scopeGate, t2Report, solved.bindings);
    expect(gate.some((a) => a.kind === "present")).toBe(true);
  });
});
