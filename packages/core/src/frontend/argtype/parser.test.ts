import { describe, expect, it } from "vitest";
import { format } from "../../ir/format.js";
import { ArgtypeParser } from "./parser-frontend.js";
import { parseArgtype } from "./parser.js";

const parser = new ArgtypeParser();

function parse(src: string) {
  const result = parser.parse(src);
  return result;
}

describe("argtype lexer/parser core", () => {
  it("parses a bare positional terminal", () => {
    const { errors, expr } = parse("echo: rep(message: str)");
    expect(errors).toEqual([]);
    expect(expr.kind).toBe("sequence"); // root is wrapped? no - rep -> wrapped seq
  });

  it("lowers terminals, flags and value constraints", () => {
    const r = parse(`convert: seq(
      input: path,
      set(
        opt("-q", quality: int.min(1).max(100).default(80)),
        opt("-v"),
      ),
      output: path,
    )`);
    expect(r.errors).toEqual([]);
    const dump = format(r.expr, r.meta);
    expect(dump).toContain("path [input]");
    expect(dump).toContain("int [quality] (1..100)");
    // set lowers to a sequence
    expect(dump).toContain("sequence");
  });

  it("resolves the alt infix operator with correct precedence", () => {
    const r = parse(`tool: seq("--mode", mode: "fast" | "slow")`);
    expect(r.errors).toEqual([]);
    const dump = format(r.expr);
    expect(dump).toContain("alternative [mode]");
    expect(dump).toContain('literal "fast"');
    expect(dump).toContain('literal "slow"');
  });

  it("inlines type aliases", () => {
    const r = parse(`Dimension = rep(int).count(2)
tool: seq(opt("-resize", size: Dimension))`);
    expect(r.errors).toEqual([]);
    const dump = format(r.expr);
    expect(dump).toContain("repeat [size] {min=2, max=2}");
  });

  it("detects recursive aliases", () => {
    const r = parse(`A = seq(B)
B = seq(A)
tool: seq(A)`);
    expect(r.errors.some((e) => /[Rr]ecursive alias/.test(e.message))).toBe(true);
  });

  it("treats `.join()` on an opt the same as on its inner seq (micro-syntax)", () => {
    // `opt("K=", v).join()` collapses the flag+value into one `K=value` token,
    // equivalent to putting the join on the inner sequence.
    const onOpt = parse(`tool: seq(opt("K=", v: str).join())`);
    const onSeq = parse(`tool: seq(opt(seq("K=", v: str).join()))`);
    expect(onOpt.errors).toEqual([]);
    expect(onOpt.warnings).toEqual([]);
    expect(JSON.stringify(onOpt.expr)).toBe(JSON.stringify(onSeq.expr));
    // The join lands on the inner sequence, not lost.
    expect(format(onOpt.expr)).toContain('sequence join=""');
  });

  it("applies join and count modifiers", () => {
    const r = parse(`cut: seq("-f", fields: rep(int).join(","))`);
    expect(r.errors).toEqual([]);
    const dump = format(r.expr);
    expect(dump).toContain('repeat [fields] {join=","}');
  });

  it("attaches doc comments to the following node", () => {
    const ast = parseArgtype(`tool: seq(
      /// The input image.
      input: path,
    )`);
    expect(ast.doc?.root.children?.[0]?.description).toBe("The input image.");
  });

  it("supports .title() and .doc() methods (set title/description directly)", () => {
    const r = parse(`tool: seq(input: path.title("Input").doc("The image to read."))`);
    expect(r.errors).toEqual([]);
    const input =
      r.expr.kind === "sequence" ? r.expr.attrs.nodes.find((n) => n.kind === "path") : undefined;
    expect(input?.meta?.doc?.title).toBe("Input");
    expect(input?.meta?.doc?.description).toBe("The image to read.");

    // `.doc()` sets the description verbatim - a leading `#` is NOT a title here.
    const r2 = parse(`tool: seq(x: str.doc("# not a title"))`);
    const x =
      r2.expr.kind === "sequence" ? r2.expr.attrs.nodes.find((n) => n.kind === "str") : undefined;
    expect(x?.meta?.doc?.title).toBeUndefined();
    expect(x?.meta?.doc?.description).toBe("# not a title");
  });

  it("applies chained methods on an alias reference", () => {
    const r = parse(`Coords = rep(float)
tool: seq(opt("-c", center: Coords.count(3)))`);
    expect(r.errors).toEqual([]);
    const dump = format(r.expr);
    expect(dump).toContain("repeat [center] {min=3, max=3}");
  });

  it("attaches a doc comment to an output entry", () => {
    const r = parse(`---
exe: "tool"
extensions:
  - outputs
---
tool: seq(
  out: str,
  opt("-m").output(
    /// # Brain mask
    ///
    /// The binary brain mask file.
    mask: \`{out}_mask.nii\`,
  ),
)`);
    expect(r.errors).toEqual([]);
    const rootOutputs = r.expr.meta?.outputs ?? [];
    const mask = rootOutputs.find((o) => o.name === "mask");
    expect(mask?.doc?.title).toBe("Brain mask");
    expect(mask?.doc?.description).toBe("The binary brain mask file.");
  });

  it("splits a doc block into title + description on the `# ` heading", () => {
    const r = parse(`tool: seq(
      /// # Short title
      ///
      /// The longer description
      /// spanning two lines.
      input: path,
      /// A description with
      ///
      /// two paragraphs but no title.
      output: path,
    )`);
    expect(r.errors).toEqual([]);
    const nodes = r.expr.kind === "sequence" ? r.expr.attrs.nodes : [];
    const input = nodes.find((n) => n.meta?.name === "input");
    const output = nodes.find((n) => n.meta?.name === "output");
    expect(input?.meta?.doc?.title).toBe("Short title");
    expect(input?.meta?.doc?.description).toBe("The longer description\nspanning two lines.");
    // No leading `# ` -> all description, even with a blank line (no title).
    expect(output?.meta?.doc?.title).toBeUndefined();
    expect(output?.meta?.doc?.description).toBe(
      "A description with\n\ntwo paragraphs but no title.",
    );
  });

  it("parses quoted labels for non-identifier names", () => {
    const r = parse(`"1deval": seq("1D": path, normal: str)`);
    expect(r.errors).toEqual([]);
    expect(r.expr.meta?.name).toBe("1deval");
    const nodes = r.expr.kind === "sequence" ? r.expr.attrs.nodes : [];
    expect(nodes.find((n) => n.meta?.name === "1D")).toBeDefined();
    expect(nodes.find((n) => n.meta?.name === "normal")).toBeDefined();
  });

  it("parses countMin/countMax including one-sided bounds", () => {
    const r = parse(`tool: seq(a: rep(int).countMin(1).countMax(4), b: rep(str).countMax(2))`);
    expect(r.errors).toEqual([]);
    const nodes = r.expr.kind === "sequence" ? r.expr.attrs.nodes : [];
    const a = nodes.find((n) => n.meta?.name === "a");
    const b = nodes.find((n) => n.meta?.name === "b");
    expect(a?.kind === "repeat" && a.attrs.countMin).toBe(1);
    expect(a?.kind === "repeat" && a.attrs.countMax).toBe(4);
    expect(b?.kind === "repeat" && b.attrs.countMin).toBeUndefined();
    expect(b?.kind === "repeat" && b.attrs.countMax).toBe(2);
  });

  it("parses scientific-notation numeric bounds", () => {
    const r = parse(`tool: seq(x: float.min(2.2e-308).max(1e5))`);
    expect(r.errors).toEqual([]);
    const nodes = r.expr.kind === "sequence" ? r.expr.attrs.nodes : [];
    const x = nodes.find((n) => n.meta?.name === "x");
    expect(x?.kind === "float" && x.attrs.minValue).toBe(2.2e-308);
    expect(x?.kind === "float" && x.attrs.maxValue).toBe(1e5);
  });

  it("parses the paths extension methods onto path attrs", () => {
    const r = parse(`tool: seq(image: path.mutable(), out: path.resolveParent())`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const nodes = r.expr.kind === "sequence" ? r.expr.attrs.nodes : [];
    const image = nodes.find((n) => n.meta?.name === "image");
    const out = nodes.find((n) => n.meta?.name === "out");
    expect(image?.kind === "path" && image.attrs.mutable).toBe(true);
    expect(out?.kind === "path" && out.attrs.resolveParent).toBe(true);
  });

  it("renames duplicate sibling names and warns", () => {
    const r = parse(`tool: seq(output: path, output: path)`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /Duplicate sibling name 'output'/.test(w.message))).toBe(true);
    const dump = format(r.expr);
    expect(dump).toContain("path [output]");
    expect(dump).toContain("path [output_2]");
  });

  it("parses-and-ignores unsupported extension methods (constraints)", () => {
    const r = parse(`tool: seq(
      a: opt("-a"),
      b: opt("-b").requires("a"),
    )`);
    // No hard error: an unimplemented extension must be ignorable.
    expect(r.errors).toEqual([]);
    expect(
      r.warnings.some((w) => /Ignoring unsupported method '\.requires\(\)'/.test(w.message)),
    ).toBe(true);
  });

  it("rejects `= default` after a method chain", () => {
    const r = parse(`tool: seq(x: int.min(1) = 80)`);
    expect(r.errors.some((e) => /only allowed on a bare terminal/.test(e.message))).toBe(true);
  });

  it("warns when `.join()` is used on an unsupported node", () => {
    const r = parse(`tool: seq(x: path.join(","))`);
    expect(r.warnings.some((w) => /only supported on seq\/set\/rep/.test(w.message))).toBe(true);
  });

  it("lowers `any` to its first branch (lossless for codegen, no warning)", () => {
    const r = parse(`tool: seq(any("--output", "-output", "-o"), path)`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const dump = format(r.expr);
    expect(dump).toContain('literal "--output"');
    expect(dump).not.toContain('literal "-output"');
  });
});

describe("argtype frontmatter", () => {
  it("parses frontmatter into AppMeta", () => {
    const r = parse(`---
exe: "bet"
version: "6.0.4"
authors:
  - "FMRIB Analysis Group"
url: "https://fsl.fmrib.ox.ac.uk"
---

/// Brain extraction.
bet: seq(infile: path)`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.id).toBe("bet");
    expect(r.meta?.version).toBe("6.0.4");
    expect(r.meta?.doc?.authors).toEqual(["FMRIB Analysis Group"]);
    expect(r.meta?.doc?.urls).toEqual(["https://fsl.fmrib.ox.ac.uk"]);
    expect(r.meta?.doc?.description).toBe("Brain extraction.");
  });

  it("keeps body line numbers aligned after frontmatter", () => {
    const r = parse(`---
exe: "x"
---
x: seq(@bad)`);
    // The error should point at line 4 (the body), not line 1.
    const loc = r.errors[0]?.location;
    expect(loc?.line).toBe(4);
  });
});

describe("argtype parser: review regressions", () => {
  it("treats .description() as canonical and .doc() as its alias", () => {
    const a = parse(`tool: seq(x: str.description("The image."))`);
    const b = parse(`tool: seq(x: str.doc("The image."))`);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    const descOf = (r: ReturnType<typeof parse>) =>
      r.expr.kind === "sequence"
        ? r.expr.attrs.nodes.find((n) => n.kind === "str")?.meta?.doc?.description
        : undefined;
    expect(descOf(a)).toBe("The image.");
    expect(descOf(b)).toBe("The image."); // alias behaves identically
  });

  it("keeps an unquoted `#` inside a frontmatter value (URL fragment)", () => {
    const r = parse(`---
url: https://fsl.fmrib.ox.ac.uk/wiki#bet
---
bet: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.doc?.urls).toEqual(["https://fsl.fmrib.ox.ac.uk/wiki#bet"]);
  });

  it("accepts an unquoted numeric version rather than dropping it", () => {
    const r = parse(`---
version: 6.0
---
bet: path`);
    expect(r.errors).toEqual([]);
    expect(r.meta?.version).toBe("6");
  });

  it("flags a malformed number whose exponent has no digits", () => {
    const r = parse(`tool: seq(x: int.min(1e))`);
    expect(r.errors.some((e) => /exponent has no digits/.test(e.message))).toBe(true);
  });

  it("parses a quoted output ref name (non-identifier target)", () => {
    const r = parse(`---
extensions:
  - outputs
---
tool: seq("4d_output": path).output(result: \`{"4d_output"}.nii\`)`);
    expect(r.errors).toEqual([]);
    const ref = r.expr.meta?.outputs?.[0]?.tokens.find((t) => t.kind === "ref");
    expect(ref?.kind === "ref" ? ref.target.name : undefined).toBe("4d_output");
  });

  it("warns on inverted value and repetition-count bounds", () => {
    const v = parse(`tool: seq(x: int.min(5).max(2))`);
    expect(v.warnings.some((w) => /Inverted value bounds/.test(w.message))).toBe(true);
    const c = parse(`tool: rep(str).countMin(5).countMax(2)`);
    expect(c.warnings.some((w) => /Inverted repetition count bounds/.test(w.message))).toBe(true);
  });

  it("ignores an unsupported output-template method with a warning, not an error", () => {
    const r = parse(`---
extensions:
  - outputs
---
tool: seq(x: path).output(result: \`{x}.nii\`.mystery("z"))`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /mystery/.test(w.message))).toBe(true);
  });
});
