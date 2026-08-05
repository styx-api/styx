/**
 * `IMPLEMENTED_METHODS` is the set of argtype methods Styx actually reads, and
 * it is spelled out by hand in `lower.ts` rather than spread from the upstream
 * vocabularies. That is deliberate - see the comment there - but a hand-written
 * mirror of someone else's list goes stale silently, and the failure mode is
 * bad: an annotation the wrapper does not implement stops being reported and
 * simply disappears from the generated API.
 *
 * So this pins the relationship in both directions. It fails when
 * `@argtype/core` adds a method (forcing a decision: implement it, or record it
 * as knowingly unimplemented), and it fails if the hand-written list drifts to
 * include something the language does not define at all.
 */
import { describe, expect, it } from "vitest";
import {
  CONSTRAINT_METHODS,
  CORE_METHODS,
  MEDIA_TYPE_METHODS,
  OUTPUT_METHODS,
  PATH_METHODS,
} from "@argtype/core";
import { IMPLEMENTED_METHODS } from "./lower.js";

/** Vocabularies whose methods Styx lowers into the IR. */
const IMPLEMENTED_VOCABULARIES = [
  CORE_METHODS,
  OUTPUT_METHODS,
  MEDIA_TYPE_METHODS,
  PATH_METHODS,
] as const;

/**
 * Methods the language defines that Styx knowingly does not implement. They
 * must stay *outside* `IMPLEMENTED_METHODS` so `reportUnconsumed` keeps warning
 * about them: the IR cannot express inter-argument constraints.
 */
const KNOWINGLY_UNIMPLEMENTED = CONSTRAINT_METHODS;

describe("IMPLEMENTED_METHODS tracks the upstream vocabularies", () => {
  it("covers every method in the vocabularies Styx implements", () => {
    const upstream = IMPLEMENTED_VOCABULARIES.flatMap((v) => [...v]);
    const missing = upstream.filter((m) => !IMPLEMENTED_METHODS.has(m));
    // A new upstream method landing here is not automatically a bug - but it is
    // automatically a decision, and this is where it gets made.
    expect(missing).toEqual([]);
  });

  it("does not absorb methods Styx cannot represent", () => {
    const absorbed = [...KNOWINGLY_UNIMPLEMENTED].filter((m) => IMPLEMENTED_METHODS.has(m));
    expect(absorbed).toEqual([]);
  });

  it("claims nothing the language does not define", () => {
    const defined = new Set([
      ...IMPLEMENTED_VOCABULARIES.flatMap((v) => [...v]),
      ...KNOWINGLY_UNIMPLEMENTED,
    ]);
    const unknown = [...IMPLEMENTED_METHODS].filter((m) => !defined.has(m));
    expect(unknown).toEqual([]);
  });
});
