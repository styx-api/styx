/**
 * Golden diagnostics: pin the exact message text AND source location of every
 * malformed / lossy input the argtype frontend reports on.
 *
 * `spec.test.ts` asserts diagnostic *behavior* with regexes ("some error
 * matches /only supported on int\/float/"); this file is the exact-text
 * complement. Diagnostic message and location quality is a thing we keep
 * actively improving (source-located lowering errors, did-you-mean hints,
 * quote-the-digit-led-name fix), and a regex can't tell a sharpened message
 * from a garbled one. Each snapshot renders `kind + line:column + message` so a
 * reworded message, a moved location, or a lost hint all show up as a diff.
 *
 * To (re)generate the inline snapshots after an intentional diagnostic change,
 * run: `npx vitest -u packages/core/src/frontend/argtype/diagnostics.golden`
 * and review that the captured text is *good* (sharp, correctly located), not
 * merely whatever the parser happened to emit.
 */

import { describe, expect, it } from "vitest";
import { ArgtypeParser } from "./parser-frontend.js";

const parser = new ArgtypeParser();

interface Diag {
  message: string;
  location?: { line?: number; column?: number };
}

/**
 * Parse `src` and render its diagnostics as a string array: `[error]`/
 * `[warning]`, then `line:column` (or `?:?` when the diagnostic carries no
 * location), then the message. Errors precede warnings; within each group the
 * frontend's own emission order is preserved (not re-sorted), so snapshot
 * stability rides on the parser's deterministic single-pass collection - if
 * diagnostic gathering ever became order-nondeterministic, a defensive sort
 * would belong here.
 */
function snap(src: string): string[] {
  const { errors, warnings } = parser.parse(src);
  const render = (kind: string) => (d: Diag) => {
    const loc =
      d.location?.line !== undefined ? `${d.location.line}:${d.location.column ?? "?"}` : "?:?";
    return `[${kind}] ${loc} ${d.message}`;
  };
  return [...errors.map(render("error")), ...warnings.map(render("warning"))];
}

describe("argtype golden diagnostics: misapplied modifiers", () => {
  it("`.join()` on a terminal (path)", () => {
    expect(snap(`tool: seq(x: path.join(","))`)).toMatchInlineSnapshot(`
      [
        "[error] 1:14 \`.join()\` is only supported on seq/set/rep/opt",
      ]
    `);
  });

  it("`.join()` on an alt combinator", () => {
    expect(snap(`tool: seq(x: alt("a", "b").join(","))`)).toMatchInlineSnapshot(`
      [
        "[error] 1:14 \`.join()\` is only supported on seq/set/rep/opt",
      ]
    `);
  });

  it("`.min()` on a str", () => {
    expect(snap(`tool: seq(x: str.min(1))`)).toMatchInlineSnapshot(`
      [
        "[error] 1:14 \`.min()\`/\`.max()\` is only supported on int/float terminals",
      ]
    `);
  });

  it("`.count()` on a non-rep (str)", () => {
    expect(snap(`tool: seq(x: str.count(3))`)).toMatchInlineSnapshot(`
      [
        "[error] 1:14 \`.count()\`/\`.countMin()\`/\`.countMax()\` is only supported on rep",
      ]
    `);
  });

  it("`.mediaType()` on a str", () => {
    expect(snap(`tool: seq(x: str.mediaType("text/plain"))`)).toMatchInlineSnapshot(`
      [
        "[error] 1:14 \`.mediaType()\` is only supported on path",
      ]
    `);
  });

  it("`.mutable()` on a non-path (str)", () => {
    expect(snap(`tool: seq(x: str.mutable())`)).toMatchInlineSnapshot(`
      [
        "[error] 1:14 \`.mutable()\`/\`.resolveParent()\` is only supported on path",
      ]
    `);
  });
});

describe("argtype golden diagnostics: unclaimed methods", () => {
  it("a misspelled method reads exactly like an unimplemented extension one", () => {
    // No typo detection: after the extension split, no layer knows the whole
    // universe of method names, so "did you mean" would have to guess against a
    // list that is deliberately open. Both cases get the same honest report.
    expect(snap(`tool: seq(x: int.mim(1))`)).toMatchInlineSnapshot(`
      [
        "[warning] 1:17 argtype method '.mim()' has no Styx IR representation; ignored",
      ]
    `);
  });

  it("a draft-extension method is preserved and reported once", () => {
    // `.conflicts()` is a draft `constraints` method. Styx does not implement
    // that extension, so the parser preserves it and only `lower.ts` reports
    // that the IR cannot carry it.
    expect(snap(`tool: seq(a: opt("-a"), b: opt("-b").conflicts("a"))`)).toMatchInlineSnapshot(`
      [
        "[warning] 1:37 argtype method '.conflicts()' has no Styx IR representation; ignored",
      ]
    `);
  });

  it("an unknown output-template method warns, because it is genuinely dropped", () => {
    expect(
      snap(`---
extensions:
  - outputs
---
tool: seq(x: path).output(o: \`{x}.nii\`.tilte("T"))`),
    ).toMatchInlineSnapshot(`
      [
        "[warning] 5:39 Ignoring unknown output-template method '.tilte()'",
      ]
    `);
  });
});

describe("argtype golden diagnostics: dropped / inert values", () => {
  it("`= value` default on a seq/set struct is dropped", () => {
    expect(snap(`tool: seq(grp: seq(a: int, b: int) = 9)`)).toMatchInlineSnapshot(`
      [
        "[warning] 1:16 \`= value\` / \`.default()\` is not supported on a seq/set struct; ignored",
      ]
    `);
  });

  it("inverted value bounds warn", () => {
    expect(snap(`tool: seq(x: int.min(5).max(2))`)).toMatchInlineSnapshot(`
      [
        "[warning] 1:14 Inverted value bounds: min (5) > max (2)",
      ]
    `);
  });

  it("inverted repetition-count bounds warn", () => {
    expect(snap(`tool: rep(str).countMin(5).countMax(2)`)).toMatchInlineSnapshot(`
      [
        "[warning] 1:7 Inverted repetition count bounds: countMin (5) > countMax (2)",
      ]
    `);
  });
});

describe("argtype golden diagnostics: lexer / parser errors", () => {
  it("digit-led tool name names the quoting fix", () => {
    expect(snap(`3dTstat: seq("-prefix", path)`)).toMatchInlineSnapshot(`
      [
        "[error] 1:1 Identifier cannot start with a digit; quote it as "3dTstat"",
      ]
    `);
  });

  it("unterminated string literal", () => {
    expect(snap(`tool: seq("unterminated)`)).toMatchInlineSnapshot(`
      [
        "[error] 1:11 Unterminated string literal",
        "[error] 1:25 Expected ')' but found 'eof'",
      ]
    `);
  });

  it("unterminated template literal", () => {
    expect(
      snap(`---
extensions:
  - outputs
---
tool: seq(x: path).output(o: \`{x}.nii)`),
    ).toMatchInlineSnapshot(`
      [
        "[error] 5:30 Unterminated template literal",
        "[error] 5:39 Expected ')' but found 'eof'",
      ]
    `);
  });
});

describe("argtype golden diagnostics: aliases", () => {
  it("unknown alias reference", () => {
    expect(snap(`tool: seq(Nope)`)).toMatchInlineSnapshot(`
      [
        "[error] 1:11 Unknown alias 'Nope'",
      ]
    `);
  });

  it("recursive alias cycle", () => {
    expect(
      snap(`A = seq(B)
B = seq(A)
tool: seq(A)`),
    ).toMatchInlineSnapshot(`
      [
        "[error] 2:9 Recursive alias 'A' is not allowed",
      ]
    `);
  });
});

describe("argtype golden diagnostics: frontmatter shape validation", () => {
  it("a list key given a scalar", () => {
    expect(
      snap(`---
exe: "tool"
authors: Solo Author
---
tool: seq(x: path)`),
    ).toMatchInlineSnapshot(`
      [
        "[warning] ?:? Frontmatter 'authors' should be a list; got a scalar - ignored",
      ]
    `);
  });

  it("container missing an image", () => {
    expect(
      snap(`---
exe: "tool"
container:
  type: docker
---
tool: seq(x: path)`),
    ).toMatchInlineSnapshot(`
      [
        "[warning] ?:? Frontmatter 'container' is missing an 'image'; ignored",
      ]
    `);
  });

  it("version neither string nor number", () => {
    expect(
      snap(`---
exe: "tool"
version: [1, 2]
---
tool: seq(x: path)`),
    ).toMatchInlineSnapshot(`
      [
        "[warning] ?:? Frontmatter 'version' should be a string or number; ignored",
      ]
    `);
  });
});
