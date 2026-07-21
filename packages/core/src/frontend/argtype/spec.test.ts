/**
 * Spec-coverage suite for the argtype sugar DSL frontend.
 *
 * Where `parser.test.ts` collects targeted regressions, this file walks the
 * argtype spec section by section and exercises the full spectrum of the
 * language: every terminal, literal, combinator, naming/alias form, metadata
 * chain, value/count constraint, doc-comment shape, frontmatter key, and the
 * `outputs` / `mediatypes` / `paths` / `constraints` extensions - plus the
 * precedence rules, trailing commas, micro-syntax, subcommands, and the
 * anonymous (unnamed) root.
 *
 * Assertions target the lowered Styx IR node structure (kind + attrs + meta)
 * and the parser diagnostics, rather than the human-readable `format()` dump,
 * so they pin behavior precisely.
 */

import { describe, expect, it } from "vitest";
import type { Expr } from "../../ir/node.js";
import { parseArgtype } from "./parser.js";
import { ArgtypeParser } from "./parser-frontend.js";

const frontend = new ArgtypeParser();
const parse = (src: string) => frontend.parse(src);
const ast = (src: string) => parseArgtype(src);

// -- IR navigation helpers --

/** Direct children of any node, regardless of kind. */
function kids(e: Expr): Expr[] {
  switch (e.kind) {
    case "sequence":
      return e.attrs.nodes;
    case "alternative":
      return e.attrs.alts;
    case "optional":
    case "repeat":
      return [e.attrs.node];
    default:
      return [];
  }
}

/** Depth-first search for the first node whose meta.name matches. */
function find(e: Expr, name: string): Expr | undefined {
  if (e.meta?.name === name) return e;
  for (const c of kids(e)) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Every node in the tree, pre-order. */
function all(e: Expr): Expr[] {
  return [e, ...kids(e).flatMap(all)];
}

/** The root sequence's direct children (the parser wraps the root in a seq). */
function rootKids(e: Expr): Expr[] {
  return e.kind === "sequence" ? e.attrs.nodes : [];
}

// ===========================================================================
// Terminals
// ===========================================================================

describe("argtype spec: terminals", () => {
  it.each([
    ["int", "int"],
    ["float", "float"],
    ["str", "str"],
    ["path", "path"],
  ])("lowers the `%s` terminal to an IR %s node", (kw, kind) => {
    const r = parse(`tool: seq(x: ${kw})`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "x")?.kind).toBe(kind);
  });

  it("treats a bare terminal as a positional (no wrapping)", () => {
    const r = parse(`tool: seq(input: path)`);
    expect(r.errors).toEqual([]);
    const input = rootKids(r.expr).find((n) => n.meta?.name === "input");
    expect(input?.kind).toBe("path");
  });
});

// ===========================================================================
// Literals
// ===========================================================================

describe("argtype spec: literals", () => {
  it("treats a quoted string as a fixed literal token", () => {
    const r = parse(`tool: seq("--verbose")`);
    expect(r.errors).toEqual([]);
    const lit = rootKids(r.expr).find((n) => n.kind === "literal");
    expect(lit?.kind === "literal" && lit.attrs.str).toBe("--verbose");
  });

  it("carries string escapes through to the literal value", () => {
    const r = parse(`tool: seq("a\\tb")`);
    expect(r.errors).toEqual([]);
    const lit = rootKids(r.expr).find((n) => n.kind === "literal");
    expect(lit?.kind === "literal" && lit.attrs.str).toBe("a\tb");
  });
});

// ===========================================================================
// seq
// ===========================================================================

describe("argtype spec: seq", () => {
  it("keeps children in order", () => {
    const r = parse(`tool: seq("--input", path, "--output", path)`);
    expect(r.errors).toEqual([]);
    expect(rootKids(r.expr).map((n) => n.kind)).toEqual(["literal", "path", "literal", "path"]);
  });

  it("treats a parenthesized group as an anonymous seq inside a combinator", () => {
    const r = parse(`tool: alt(("--fast", threshold: float), ("--robust", iterations: int))`);
    expect(r.errors).toEqual([]);
    const alt = rootKids(r.expr).find((n) => n.kind === "alternative");
    expect(alt?.kind).toBe("alternative");
    const arms = alt ? kids(alt) : [];
    expect(arms.every((a) => a.kind === "sequence")).toBe(true);
  });

  it("nests sequences", () => {
    const r = parse(`tool: seq(a: str, seq(b: str, c: str))`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "b")?.kind).toBe("str");
    expect(find(r.expr, "c")?.kind).toBe("str");
  });
});

// ===========================================================================
// set (lowers to sequence)
// ===========================================================================

describe("argtype spec: set", () => {
  it("lowers `set` to a sequence (order-not-meaningful is not modeled in IR)", () => {
    const r = parse(`tool: seq(input: path, set(opt("-q", q: int), opt("-v")), output: path)`);
    expect(r.errors).toEqual([]);
    // The set becomes a nested sequence between the two positionals.
    const seqs = all(r.expr).filter((n) => n.kind === "sequence");
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    expect(find(r.expr, "q")?.kind).toBe("int");
  });

  it("supports a mutually-exclusive `alt` member inside a `set`", () => {
    const r = parse(`tool: set(
      opt("-v"),
      mode: alt(("-t", text_input: path), ("-b", binary_input: path)),
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "mode")?.kind).toBe("alternative");
    expect(find(r.expr, "text_input")?.kind).toBe("path");
    expect(find(r.expr, "binary_input")?.kind).toBe("path");
  });
});

// ===========================================================================
// opt
// ===========================================================================

describe("argtype spec: opt", () => {
  it("wraps a bare-literal flag in an optional and defaults it to false (bool)", () => {
    const r = parse(`tool: seq(opt("-v"))`);
    expect(r.errors).toEqual([]);
    const optNode = rootKids(r.expr).find((n) => n.kind === "optional");
    expect(optNode?.kind).toBe("optional");
    expect(optNode?.meta?.defaultValue).toBe(false);
    expect(optNode?.kind === "optional" && optNode.attrs.node.kind).toBe("literal");
  });

  it("wraps a flag + value group so both appear together or not at all", () => {
    const r = parse(`tool: seq(opt("-f", intensity: float))`);
    expect(r.errors).toEqual([]);
    const optNode = rootKids(r.expr).find((n) => n.kind === "optional");
    expect(optNode?.kind === "optional" && optNode.attrs.node.kind).toBe("sequence");
    expect(find(r.expr, "intensity")?.kind).toBe("float");
  });

  it("implicitly wraps multiple children in a sequence", () => {
    const r = parse(`tool: seq(opt("-t", int, int, int))`);
    expect(r.errors).toEqual([]);
    const optNode = rootKids(r.expr).find((n) => n.kind === "optional");
    const inner = optNode?.kind === "optional" ? optNode.attrs.node : undefined;
    expect(inner?.kind).toBe("sequence");
    expect(inner && kids(inner).map((n) => n.kind)).toEqual(["literal", "int", "int", "int"]);
  });
});

// ===========================================================================
// rep
// ===========================================================================

describe("argtype spec: rep", () => {
  it("repeats a bare literal (count-shaped)", () => {
    const r = parse(`tool: rep("-v")`);
    expect(r.errors).toEqual([]);
    const rep = all(r.expr).find((n) => n.kind === "repeat");
    expect(rep?.kind === "repeat" && rep.attrs.node.kind).toBe("literal");
  });

  it("repeats a flag-value pair (list-shaped)", () => {
    const r = parse(`tool: rep(seq("-i", input: path))`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "input")?.kind).toBe("path");
  });

  it("fixes the count with `.count(n)` (countMin == countMax == n)", () => {
    const r = parse(`tool: seq(coord: rep(int).count(3))`);
    expect(r.errors).toEqual([]);
    const rep = find(r.expr, "coord");
    expect(rep?.kind === "repeat" && rep.attrs.countMin).toBe(3);
    expect(rep?.kind === "repeat" && rep.attrs.countMax).toBe(3);
  });

  it("supports one-sided `.countMin` / `.countMax` bounds", () => {
    const r = parse(`tool: seq(
      a: rep(str).countMin(1),
      b: rep(int).countMax(4),
    )`);
    expect(r.errors).toEqual([]);
    const a = find(r.expr, "a");
    const b = find(r.expr, "b");
    expect(a?.kind === "repeat" && a.attrs.countMin).toBe(1);
    expect(a?.kind === "repeat" && a.attrs.countMax).toBeUndefined();
    expect(b?.kind === "repeat" && b.attrs.countMin).toBeUndefined();
    expect(b?.kind === "repeat" && b.attrs.countMax).toBe(4);
  });
});

// ===========================================================================
// alt
// ===========================================================================

describe("argtype spec: alt", () => {
  it("uses the combinator form", () => {
    const r = parse(`tool: seq(alt(("--fast", t: float), ("--robust", i: int)))`);
    expect(r.errors).toEqual([]);
    expect(all(r.expr).some((n) => n.kind === "alternative")).toBe(true);
  });

  it("uses the `|` infix form as a bare-literal string enum", () => {
    const r = parse(`tool: seq(mode: "fast" | "slow" | "accurate")`);
    expect(r.errors).toEqual([]);
    const altNode = find(r.expr, "mode");
    expect(altNode?.kind).toBe("alternative");
    expect(altNode && kids(altNode).map((n) => n.kind === "literal" && n.attrs.str)).toEqual([
      "fast",
      "slow",
      "accurate",
    ]);
  });

  it("labels arms as discriminants (arm label, not just the inner field)", () => {
    const r = parse(`op: alt(
      add: ("-add", amount: float),
      mul: ("-mul", amount: float),
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "add")?.kind).toBe("sequence");
    expect(find(r.expr, "mul")?.kind).toBe("sequence");
  });

  it("labels data-bearing arms directly (value/image discriminants)", () => {
    const r = parse(`tool: seq(m: alt(value: float, image: path))`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "value")?.kind).toBe("float");
    expect(find(r.expr, "image")?.kind).toBe("path");
  });
});

// ===========================================================================
// any (lowers to first branch)
// ===========================================================================

describe("argtype spec: any", () => {
  it("emits only the first branch, losslessly and without a warning", () => {
    const r = parse(`tool: seq(any("--output", "-output", "-o"), path)`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const literals = all(r.expr)
      .filter((n) => n.kind === "literal")
      .map((n) => (n.kind === "literal" ? n.attrs.str : ""));
    expect(literals).toContain("--output");
    expect(literals).not.toContain("-output");
    expect(literals).not.toContain("-o");
  });

  it("errors when `any` has no branches", () => {
    const r = parse(`tool: seq(any())`);
    expect(r.errors.some((e) => /requires at least one branch/.test(e.message))).toBe(true);
  });
});

// ===========================================================================
// Naming
// ===========================================================================

describe("argtype spec: naming", () => {
  it("`label: expr` is sugar for `.name(label)`", () => {
    const r = parse(`tool: seq(quality: int)`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "quality")?.kind).toBe("int");
  });

  it("names nodes at any level", () => {
    const r = parse(`convert: set(
      thumbnail: opt("-thumbnail", size: str),
      input: path,
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "thumbnail")?.kind).toBe("optional");
    expect(find(r.expr, "size")?.kind).toBe("str");
    expect(find(r.expr, "input")?.kind).toBe("path");
  });

  it("accepts quoted labels for non-identifier names", () => {
    const r = parse(`"1deval": seq("1D": path, normal: str)`);
    expect(r.errors).toEqual([]);
    expect(r.expr.meta?.name).toBe("1deval");
    expect(find(r.expr, "1D")?.kind).toBe("path");
    expect(find(r.expr, "normal")?.kind).toBe("str");
  });

  it("renames duplicate sibling names and warns", () => {
    const r = parse(`tool: seq(output: path, output: path)`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /Duplicate sibling name 'output'/.test(w.message))).toBe(true);
    const names = rootKids(r.expr)
      .map((n) => n.meta?.name)
      .filter(Boolean);
    expect(names).toContain("output");
    expect(names).toContain("output_2");
  });
});

// ===========================================================================
// Type aliases
// ===========================================================================

describe("argtype spec: type aliases", () => {
  it("inlines an alias by substitution", () => {
    const r = parse(`Dimension = rep(int).count(2)
tool: seq(opt("-resize", size: Dimension))`);
    expect(r.errors).toEqual([]);
    const size = find(r.expr, "size");
    expect(size?.kind === "repeat" && size.attrs.countMin).toBe(2);
    expect(size?.kind === "repeat" && size.attrs.countMax).toBe(2);
  });

  it("overlays use-site chained methods onto the inlined alias", () => {
    const r = parse(`Coords = rep(float)
tool: seq(opt("-c", center: Coords.count(3)))`);
    expect(r.errors).toEqual([]);
    const center = find(r.expr, "center");
    expect(center?.kind === "repeat" && center.attrs.countMin).toBe(3);
  });

  it("detects a recursive alias cycle", () => {
    const r = parse(`A = seq(B)
B = seq(A)
tool: seq(A)`);
    expect(r.errors.some((e) => /[Rr]ecursive alias/.test(e.message))).toBe(true);
  });

  it("errors on an unknown alias reference", () => {
    const r = parse(`tool: seq(Nope)`);
    expect(r.errors.some((e) => /Unknown alias 'Nope'/.test(e.message))).toBe(true);
  });

  it("warns on a duplicate alias definition (last wins)", () => {
    const r = parse(`Foo = str
Foo = int
tool: seq(x: Foo)`);
    expect(r.warnings.some((w) => /Duplicate alias 'Foo'/.test(w.message))).toBe(true);
    expect(find(r.expr, "x")?.kind).toBe("int");
  });
});

// ===========================================================================
// Defaults
// ===========================================================================

describe("argtype spec: defaults", () => {
  it("attaches `= value` sugar to a bare terminal", () => {
    const r = parse(`tool: seq(quality: int = 80)`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "quality")?.meta?.defaultValue).toBe(80);
  });

  it("attaches `.default(value)` via chaining", () => {
    const r = parse(`tool: seq(quality: int.default(80))`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "quality")?.meta?.defaultValue).toBe(80);
  });

  it("accepts a string default", () => {
    const r = parse(`tool: seq(remote: str = "origin")`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "remote")?.meta?.defaultValue).toBe("origin");
  });

  it("accepts a negative numeric default", () => {
    const r = parse(`tool: seq(x: int = -5)`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "x")?.meta?.defaultValue).toBe(-5);
  });

  it("accepts `= value` after a method chain (sugar for `.default()`)", () => {
    const r = parse(`tool: seq(x: int.min(1) = 80)`);
    expect(r.errors).toEqual([]);
    const x = find(r.expr, "x");
    expect(x?.kind === "int" && x.attrs.minValue).toBe(1);
    expect(find(r.expr, "x")?.meta?.defaultValue).toBe(80);
  });
});

// ===========================================================================
// Value constraints
// ===========================================================================

describe("argtype spec: value constraints", () => {
  it("applies int min/max", () => {
    const r = parse(`tool: seq(i: int.min(1).max(100))`);
    expect(r.errors).toEqual([]);
    const i = find(r.expr, "i");
    expect(i?.kind === "int" && i.attrs.minValue).toBe(1);
    expect(i?.kind === "int" && i.attrs.maxValue).toBe(100);
  });

  it("applies float min/max with scientific notation", () => {
    const r = parse(`tool: seq(x: float.min(2.2e-308).max(1e5))`);
    expect(r.errors).toEqual([]);
    const x = find(r.expr, "x");
    expect(x?.kind === "float" && x.attrs.minValue).toBe(2.2e-308);
    expect(x?.kind === "float" && x.attrs.maxValue).toBe(1e5);
  });

  it("warns on inverted value bounds", () => {
    const r = parse(`tool: seq(x: int.min(5).max(2))`);
    expect(r.warnings.some((w) => /Inverted value bounds/.test(w.message))).toBe(true);
  });
});

// ===========================================================================
// Join / micro-syntax
// ===========================================================================

describe("argtype spec: join and micro-syntax", () => {
  it("defaults the `.join()` separator to the empty string", () => {
    const r = parse(`tool: seq("--x=", int).join()`);
    expect(r.errors).toEqual([]);
    // Root is the joined sequence itself.
    expect(r.expr.kind === "sequence" && r.expr.attrs.join).toBe("");
  });

  it("joins a repeat with an explicit separator", () => {
    const r = parse(`cut: seq("-f", fields: rep(int).join(","))`);
    expect(r.errors).toEqual([]);
    const fields = find(r.expr, "fields");
    expect(fields?.kind === "repeat" && fields.attrs.join).toBe(",");
  });

  it("pushes `.join()` on an opt onto its inner sequence", () => {
    const r = parse(`tool: seq(opt("K=", v: str).join())`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const optNode = rootKids(r.expr).find((n) => n.kind === "optional");
    const inner = optNode?.kind === "optional" ? optNode.attrs.node : undefined;
    expect(inner?.kind === "sequence" && inner.attrs.join).toBe("");
  });

  it("errors when `.join()` lands on an unsupported node (a terminal)", () => {
    const r = parse(`tool: seq(x: path.join(","))`);
    expect(r.errors.some((e) => /only supported on seq\/set\/rep/.test(e.message))).toBe(true);
  });

  it("models a nested micro-syntax (ffmpeg -vf) with layered joins", () => {
    const r = parse(`Filter = seq(str, "=", rep(str).join(":")).join()
tool: seq("-vf", filters: rep(Filter).join(","))`);
    expect(r.errors).toEqual([]);
    const filters = find(r.expr, "filters");
    expect(filters?.kind === "repeat" && filters.attrs.join).toBe(",");
    // Inner Filter sequence carries its own join="".
    const innerSeq = filters?.kind === "repeat" ? filters.attrs.node : undefined;
    expect(innerSeq?.kind === "sequence" && innerSeq.attrs.join).toBe("");
  });
});

// ===========================================================================
// Documentation
// ===========================================================================

describe("argtype spec: documentation", () => {
  it("attaches a `///` block as the description of the following node", () => {
    const r = parse(`tool: seq(
      /// The input image.
      input: path,
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "input")?.meta?.doc?.description).toBe("The input image.");
  });

  it("splits a leading `# ` heading into title + description", () => {
    const r = parse(`tool: seq(
      /// # Short title
      ///
      /// The longer description.
      input: path,
    )`);
    expect(r.errors).toEqual([]);
    const input = find(r.expr, "input");
    expect(input?.meta?.doc?.title).toBe("Short title");
    expect(input?.meta?.doc?.description).toBe("The longer description.");
  });

  it("treats a heading-less block as description-only", () => {
    const r = parse(`tool: seq(
      /// A description with
      ///
      /// two paragraphs but no title.
      output: path,
    )`);
    expect(r.errors).toEqual([]);
    const output = find(r.expr, "output");
    expect(output?.meta?.doc?.title).toBeUndefined();
    expect(output?.meta?.doc?.description).toBe(
      "A description with\n\ntwo paragraphs but no title.",
    );
  });

  it("soft-wraps single line breaks in a description (join with a space)", () => {
    const r = parse(`tool: seq(
      /// This description is wrapped
      /// across three consecutive
      /// lines for readability.
      input: path,
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "input")?.meta?.doc?.description).toBe(
      "This description is wrapped across three consecutive lines for readability.",
    );
  });

  it("keeps blank-line paragraph breaks while soft-wrapping each paragraph", () => {
    const r = parse(`tool: seq(
      /// First paragraph wrapped
      /// over two lines.
      ///
      /// Second paragraph also
      /// over two lines.
      input: path,
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "input")?.meta?.doc?.description).toBe(
      "First paragraph wrapped over two lines.\n\nSecond paragraph also over two lines.",
    );
  });

  it("soft-wraps the description under a `# ` title too", () => {
    const r = parse(`tool: seq(
      /// # Threshold
      ///
      /// Smaller values give
      /// larger estimates.
      input: path,
    )`);
    expect(r.errors).toEqual([]);
    const input = find(r.expr, "input");
    expect(input?.meta?.doc?.title).toBe("Threshold");
    expect(input?.meta?.doc?.description).toBe("Smaller values give larger estimates.");
  });

  it("sets `.title()`/`.description()` verbatim (no heading re-parse)", () => {
    const r = parse(`tool: seq(x: str.description("# not a title"))`);
    expect(r.errors).toEqual([]);
    const x = find(r.expr, "x");
    expect(x?.meta?.doc?.title).toBeUndefined();
    expect(x?.meta?.doc?.description).toBe("# not a title");
  });

  it("drops a regular `//` comment (not attached to any node)", () => {
    const r = parse(`tool: seq(
      // just a note
      input: path,
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "input")?.meta?.doc).toBeUndefined();
  });

  it("applies the `///` block first; a later `.title()` only fills an unset part", () => {
    const r = parse(`tool: seq(
      /// # Block title
      input: path.title("Chain title"),
    )`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "input")?.meta?.doc?.title).toBe("Block title");
  });
});

// ===========================================================================
// Precedence and trailing commas
// ===========================================================================

describe("argtype spec: precedence", () => {
  it("binds `|` tighter than `label:` (name binds the whole alternative)", () => {
    const r = parse(`tool: seq("--mode", mode: "fast" | "slow")`);
    expect(r.errors).toEqual([]);
    const children = rootKids(r.expr);
    expect(children[0]?.kind).toBe("literal");
    const altNode = children.find((n) => n.kind === "alternative");
    expect(altNode?.meta?.name).toBe("mode");
    expect(altNode && kids(altNode).length).toBe(2);
  });

  it("binds `|` tighter than `,` (alternative is a single list element)", () => {
    const r = parse(`tool: seq(a: str, "b" | "c", d: str)`);
    expect(r.errors).toEqual([]);
    const kinds = rootKids(r.expr).map((n) => n.kind);
    expect(kinds).toEqual(["str", "alternative", "str"]);
  });

  it("allows trailing commas in comma-separated lists", () => {
    const r = parse(`tool: seq(a: str, b: str,)`);
    expect(r.errors).toEqual([]);
    expect(rootKids(r.expr).map((n) => n.meta?.name)).toEqual(["a", "b"]);
  });
});

// ===========================================================================
// Frontmatter
// ===========================================================================

describe("argtype spec: frontmatter", () => {
  it("parses the common metadata keys into AppMeta", () => {
    const r = parse(`---
exe: "bet"
version: "6.0.4"
authors:
  - "FMRIB Analysis Group"
urls:
  - "https://fsl.fmrib.ox.ac.uk"
references:
  - "Smith 2002"
---
/// Brain extraction.
bet: seq(infile: path)`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.id).toBe("bet");
    expect(r.meta?.version).toBe("6.0.4");
    expect(r.meta?.doc?.authors).toEqual(["FMRIB Analysis Group"]);
    expect(r.meta?.doc?.urls).toEqual(["https://fsl.fmrib.ox.ac.uk"]);
    expect(r.meta?.doc?.literature).toEqual(["Smith 2002"]);
    expect(r.meta?.doc?.description).toBe("Brain extraction.");
  });

  it("uses the root definition name as the id, not exe, when they differ", () => {
    const r = parse(`---
exe: "wb_command"
---
sub: seq(x: path)`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.id).toBe("sub");
  });

  it("coerces an unquoted numeric version to a string", () => {
    const r = parse(`---
version: 6.0
---
bet: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.version).toBe("6");
  });

  it("parses a container image and type", () => {
    const r = parse(`---
exe: "x"
container:
  image: "docker://imagemagick:7.1"
  type: docker
---
x: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.container?.image).toBe("docker://imagemagick:7.1");
    expect(r.meta?.container?.type).toBe("docker");
  });

  it("parses stdout as a map and stderr as a bare string", () => {
    const r = parse(`---
exe: "x"
stdout:
  name: "log"
  description: "the log"
stderr: "errors"
---
x: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.stdout?.name).toBe("log");
    expect(r.meta?.stdout?.doc?.description).toBe("the log");
    expect(r.meta?.stderr?.name).toBe("errors");
  });

  it("keeps an unquoted `#` inside a value (URL fragment)", () => {
    const r = parse(`---
urls:
  - https://fsl.fmrib.ox.ac.uk/wiki#bet
---
bet: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.doc?.urls).toEqual(["https://fsl.fmrib.ox.ac.uk/wiki#bet"]);
  });

  it("errors on an unterminated frontmatter fence", () => {
    const r = parse(`---
exe: "x"
x: path`);
    expect(r.errors.some((e) => /Unterminated frontmatter/.test(e.message))).toBe(true);
  });

  it("keeps body line numbers aligned after frontmatter", () => {
    const r = parse(`---
exe: "x"
---
x: seq(@bad)`);
    expect(r.errors[0]?.location?.line).toBe(4);
  });

  it("prepends the exe as the command's first literal token", () => {
    const r = parse(`---
exe: "echo"
---
echo: rep(str)`);
    expect(r.errors).toEqual([]);
    const first = rootKids(r.expr)[0];
    expect(first?.kind === "literal" && first.attrs.str).toBe("echo");
  });
});

// ===========================================================================
// Extension: outputs
// ===========================================================================

describe("argtype spec: outputs extension", () => {
  const fm = `---
extensions:
  - outputs
---
`;

  it("resolves a `{ref}` interpolation to the named node plus literal suffix", () => {
    const r = parse(`${fm}tool: seq(
  out: str,
  opt("-m").output(mask: \`{out}_mask.nii\`),
)`);
    expect(r.errors).toEqual([]);
    const outs = r.expr.meta?.outputs ?? [];
    const mask = outs.find((o) => o.name === "mask");
    expect(mask?.tokens[0]?.kind).toBe("ref");
    expect(mask?.tokens[0]?.kind === "ref" && mask.tokens[0].target.name).toBe("out");
    expect(mask?.tokens[1]).toEqual({ kind: "literal", value: "_mask.nii" });
  });

  it("resolves a `{}` self-reference to the attached node's name", () => {
    const r = parse(`${fm}tool: seq(out: path.output(copy: \`{}.bak\`))`);
    expect(r.errors).toEqual([]);
    const outs = r.expr.meta?.outputs ?? [];
    const copy = outs.find((o) => o.name === "copy");
    expect(copy?.tokens[0]?.kind === "ref" && copy.tokens[0].target.name).toBe("out");
  });

  it("carries a `strip_suffix` op onto the ref token", () => {
    const r = parse(`${fm}tool: seq(in: path.output(o: \`{in.strip_suffix(".nii")}_out\`))`);
    expect(r.errors).toEqual([]);
    const o = (r.expr.meta?.outputs ?? []).find((x) => x.name === "o");
    const ref = o?.tokens.find((t) => t.kind === "ref");
    expect(ref?.kind === "ref" && ref.stripExtensions).toEqual([".nii"]);
  });

  it("accepts a quoted (non-identifier) output ref target", () => {
    const r = parse(`${fm}tool: seq("4d_output": path).output(result: \`{"4d_output"}.nii\`)`);
    expect(r.errors).toEqual([]);
    const ref = r.expr.meta?.outputs?.[0]?.tokens.find((t) => t.kind === "ref");
    expect(ref?.kind === "ref" && ref.target.name).toBe("4d_output");
  });

  it("accepts `.title()`/`.description()` on an output template", () => {
    const r = parse(
      `${fm}tool: seq(x: path).output(mask: \`{x}.nii\`.title("Brain mask").description("The mask."))`,
    );
    expect(r.errors).toEqual([]);
    const out = r.expr.meta?.outputs?.[0];
    expect(out?.doc?.title).toBe("Brain mask");
    expect(out?.doc?.description).toBe("The mask.");
  });

  it("ignores an unsupported output-template method with a warning", () => {
    const r = parse(`${fm}tool: seq(x: path).output(r: \`{x}.nii\`.mystery("z"))`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /mystery/.test(w.message))).toBe(true);
  });
});

// ===========================================================================
// Extension: mediatypes
// ===========================================================================

describe("argtype spec: mediatypes extension", () => {
  it("attaches a media type to a path terminal", () => {
    const r = parse(`---
extensions:
  - mediatypes
---
tool: seq(image: path.mediaType("image/png"))`);
    expect(r.errors).toEqual([]);
    const image = find(r.expr, "image");
    expect(image?.kind === "path" && image.attrs.mediaTypes).toEqual(["image/png"]);
  });

  it("errors that `.mediaType()` is path-only when used on a str", () => {
    const r = parse(`tool: seq(x: str.mediaType("text/plain"))`);
    expect(r.errors.some((e) => /mediaType.*only supported on path/.test(e.message))).toBe(true);
    // The str carries no media type; the error does not stop a sibling path in
    // the same doc from still receiving its own media type.
    const r2 = parse(`tool: seq(img: path.mediaType("image/png"))`);
    expect(r2.errors).toEqual([]);
    const img = find(r2.expr, "img");
    expect(img?.kind === "path" && img.attrs.mediaTypes).toEqual(["image/png"]);
  });
});

// ===========================================================================
// Extension: paths
// ===========================================================================

describe("argtype spec: paths extension", () => {
  it("attaches `.mutable()` and `.resolveParent()` to path attrs", () => {
    const r = parse(`tool: seq(image: path.mutable(), out: path.resolveParent())`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const image = find(r.expr, "image");
    const out = find(r.expr, "out");
    expect(image?.kind === "path" && image.attrs.mutable).toBe(true);
    expect(out?.kind === "path" && out.attrs.resolveParent).toBe(true);
  });
});

// ===========================================================================
// Misapplied type-specific modifiers are hard errors (don't silently drop)
// ===========================================================================

describe("argtype spec: misapplied modifiers error", () => {
  it("errors when `.min()`/`.max()` land on a non-numeric node", () => {
    const r = parse(`tool: seq(x: str.min(1), y: rep(int).max(9))`);
    expect(
      r.errors.some((e) => /min\(\).*max\(\).*only supported on int\/float/.test(e.message)),
    ).toBe(true);
  });

  it("errors when a count bound lands on a non-rep node", () => {
    const r = parse(`tool: seq(x: str.count(3))`);
    expect(r.errors.some((e) => /count.*only supported on rep/.test(e.message))).toBe(true);
  });

  it("errors when `.mutable()`/`.resolveParent()` land on a non-path node", () => {
    const r = parse(`tool: seq(x: str.mutable())`);
    expect(r.errors.some((e) => /mutable.*only supported on path/.test(e.message))).toBe(true);
  });

  it("does not error when the modifier matches the node type", () => {
    const r = parse(`tool: seq(
      a: int.min(1).max(10),
      b: rep(path).count(2),
      c: path.mutable().resolveParent(),
    )`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("does not error when a modifier reaches a compatible node through an alias", () => {
    const r = parse(`Count = int
tool: seq(n: Count.min(0).max(5))`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const n = find(r.expr, "n");
    expect(n?.kind === "int" && n.attrs.minValue).toBe(0);
  });

  it("errors when a modifier reaches an incompatible target through an alias", () => {
    const r = parse(`Word = str
tool: seq(x: Word.min(1))`);
    expect(r.errors.some((e) => /min\(\).*only supported on int\/float/.test(e.message))).toBe(
      true,
    );
  });
});

// ===========================================================================
// `extensions:` frontmatter is an ignored (no-op) key: using an extension needs
// no declaration, and declaring one has no effect.
// ===========================================================================

describe("argtype spec: extensions frontmatter is a no-op", () => {
  it("does not warn when an extension is used without any declaration", () => {
    const r = parse(`---
exe: "tool"
---
tool: seq(x: path.mutable())`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("ignores a present `extensions:` key without complaint", () => {
    const r = parse(`---
exe: "tool"
extensions:
  - paths
---
tool: seq(x: path.mutable())`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("does not warn on extension usage when there is no frontmatter at all", () => {
    const r = parse(`tool: seq(x: path.mutable(), out: path.resolveParent())`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("parses an inline flow-sequence value (asserted via a consumed key)", () => {
    // `authors` is consumed into meta, so it proves `splitFlow` actually built a
    // list. `extensions: [...]` in the same doc is the no-op case (ignored key).
    const r = parse(`---
exe: "tool"
authors: ["Ada Lovelace", "Bob, Jr.", "Carol"]
extensions: [paths, outputs]
---
tool: seq(x: path.mutable()).output(o: \`{x}.out\`)`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    // The quoted "Bob, Jr." keeps its embedded comma; three elements, no phantom.
    expect(r.meta?.doc?.authors).toEqual(["Ada Lovelace", "Bob, Jr.", "Carol"]);
  });

  it("drops phantom empty elements from a trailing comma in a flow sequence", () => {
    const r = parse(`---
exe: "tool"
authors: [Ada, Bob,]
---
tool: seq(x: path)`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.doc?.authors).toEqual(["Ada", "Bob"]);
  });

  it("has no lingering declare-before-use behavior", () => {
    const r = parse(`---
exe: "tool"
extensions:
  - outputs
---
tool: seq(img: path.mediaType("image/png").mutable(), img2: path.mutable()).output(o: \`{img}.out\`)`);
    expect(r.errors).toEqual([]);
    // No declaration discipline remains: extension usage never produces a
    // "does not declare it" warning regardless of what `extensions:` lists.
    expect(r.warnings.some((w) => /does not declare it/.test(w.message))).toBe(false);
  });
});

// ===========================================================================
// Extension: constraints (draft, parsed-and-ignored)
// ===========================================================================

describe("argtype spec: constraints extension (ignorable)", () => {
  it("parses-and-ignores an unimplemented `.requires()` with a warning, not an error", () => {
    const r = parse(`tool: seq(
      a: opt("-a"),
      b: opt("-b").requires("a"),
    )`);
    expect(r.errors).toEqual([]);
    expect(
      r.warnings.some((w) => /Ignoring unsupported method '\.requires\(\)'/.test(w.message)),
    ).toBe(true);
  });

  it("treats a `.doc()` method as an ignorable unknown method, not a description", () => {
    const r = parse(`tool: seq(x: str.doc("The image."))`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "x")?.meta?.doc?.description).toBeUndefined();
    expect(r.warnings.some((w) => /\.doc\(\)/.test(w.message))).toBe(true);
  });
});

// ===========================================================================
// Composite examples from the spec
// ===========================================================================

describe("argtype spec: composite examples", () => {
  it("compiles the `convert` flags-and-values example", () => {
    const r = parse(`---
exe: "convert"
---
convert: seq(
  input: path,
  set(
    opt("-q", quality: int.min(1).max(100).default(80)),
    opt("-f", format: "png" | "jpg" | "webp"),
    opt("-v"),
  ),
  output: path,
)`);
    expect(r.errors).toEqual([]);
    const quality = find(r.expr, "quality");
    expect(quality?.kind === "int" && quality.attrs.minValue).toBe(1);
    expect(quality?.meta?.defaultValue).toBe(80);
    expect(find(r.expr, "format")?.kind).toBe("alternative");
  });

  it("compiles the `git` subcommand example (alt of named seqs)", () => {
    const r = parse(`---
exe: "git"
---
git: alt(
  commit: seq("commit", set(opt("-m", message: str), opt("--amend"))),
  push: seq("push", set(opt("--force")), remote: str = "origin", branch: str),
)`);
    expect(r.errors).toEqual([]);
    expect(find(r.expr, "commit")?.kind).toBe("sequence");
    expect(find(r.expr, "push")?.kind).toBe("sequence");
    expect(find(r.expr, "message")?.kind).toBe("str");
    expect(find(r.expr, "remote")?.meta?.defaultValue).toBe("origin");
  });

  it("compiles the common option-form-alternatives pattern (any + join)", () => {
    const r = parse(`Output = seq(any("--output", "-output", "-o"), path)
tool: seq(opt(any(Output, Output.join("="))))`);
    expect(r.errors).toEqual([]);
    // any -> first branch (Output), which is seq(any(...) -> "--output", path).
    const literals = all(r.expr)
      .filter((n) => n.kind === "literal")
      .map((n) => (n.kind === "literal" ? n.attrs.str : ""));
    expect(literals).toContain("--output");
  });
});

// ===========================================================================
// Anonymous (unnamed) root
// ===========================================================================
// The spec's frontmatter section states the tool id "falls back to exe, then
// id" when the root is unnamed, and the lowering layer already handles an
// unnamed root - so a bare root expression should be a valid descriptor.

describe("argtype spec: anonymous root", () => {
  it("accepts a bare `seq(...)` as an anonymous root", () => {
    const r = parse(`seq("hello", "world")`);
    expect(r.errors).toEqual([]);
    expect(r.expr.kind).toBe("sequence");
    expect(rootKids(r.expr).map((n) => (n.kind === "literal" ? n.attrs.str : n.kind))).toEqual([
      "hello",
      "world",
    ]);
  });

  it("accepts a bare `rep(...)` as an anonymous root", () => {
    const r = parse(`rep(str)`);
    expect(r.errors).toEqual([]);
    expect(all(r.expr).some((n) => n.kind === "repeat")).toBe(true);
  });

  it("accepts a bare terminal as an anonymous root", () => {
    const r = parse(`path`);
    expect(r.errors).toEqual([]);
    expect(all(r.expr).some((n) => n.kind === "path")).toBe(true);
  });

  it("accepts a bare literal as an anonymous root", () => {
    const r = parse(`"run"`);
    expect(r.errors).toEqual([]);
    const lit = all(r.expr).find((n) => n.kind === "literal");
    expect(lit?.kind === "literal" && lit.attrs.str).toBe("run");
  });

  it("accepts a bare parenthesized group as an anonymous root", () => {
    const r = parse(`("a", "b")`);
    expect(r.errors).toEqual([]);
    const lits = all(r.expr)
      .filter((n) => n.kind === "literal")
      .map((n) => (n.kind === "literal" ? n.attrs.str : ""));
    expect(lits).toEqual(["a", "b"]);
  });

  it("takes the anonymous root's id from `exe` frontmatter", () => {
    const r = parse(`---
exe: "echo"
---
rep(str)`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.id).toBe("echo");
    const first = rootKids(r.expr)[0];
    expect(first?.kind === "literal" && first.attrs.str).toBe("echo");
  });

  it("allows aliases before an anonymous root", () => {
    const r = parse(`Word = str
seq(Word, Word)`);
    expect(r.errors).toEqual([]);
    expect(all(r.expr).filter((n) => n.kind === "str").length).toBe(2);
  });

  it("still rejects two root definitions", () => {
    const r = parse(`a: str
b: str`);
    expect(r.errors.some((e) => /Multiple root definitions/.test(e.message))).toBe(true);
  });

  it("leaves the AST root name undefined for an anonymous root", () => {
    const a = ast(`seq("x")`);
    expect(a.errors).toEqual([]);
    expect(a.doc?.rootName).toBeUndefined();
    expect(a.doc?.root.name).toBeUndefined();
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe("argtype spec: error handling", () => {
  it("errors on an empty document (no root)", () => {
    const r = parse(`   \n  `);
    expect(r.errors.some((e) => /No root definition/.test(e.message))).toBe(true);
  });

  it("errors on an unterminated string literal", () => {
    const r = parse(`tool: seq("unterminated)`);
    expect(r.errors.some((e) => /Unterminated string/.test(e.message))).toBe(true);
  });

  it("errors on a malformed number whose exponent has no digits", () => {
    const r = parse(`tool: seq(x: int.min(1e))`);
    expect(r.errors.some((e) => /exponent has no digits/.test(e.message))).toBe(true);
  });

  it("errors on an unexpected character", () => {
    const r = parse(`tool: seq(@)`);
    expect(r.errors.some((e) => /Unexpected character/.test(e.message))).toBe(true);
  });

  it("names the fix for a digit-led identifier (quote it) instead of a generic error", () => {
    // All of AFNI is `3d*`/`1d*`/`2d*`; the diagnostic must name the quoting fix.
    const r = parse(`3dTstat: seq("-prefix", path)`);
    expect(
      r.errors.some((e) => /cannot start with a digit; quote it as "3dTstat"/.test(e.message)),
    ).toBe(true);
    // It must not fall through to the baffling "expected a definition" message.
    expect(r.errors.some((e) => /Expected a definition/.test(e.message))).toBe(false);
  });

  it("does not misread a broken number as a digit-led identifier", () => {
    // Only a pure integer run recovers as a quoted identifier. A malformed
    // exponent (`1eq`) must report the exponent error alone, not also a
    // contradictory "quote it as \"1eq\"" - one token, one diagnostic.
    const r = parse(`tool: seq(x: int.min(1eq))`);
    expect(r.errors.some((e) => /exponent has no digits/.test(e.message))).toBe(true);
    expect(r.errors.some((e) => /quote it as/.test(e.message))).toBe(false);
  });

  it("reports a clear error on a stray leading top-level token (not a duplicate root)", () => {
    // A `,` cannot start a definition/alias/root expression. The real root that
    // follows must not be mis-reported as a duplicate.
    const r = parse(`,
tool: seq(x: int)`);
    expect(r.errors.some((e) => /Expected a definition/.test(e.message))).toBe(true);
    expect(r.errors.some((e) => /Multiple root definitions/.test(e.message))).toBe(false);
  });

  it("errors on an unterminated template literal", () => {
    const r = parse(`---
extensions:
  - outputs
---
tool: seq(x: path).output(o: \`{x}.nii)`);
    expect(r.errors.some((e) => /Unterminated template/.test(e.message))).toBe(true);
  });

  it("errors on an unterminated `{` interpolation inside a template", () => {
    const r = parse(`---
extensions:
  - outputs
---
tool: seq(x: path).output(o: \`{x.nii\`)`);
    expect(r.errors.some((e) => /Unterminated '\{'/.test(e.message))).toBe(true);
  });
});

// ===========================================================================
// Discriminant uniqueness (regression: alt arms were not deduped)
// ===========================================================================

describe("argtype spec: alt discriminant uniqueness", () => {
  it("renames duplicate `alt` arm labels and warns (union variants must be distinct)", () => {
    const r = parse(`tool: seq(m: alt(x: int, x: path))`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /Duplicate sibling name 'x'/.test(w.message))).toBe(true);
    const m = find(r.expr, "m");
    const arms = m ? kids(m) : [];
    expect(arms.map((a) => a.meta?.name)).toEqual(["x", "x_2"]);
  });

  it("does not dedupe bare-literal enum arms (no names to collide)", () => {
    const r = parse(`tool: seq(mode: "a" | "b" | "a")`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("leaves `any` branches untouched (they are meant to be binding-compatible)", () => {
    const r = parse(`tool: seq(any(("--o", v: path), ("-o", v: path)))`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    // any emits branch 0 only; the surviving value node keeps its name `v`.
    expect(find(r.expr, "v")?.kind).toBe("path");
    expect(find(r.expr, "v_2")).toBeUndefined();
  });
});

// ===========================================================================
// Additional coverage: warnings, escapes, accumulation, frontmatter shapes
// ===========================================================================

describe("argtype spec: outputs extension (unsupported ops warn-and-drop)", () => {
  const fm = `---
extensions:
  - outputs
---
`;

  it("carries a reference-level `.or(fallback)` onto the ref token", () => {
    const r = parse(`${fm}tool: seq(p: str.output(o: \`{p.or("out")}_x\`))`);
    expect(r.errors).toEqual([]);
    const ref = r.expr.meta?.outputs?.[0]?.tokens.find((t) => t.kind === "ref");
    expect(ref?.kind === "ref" && ref.fallback).toBe("out");
  });

  it("warns and drops an output-level `.or(fallback)` (distinct from ref-level)", () => {
    const r = parse(`${fm}tool: seq(p: str.output(o: \`{p}_x\`.or("thumb")))`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /Output-level.*or.*not supported/i.test(w.message))).toBe(true);
  });

  it("warns and drops `strip_prefix` and `basename` ops", () => {
    const r = parse(
      `${fm}tool: seq(in: path.output(o: \`{in.strip_prefix("pre_").basename()}_x\`))`,
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /strip_prefix.*not supported/i.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => /basename.*not supported/i.test(w.message))).toBe(true);
    const ref = r.expr.meta?.outputs?.[0]?.tokens.find((t) => t.kind === "ref");
    expect(ref?.kind === "ref" && ref.stripExtensions).toBeUndefined();
  });

  it("warns on a `{}` self-reference with no named node to resolve to", () => {
    // The node bearing the output must be genuinely nameless (no enclosing named
    // scope to borrow from) - an anonymous-root bare path is exactly that.
    const r = parse(`${fm}path.output(o: \`{}.bak\`)`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /self-reference.*no named node/i.test(w.message))).toBe(true);
    expect(r.expr.meta?.outputs?.[0]?.tokens[0]).toEqual({ kind: "literal", value: "" });
  });

  it("accumulates multiple `.output()` calls on one node", () => {
    const r = parse(`${fm}tool: seq(x: path.output(a: \`{x}_a\`).output(b: \`{x}_b\`))`);
    expect(r.errors).toEqual([]);
    const names = (r.expr.meta?.outputs ?? []).map((o) => o.name).sort();
    expect(names).toEqual(["a", "b"]);
  });
});

describe("argtype spec: template escapes", () => {
  it("treats `\\{`, `\\}`, and `\\\\` as literal characters, not interpolation", () => {
    const r = parse(`---
extensions:
  - outputs
---
tool: seq(x: path).output(o: \`\\{env\\}/a\\\\b.nii\`)`);
    expect(r.errors).toEqual([]);
    const tokens = r.expr.meta?.outputs?.[0]?.tokens ?? [];
    // No ref token - the whole thing is one literal with the braces/backslash intact.
    expect(tokens.every((t) => t.kind === "literal")).toBe(true);
    expect(tokens.map((t) => (t.kind === "literal" ? t.value : "")).join("")).toBe(
      "{env}/a\\b.nii",
    );
  });
});

describe("argtype spec: more join/count coverage", () => {
  it("applies `.join()` to a `set` (lowered sequence carries the separator)", () => {
    const r = parse(`tool: seq(kv: set("a", "b").join(":"))`);
    expect(r.errors).toEqual([]);
    const kv = find(r.expr, "kv");
    expect(kv?.kind === "sequence" && kv.attrs.join).toBe(":");
  });

  it("errors when `.join()` lands on an `alt` combinator (not a joinable node)", () => {
    // The explicit `alt(...)` form puts the join on the alternative itself; the
    // `(a | b)` paren form would instead land it on the joinable seq wrapper.
    const r = parse(`tool: seq(x: alt("a", "b").join(","))`);
    expect(r.errors.some((e) => /only supported on seq\/set\/rep/.test(e.message))).toBe(true);
  });

  it("warns on inverted repetition-count bounds", () => {
    const r = parse(`tool: rep(str).countMin(5).countMax(2)`);
    expect(r.warnings.some((w) => /Inverted repetition count bounds/.test(w.message))).toBe(true);
  });

  it("accumulates multiple `.mediaType()` calls", () => {
    const r = parse(`tool: seq(img: path.mediaType("image/png").mediaType("image/jpeg"))`);
    expect(r.errors).toEqual([]);
    const img = find(r.expr, "img");
    expect(img?.kind === "path" && img.attrs.mediaTypes).toEqual(["image/png", "image/jpeg"]);
  });
});

describe("argtype spec: more frontmatter coverage", () => {
  it("parses a leading BOM and CRLF line endings", () => {
    const r = parse(`\uFEFF---\r\nexe: "bom"\r\n---\r\nx: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.id).toBe("x");
  });

  it("ignores unknown frontmatter keys", () => {
    const r = parse(`---
exe: "x"
nonsense: "whatever"
---
x: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.id).toBe("x");
  });

  it("accepts a singularity container and drops an unrecognized type", () => {
    const ok = parse(`---
exe: "x"
container:
  image: "img"
  type: singularity
---
x: path`);
    expect(ok.meta?.container?.type).toBe("singularity");

    const bogus = parse(`---
exe: "x"
container:
  image: "img"
  type: podman
---
x: path`);
    expect(bogus.meta?.container?.image).toBe("img");
    expect(bogus.meta?.container?.type).toBeUndefined();
  });

  it("warns and drops a stdout map missing its `name`", () => {
    const r = parse(`---
exe: "x"
stdout:
  description: "no name here"
---
x: path`);
    expect(r.warnings.some((w) => /stdout.*missing a 'name'/.test(w.message))).toBe(true);
    expect(r.meta?.stdout).toBeUndefined();
  });
});

describe("argtype spec: golden examples emit no warnings", () => {
  it.each([
    [
      "convert",
      `---
exe: "convert"
---
convert: seq(
  input: path,
  set(opt("-q", quality: int.min(1).max(100).default(80)), opt("-v")),
  output: path,
)`,
    ],
    [
      "git",
      `---
exe: "git"
---
git: alt(
  commit: seq("commit", set(opt("-m", message: str), opt("--amend"))),
  push: seq("push", set(opt("--force")), remote: str = "origin", branch: str),
)`,
    ],
  ])("%s compiles with no errors and no warnings", (_name, src) => {
    const r = parse(src);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
