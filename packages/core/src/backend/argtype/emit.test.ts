import { describe, expect, it } from "vitest";
import type { AppMeta } from "../../ir/meta.js";
import type { Expr, Path, Repeat } from "../../ir/node.js";
import { int, lit, opt, seq } from "../../ir/builders.js";
import { createContext } from "../../manifest/context.js";
import { ArgtypeParser } from "../../frontend/argtype/parser-frontend.js";
import { ArgtypeBackend } from "./argtype.js";
import { generateArgtype } from "./emit.js";

describe("argtype emitter: frontmatter", () => {
  it("emits container and stream outputs (no extensions declaration)", () => {
    const app: AppMeta = {
      id: "tool",
      version: "1.0",
      doc: { authors: ["A One", "A Two"], urls: ["https://example.org"] },
      container: { image: "docker://tool:1.0", type: "docker" },
      stdout: { name: "log", doc: { description: "stdout log" } },
    };
    const path: Path = { kind: "path", attrs: { mediaTypes: ["image/png"] }, meta: { name: "in" } };
    // The leading `tool` literal is the executable, stripped into `exe:`.
    const expr = seq(lit("tool"), path);
    expr.meta = {
      name: "tool",
      outputs: [{ name: "o", tokens: [{ kind: "literal", value: "out.png" }] }],
    };

    const { source, warnings } = generateArgtype(expr, app);
    expect(warnings).toEqual([]);
    expect(source).toContain(`exe: "tool"`);
    expect(source).toContain("container:");
    expect(source).toContain(`  image: "docker://tool:1.0"`);
    expect(source).toContain(`  type: "docker"`);
    expect(source).toContain("stdout:");
    expect(source).toContain(`  name: "log"`);
    expect(source).toContain(`  description: "stdout log"`);
    // `extensions:` is no longer emitted: the declaration was removed.
    expect(source).not.toContain("extensions:");
    expect(source).toContain(`.mediaType("image/png")`);
  });

  it("emits the app title as a root doc block and warns for truly unsupported doc fields", () => {
    const app: AppMeta = {
      id: "tool",
      doc: {
        title: "Title",
        description: "Long description.",
        literature: ["doi:1"],
        comment: "note",
        urls: ["a", "b"],
      },
    };
    const { source, warnings } = generateArgtype(seq(lit("tool")), app);
    // Title + description round-trip as a `///` block (# title, blank, description).
    expect(source).toContain("/// # Title\n///\n/// Long description.");
    // authors, urls (list), references round-trip through frontmatter.
    expect(source).toContain("urls:");
    expect(source).toContain(`  - "a"`);
    expect(source).toContain(`  - "b"`);
    expect(source).toContain("references:");
    expect(source).toContain(`  - "doi:1"`);
    const messages = warnings.map((w) => w.message).join("\n");
    // title / literature / urls are all now representable; only `comment` isn't.
    expect(messages).not.toContain("title");
    expect(messages).not.toContain("literature");
    expect(messages).not.toContain("url");
    expect(messages).toContain("comment");
  });
});

describe("argtype emitter: IR features with no surface", () => {
  it("emits mutable / resolveParent as the paths extension and round-trips", () => {
    const path: Path = {
      kind: "path",
      attrs: { mutable: true, resolveParent: true },
      meta: { name: "workdir" },
    };
    const expr = seq(lit("tool"), path);
    expr.meta = { name: "tool" };
    const { source, warnings } = generateArgtype(expr, { id: "tool" });
    expect(warnings).toEqual([]);
    expect(source).toContain("workdir: path.mutable().resolveParent()");
    // Round-trips: re-parsing recovers the same path attrs.
    const reparsed = new ArgtypeParser().parse(source);
    expect(reparsed.errors).toEqual([]);
    const seqNode = reparsed.expr;
    const pathNode =
      seqNode.kind === "sequence" ? seqNode.attrs.nodes.find((n) => n.kind === "path") : undefined;
    expect(pathNode?.kind === "path" && pathNode.attrs.mutable).toBe(true);
    expect(pathNode?.kind === "path" && pathNode.attrs.resolveParent).toBe(true);
  });

  it("emits a one-sided repeat count via countMin/countMax", () => {
    const rep: Repeat = {
      kind: "repeat",
      attrs: { node: { kind: "int", attrs: {} }, countMax: 2 },
      meta: { name: "vals" },
    };
    const { source, warnings } = generateArgtype(seq(lit("tool"), rep), { id: "tool" });
    expect(source).toContain("rep(int).countMax(2)");
    expect(source).not.toContain(".count(");
    expect(warnings).toEqual([]);
  });
});

describe("argtype emitter: micro-syntax and counts", () => {
  it("emits .join() for an empty separator and .count(n) for a fixed count", () => {
    const rep: Repeat = {
      kind: "repeat",
      attrs: { node: { kind: "float", attrs: {} }, countMin: 3, countMax: 3 },
      meta: { name: "coord" },
    };
    const joined = seq(lit("--x="), { kind: "int", attrs: {} });
    joined.attrs.join = "";
    const expr = seq(joined, rep);
    expr.meta = { name: "tool" };
    const { source } = generateArgtype(expr, { id: "tool" });
    expect(source).toContain(".join()");
    expect(source).toContain(".count(3)");
  });
});

describe("argtype emitter: name/ref consistency and escaping", () => {
  it("emits a non-identifier output ref as a quoted name matching its quoted label", () => {
    // A Boutiques-style id with a dash is not a valid identifier; the label and
    // the template `{ref}` are both quoted (verbatim), so the ref still resolves
    // and the name survives the round-trip exactly (no lossy sanitization).
    const path: Path = { kind: "path", attrs: {}, meta: { name: "out-file" } };
    const expr = seq(lit("tool"), path);
    expr.meta = {
      name: "tool",
      outputs: [
        {
          name: "result",
          tokens: [{ kind: "ref", target: { kind: "node-ref", name: "out-file" } }],
        },
      ],
    };
    const { source, warnings } = generateArgtype(expr, { id: "tool" });
    expect(warnings).toEqual([]); // quoted, not sanitized -> no rename warning
    expect(source).toContain(`"out-file": path`);
    expect(source).toContain('`{"out-file"}`');
    // The exact dashed name survives re-parse on both the node and the ref.
    const r = new ArgtypeParser().parse(source);
    expect(r.errors).toEqual([]);
    const inner =
      r.expr.kind === "sequence" ? r.expr.attrs.nodes.find((n) => n.kind === "path") : undefined;
    expect(inner?.meta?.name).toBe("out-file");
    const output = r.expr.meta?.outputs?.[0];
    const ref = output?.tokens.find((t) => t.kind === "ref");
    expect(ref?.kind === "ref" ? ref.target.name : undefined).toBe("out-file");
  });

  it("quotes non-identifier names as quoted labels and round-trips them exactly", () => {
    const flag: Path = { kind: "path", attrs: {}, meta: { name: "1D" } };
    const expr = seq(lit("1deval"), flag);
    expr.meta = { name: "1deval" };
    const { source, warnings } = generateArgtype(expr, { id: "1deval" });
    expect(warnings).toEqual([]); // quoted, not sanitized -> no rename warning
    expect(source).toContain(`"1deval": seq(`);
    expect(source).toContain(`"1D": path`);
    // Names survive the round-trip exactly (no `_1D` sanitization).
    const r = new ArgtypeParser().parse(source);
    expect(r.errors).toEqual([]);
    expect(r.expr.meta?.name).toBe("1deval");
    const inner =
      r.expr.kind === "sequence" ? r.expr.attrs.nodes.find((n) => n.kind === "path") : undefined;
    expect(inner?.meta?.name).toBe("1D");
  });

  it("escapes literal braces/backticks in an output path and round-trips them", () => {
    const expr = seq(lit("tool"));
    expr.meta = {
      name: "tool",
      outputs: [{ name: "o", tokens: [{ kind: "literal", value: "{OUT_DIR}/a`b.txt" }] }],
    };
    const { source, warnings } = generateArgtype(expr, { id: "tool" });
    expect(warnings).toEqual([]);
    expect(source).toContain("\\{OUT_DIR\\}/a\\`b.txt");
    // Re-parsing recovers the exact literal path (braces/backtick are literal).
    const r = new ArgtypeParser().parse(source);
    expect(r.errors).toEqual([]);
    const out = r.expr.meta?.outputs?.find((o) => o.name === "o");
    expect(out?.tokens).toEqual([{ kind: "literal", value: "{OUT_DIR}/a`b.txt" }]);
  });

  it("round-trips a frontmatter value containing a quote", () => {
    const expr = seq(lit("tool"));
    expr.meta = { name: "tool" };
    const { source, warnings } = generateArgtype(expr, { id: "tool", version: 'v"1' });
    expect(warnings).toEqual([]);
    const r = new ArgtypeParser().parse(source);
    expect(r.errors).toEqual([]);
    expect(r.meta?.version).toBe('v"1');
  });

  it("warns for a divergent union discriminator", () => {
    const armA = seq(lit("a"));
    armA.meta = { name: "alpha", variantTag: "AlphaVariant" };
    const armB = seq(lit("b"));
    armB.meta = { name: "beta" };
    const alt: Expr = {
      kind: "alternative",
      attrs: { alts: [armA, armB] },
      meta: { name: "mode" },
    };
    const expr = seq(lit("tool"), alt);
    expr.meta = { name: "tool" };
    const { warnings } = generateArgtype(expr, { id: "tool" });
    const messages = warnings.map((w) => w.message).join("\n");
    expect(messages).toContain("AlphaVariant"); // variantTag != name warned
  });
});

describe("ArgtypeBackend", () => {
  function stubCtx(app: { id: string }) {
    const expr: Expr = seq(lit(app.id), opt(lit("-v"), "verbose"));
    expr.meta = { name: app.id };
    // The argtype backend only reads ctx.expr + ctx.app; the solver fields are
    // unused, so a minimal stub context is enough to exercise emitApp.
    return createContext(
      expr,
      { bindings: new Map(), resolve: () => undefined } as never,
      { scopes: [], diagnostics: { errors: [], warnings: [] } } as never,
      { app },
    );
  }

  it("emits a descriptor.argtype file from a CodegenContext", () => {
    const result = new ArgtypeBackend().emitApp(stubCtx({ id: "tool" }));
    expect(result.errors).toEqual([]);
    const file = result.files.get("descriptor.argtype");
    expect(file).toBeDefined();
    expect(file).toContain("tool: seq(");
    expect(file).toContain(`verbose: opt("-v")`);
  });

  it("uses per-tool file stems within a package scope so co-located tools don't collide", () => {
    const backend = new ArgtypeBackend();
    const scope = backend.newPackageScope();
    const a = backend.emitApp(stubCtx({ id: "greet" }), scope);
    const b = backend.emitApp(stubCtx({ id: "farewell" }), scope);
    expect([...a.files.keys()]).toEqual(["greet.argtype"]);
    expect([...b.files.keys()]).toEqual(["farewell.argtype"]);
  });
});

describe("argtype emitter: doc round-trip and non-finite numbers", () => {
  const innerPath = (r: ReturnType<ArgtypeParser["parse"]>) =>
    r.expr.kind === "sequence" ? r.expr.attrs.nodes.find((n) => n.kind === "path") : undefined;

  it("emits a title-less `# ...` description as chaining so it is not promoted to a title", () => {
    const p: Path = {
      kind: "path",
      attrs: {},
      meta: { name: "in", doc: { description: "# leading hash\nmore text" } },
    };
    const expr = seq(lit("tool"), p);
    expr.meta = { name: "tool" };
    const { source } = generateArgtype(expr);
    // Chaining (verbatim), not a `///` block that would re-read `# ...` as a title.
    expect(source).toContain(`.description(`);
    const r = new ArgtypeParser().parse(source);
    expect(r.errors).toEqual([]);
    expect(innerPath(r)?.meta?.doc?.description).toBe("# leading hash\nmore text");
    expect(innerPath(r)?.meta?.doc?.title).toBeUndefined();
  });

  it("emits a multi-line title as chaining so all lines survive", () => {
    const p: Path = {
      kind: "path",
      attrs: {},
      meta: { name: "in", doc: { title: "Line one\nLine two", description: "body" } },
    };
    const expr = seq(lit("tool"), p);
    expr.meta = { name: "tool" };
    const { source } = generateArgtype(expr);
    expect(source).toContain(`.title(`);
    const r = new ArgtypeParser().parse(source);
    expect(r.errors).toEqual([]);
    expect(innerPath(r)?.meta?.doc?.title).toBe("Line one\nLine two");
    expect(innerPath(r)?.meta?.doc?.description).toBe("body");
  });

  it("round-trips an output-entry `# ...` description via chaining, not a `///` block", () => {
    const p: Path = { kind: "path", attrs: {}, meta: { name: "x" } };
    const expr = seq(lit("tool"), p);
    expr.meta = {
      name: "tool",
      outputs: [
        {
          name: "mask",
          doc: { description: "# produced\nthe mask file" },
          tokens: [
            { kind: "literal", value: "" },
            { kind: "ref", target: { kind: "node-ref", name: "x" } },
            { kind: "literal", value: ".nii" },
          ],
        },
      ],
    };
    const { source } = generateArgtype(expr);
    const r = new ArgtypeParser().parse(source);
    expect(r.errors).toEqual([]);
    const out = r.expr.meta?.outputs?.[0];
    expect(out?.doc?.description).toBe("# produced\nthe mask file");
    expect(out?.doc?.title).toBeUndefined();
  });

  it("drops a non-finite value bound with a warning instead of emitting an un-parseable token", () => {
    const n = int();
    n.attrs.maxValue = Infinity;
    n.meta = { name: "n" };
    const expr = seq(lit("tool"), n);
    expr.meta = { name: "tool" };
    const { source, warnings } = generateArgtype(expr);
    expect(source).not.toContain("Infinity");
    expect(warnings.some((w) => /Non-finite/.test(w.message))).toBe(true);
    expect(new ArgtypeParser().parse(source).errors).toEqual([]);
  });
});

describe("argtype emitter: description reflow", () => {
  const parser = new ArgtypeParser();
  const descOf = (e: Expr, name: string): string | undefined =>
    (e.kind === "sequence" ? e.attrs.nodes : []).find((n) => n.meta?.name === name)?.meta?.doc
      ?.description;

  it("wraps a long single-paragraph description across `///` lines and round-trips", () => {
    const long =
      "This is a fairly long single-paragraph description that must wrap across " +
      "several `///` lines when emitted, rather than sitting on one giant physical line.";
    const first = parser.parse(`tool: seq(x: str.description(${JSON.stringify(long)}))`);
    const { source } = generateArgtype(first.expr, first.meta);

    const docLines = source.split("\n").filter((l) => l.trim().startsWith("///"));
    expect(docLines.length).toBeGreaterThan(1); // actually wrapped
    // No emitted `///` content line runs away (prefix + ~80 content).
    for (const l of docLines) expect(l.trim().length).toBeLessThanOrEqual(90);

    const second = parser.parse(source);
    expect(second.errors).toEqual([]);
    expect(descOf(second.expr, "x")).toBe(long); // reflow rejoins to the original prose
  });

  it("keeps a blank `///` between paragraphs and round-trips exactly", () => {
    const src = `tool: seq(
      /// First paragraph, wrapped
      /// over two source lines.
      ///
      /// Second paragraph.
      x: str,
    )`;
    const first = parser.parse(src);
    const { source } = generateArgtype(first.expr, first.meta);
    expect(source).toMatch(/\/\/\/ First paragraph[\s\S]*\n\s*\/\/\/\n\s*\/\/\/ Second paragraph/);

    const second = parser.parse(source);
    expect(second.errors).toEqual([]);
    expect(descOf(second.expr, "x")).toBe(
      "First paragraph, wrapped over two source lines.\n\nSecond paragraph.",
    );
  });

  it("emits a hard line break (lone `\\n`) as verbatim `.description()` chaining", () => {
    // A lone \n would be reflowed to a space by a `///` block, so it must round-trip
    // as chaining instead.
    const first = parser.parse(`tool: seq(x: str.description("line one\\nline two"))`);
    expect(descOf(first.expr, "x")).toBe("line one\nline two");
    const { source } = generateArgtype(first.expr, first.meta);
    expect(source).toContain(`.description("line one\\nline two")`);
    expect(source).not.toMatch(/\/\/\/ line one/); // not a `///` block

    const second = parser.parse(source);
    expect(second.errors).toEqual([]);
    expect(descOf(second.expr, "x")).toBe("line one\nline two"); // preserved exactly
  });
});
