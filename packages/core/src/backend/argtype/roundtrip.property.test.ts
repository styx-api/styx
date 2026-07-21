/**
 * Property-based round-trip + robustness tests for the argtype backend/frontend.
 *
 * `roundtrip.test.ts` pins the round-trip on a handful of hand-authored
 * fixtures; this file generalizes it with fast-check over randomly generated IR
 * trees, so shrinking hands back a minimal counterexample when an invariant
 * breaks rather than a whole descriptor.
 *
 * Property A (grammar fixed point): emitting a generated IR tree produces
 * argtype source that re-parses with zero errors, and re-emitting the re-parsed
 * tree yields byte-identical source (idempotence). Generation is constrained to
 * valid IR (decorations attached only where the type accepts them; globally
 * unique names so no sibling/arm dedup rewrites a label), because the emitter's
 * contract is "valid IR -> valid source" - feeding it random *text* would only
 * ever produce parse errors and prove nothing.
 *
 * Scope: Property A proves the emitter output is a re-parseable fixed point, NOT
 * that a round-trip preserves the IR structurally - any detail the first emit
 * drops is simply absent from the source the comparison sees. Structural
 * faithfulness (`second.expr toEqual first.expr`) is guarded by the fixture-based
 * `roundtrip.test.ts`; this file complements it with fuzzed breadth over emitter
 * *syntax* paths. To keep that breadth non-vacuous, the generator deliberately
 * reaches paths the plain terminals would miss: wrapper-level defaults that must
 * sink onto an inner terminal (`genFlagValue`), union/list defaults on
 * `alt`/`rep`, path defaults, and one-sided numeric/count bounds.
 *
 * Property B (parser robustness): for an arbitrary string, the parser never
 * throws - it only ever returns a `{ errors, warnings }` result. This guards the
 * lexer/parser against crashing on adversarial input.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { alt, float, int, lit, opt, path, rep, seq, str } from "../../ir/builders.js";
import type { Expr } from "../../ir/node.js";
import { ArgtypeParser } from "../../frontend/argtype/parser-frontend.js";
import { generateArgtype } from "./emit.js";

const parser = new ArgtypeParser();

// -- IR generators ----------------------------------------------------------
//
// Each terminal/combinator arbitrary attaches only decorations its node kind
// accepts, and orders numeric/count bounds so no inverted-bounds warning fires.
// Names are attached as a `"_"` marker and rewritten to globally-unique idents
// in a post-pass (see `uniquify`), so the frontend never has to dedupe a
// duplicate sibling or alt-arm label (which would rewrite a name and break
// idempotence).
//
// The `.map(...)` mappers mutate their nodes in place (`maybeName`, `uniquify`).
// This is safe ONLY because every node is freshly constructed per sample via a
// builder call (`int()`, `seq(...)`, ...) inside the mapper, so no node instance
// is aliased across positions or shrink re-runs. Do not hoist a constant subtree
// out of a mapper: a shared node instance would let one mutation corrupt
// siblings and could produce false passes.

const NAME_MARKER = "_";
const LITERALS = ["-a", "-b", "--flag", "-o", "sub", "run", "="];

/** Attach a name marker to roughly half the nodes; `uniquify` makes them unique. */
function maybeName<T extends Expr>(named: boolean): (node: T) => T {
  return (node) => {
    if (named) node.meta = { ...(node.meta ?? {}), name: NAME_MARKER };
    return node;
  };
}

const genLiteral: fc.Arbitrary<Expr> = fc.constantFrom(...LITERALS).map((s) => lit(s));

/** Independent optional min/max, so the emitter's min-only, max-only, both, and
 * neither branches (emit.ts) all get exercised - not just "both or neither".
 * Swapped when inverted so no inverted-bounds warning muddies the round-trip. */
const genBounds = fc
  .record({
    min: fc.option(fc.integer({ min: -50, max: 50 }), { nil: undefined }),
    max: fc.option(fc.integer({ min: -50, max: 50 }), { nil: undefined }),
  })
  .map(({ min, max }) =>
    min !== undefined && max !== undefined && min > max ? { min: max, max: min } : { min, max },
  );

function numTerminal(make: () => Expr): fc.Arbitrary<Expr> {
  return fc
    .record({
      named: fc.boolean(),
      bounds: genBounds,
      def: fc.option(fc.integer({ min: -50, max: 150 }), { nil: undefined }),
    })
    .map(({ named, bounds, def }) => {
      const node = make();
      if (node.kind === "int" || node.kind === "float") {
        if (bounds.min !== undefined) node.attrs.minValue = bounds.min;
        if (bounds.max !== undefined) node.attrs.maxValue = bounds.max;
      }
      if (def !== undefined) node.meta = { ...(node.meta ?? {}), defaultValue: def };
      return maybeName<Expr>(named)(node);
    });
}

const genInt: fc.Arbitrary<Expr> = numTerminal(() => int());
const genFloat: fc.Arbitrary<Expr> = numTerminal(() => float());

const genStr: fc.Arbitrary<Expr> = fc
  .record({
    named: fc.boolean(),
    def: fc.option(fc.constantFrom("origin", "main", "png", "auto"), { nil: undefined }),
  })
  .map(({ named, def }) => {
    const node = str();
    if (def !== undefined) node.meta = { ...(node.meta ?? {}), defaultValue: def };
    return maybeName<Expr>(named)(node);
  });

const genPath: fc.Arbitrary<Expr> = fc
  .record({
    named: fc.boolean(),
    mutable: fc.boolean(),
    resolveParent: fc.boolean(),
    media: fc.option(fc.constantFrom("image/png", "application/json", "text/plain"), {
      nil: undefined,
    }),
    def: fc.option(fc.constantFrom("out.nii", "result.txt"), { nil: undefined }),
  })
  .map(({ named, mutable, resolveParent, media, def }) => {
    const node = path();
    if (mutable) node.attrs.mutable = true;
    if (resolveParent) node.attrs.resolveParent = true;
    if (media) node.attrs.mediaTypes = [media];
    // A path default emits as `= "x"` bare or `.default("x")` after a chain,
    // exercising both `defaultSuffix` branches on a path terminal.
    if (def !== undefined) node.meta = { ...(node.meta ?? {}), defaultValue: def };
    return maybeName<Expr>(named)(node);
  });

const genTerminal: fc.Arbitrary<Expr> = fc.oneof(genInt, genFloat, genStr, genPath, genLiteral);

/** A recursive expression arbitrary bounded by `depth`; at depth 0 only
 * terminals are produced. Structural nodes recurse with `depth - 1`. */
function genExpr(depth: number): fc.Arbitrary<Expr> {
  if (depth <= 0) return genTerminal;
  const child = () => genExpr(depth - 1);
  const genSeq = fc
    .record({
      named: fc.boolean(),
      nodes: fc.array(child(), { minLength: 1, maxLength: 4 }),
      join: fc.option(fc.constantFrom("", ",", ":"), { nil: undefined }),
    })
    .map(({ named, nodes, join }) => {
      const node = seq(...nodes);
      if (join !== undefined) node.attrs.join = join;
      return maybeName<Expr>(named)(node);
    });
  const genOpt = fc
    .record({ named: fc.boolean(), inner: child() })
    .map(({ named, inner }) => maybeName<Expr>(named)(opt(inner)));
  // The `opt("-f", value)` flag-value shape carrying a wrapper-level default is
  // exactly what `sinkDefaults`/`findValueTerminal` (emit.ts) exist for: a
  // Boutiques/argparse-shaped IR hoists the default onto the outer optional, and
  // the emitter must relocate it onto the inner value terminal (`-f x = 5`). The
  // plain terminal generators never place a default on a wrapper, so without
  // this the whole default-sinking path is dead.
  const genFlagValue = fc
    .record({
      named: fc.boolean(),
      flag: fc.constantFrom(...LITERALS),
      def: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
    })
    .map(({ named, flag, def }) => {
      const node = opt(seq(lit(flag), int()));
      if (def !== undefined) node.meta = { ...(node.meta ?? {}), defaultValue: def };
      return maybeName<Expr>(named)(node);
    });
  const genRep = fc
    .record({
      named: fc.boolean(),
      inner: child(),
      join: fc.option(fc.constantFrom("", ",", ":"), { nil: undefined }),
      // Independent optional bounds so countMin-only / countMax-only / both /
      // neither each get emitted (`.count()` vs `.countMin()`/`.countMax()`).
      counts: fc
        .record({
          min: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
          max: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
        })
        .map(({ min, max }) =>
          min !== undefined && max !== undefined && min > max
            ? { min: max, max: min }
            : { min, max },
        ),
      def: fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined }),
    })
    .map(({ named, inner, join, counts, def }) => {
      const node = rep(inner);
      if (join !== undefined) node.attrs.join = join;
      if (counts.min !== undefined) node.attrs.countMin = counts.min;
      if (counts.max !== undefined) node.attrs.countMax = counts.max;
      // A list-level default rides on the repeat node itself (kept, not sunk).
      if (def !== undefined) node.meta = { ...(node.meta ?? {}), defaultValue: def };
      return maybeName<Expr>(named)(node);
    });
  const genAlt = fc
    .record({
      named: fc.boolean(),
      alts: fc.array(child(), { minLength: 2, maxLength: 4 }),
      // A union default variant (`alt(...).default("x")`) - the emit path the
      // fsl-flirt fixture pins, exercised here over random arms too.
      def: fc.option(fc.constantFrom("run", "auto"), { nil: undefined }),
    })
    .map(({ named, alts, def }) => {
      const node = alt(...alts);
      if (def !== undefined) node.meta = { ...(node.meta ?? {}), defaultValue: def };
      return maybeName<Expr>(named)(node);
    });
  return fc.oneof(
    { weight: 2, arbitrary: genTerminal },
    { weight: 1, arbitrary: genSeq },
    { weight: 1, arbitrary: genOpt },
    { weight: 1, arbitrary: genFlagValue },
    { weight: 1, arbitrary: genRep },
    { weight: 1, arbitrary: genAlt },
  );
}

/** Rewrite every named node's placeholder marker to a globally-unique
 * identifier so the frontend never dedupes a sibling/arm label on re-parse. */
function uniquify(root: Expr): Expr {
  let counter = 0;
  const walk = (node: Expr): void => {
    if (node.meta?.name === NAME_MARKER) {
      node.meta = { ...node.meta, name: `n${counter++}` };
    }
    switch (node.kind) {
      case "sequence":
        node.attrs.nodes.forEach(walk);
        break;
      case "optional":
      case "repeat":
        walk(node.attrs.node);
        break;
      case "alternative":
        node.attrs.alts.forEach(walk);
        break;
    }
  };
  walk(root);
  return root;
}

/** Root is always a sequence (the common tool shape) with unique names. */
const genRoot: fc.Arbitrary<Expr> = fc
  .array(genExpr(3), { minLength: 1, maxLength: 5 })
  .map((nodes) => uniquify(seq(...nodes)));

describe("argtype backend property: round-trip", () => {
  it("Property A: emit -> parse (no errors) -> emit is idempotent", () => {
    fc.assert(
      fc.property(genRoot, (expr) => {
        const first = generateArgtype(expr);
        const parsed = parser.parse(first.source);
        expect(parsed.errors, `re-parse errors for:\n${first.source}`).toEqual([]);
        const second = generateArgtype(parsed.expr, parsed.meta);
        expect(second.source, `not idempotent for:\n${first.source}`).toBe(first.source);
      }),
      { numRuns: 400 },
    );
  });
});

describe("argtype frontend property: parser robustness", () => {
  // The real "never throws" guard is fast-check itself: a thrown exception from
  // `parser.parse` propagates out of the property callback and is reported as a
  // counterexample regardless of any assertion. The `Array.isArray` checks below
  // additionally pin the shape of the returned contract on every input.
  it("Property B: parse never throws on an arbitrary string", () => {
    fc.assert(
      fc.property(fc.string(), (src) => {
        const result = parser.parse(src);
        // The contract is a result object, never an exception.
        expect(Array.isArray(result.errors)).toBe(true);
        expect(Array.isArray(result.warnings)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("Property B: parse never throws on structured near-argtype fragments", () => {
    // Bias toward argtype-shaped tokens so the fuzzer explores lexer/parser
    // paths a purely random string rarely reaches.
    const token = fc.constantFrom(
      "seq(",
      "opt(",
      "alt(",
      "rep(",
      "path",
      "int",
      ".join(",
      ".min(",
      "`{",
      "}`",
      '"x"',
      ":",
      ",",
      ")",
      "|",
      "=",
      "---",
      "\n",
    );
    fc.assert(
      fc.property(
        fc.array(token, { maxLength: 30 }).map((ts) => ts.join("")),
        (src) => {
          const result = parser.parse(src);
          expect(Array.isArray(result.errors)).toBe(true);
          expect(Array.isArray(result.warnings)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
