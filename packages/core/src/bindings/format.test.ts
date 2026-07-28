import { describe, expect, it } from "vitest";
import { alt, float, lit, nodeRef, opt, path, rep, seq, str } from "../ir/index.js";
import { resolveOutputs, solve } from "../solver/index.js";
import { formatSolveResult } from "./format.js";

/** The body of one `header:` block, blank lines dropped. */
function section(text: string, header: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(header);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.length > 0 && !l.startsWith(" "));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim().length > 0);
}

/**
 * The display name each row declares, with the ` [arm]` marker stripped - the
 * name alone is what `ref(...)` and `<iter:...>` resolve against, so that is
 * what has to be unique.
 */
function rowNames(text: string): string[] {
  return section(text, "bindings:").map((l) =>
    l
      .trim()
      .split(":")[0]!
      .replace(/\s*\[.*$/, ""),
  );
}

function dump(root: Parameters<typeof solve>[0]): string {
  const result = solve(root);
  const resolution = resolveOutputs(root, result);
  return formatSolveResult(result, root, {
    scopes: resolution.scopes,
    diagnostics: resolution.diagnostics,
  });
}

describe("formatSolveResult", () => {
  it("renders the root binding alongside resolved outputs", () => {
    const host = opt(path("input"));
    const root = seq(lit("cmd"), host);
    root.meta = {
      outputs: [
        {
          name: "out",
          tokens: [
            { kind: "ref", target: nodeRef("input") },
            { kind: "literal", value: ".out" },
          ],
        },
      ],
    };
    const text = dump(root);
    expect(text).toContain("outputs:");
    expect(text).toContain('out [optional]: ref(input#flag) + ".out" when (present(input#flag))');
  });

  it("renders a variant gate for an output declared inside an alt arm", () => {
    const armA = seq(lit("--a"), path("a"));
    armA.meta = {
      name: "alpha",
      outputs: [{ name: "out", tokens: [{ kind: "ref", target: nodeRef("a") }] }],
    };
    const armB = seq(lit("--b"), path("b"));
    armB.meta = { name: "beta" };
    expect(dump(seq(lit("cmd"), alt(armA, armB)))).toMatch(/out \[optional\]:.*\w+=alpha/);
  });

  it("emits a diagnostics section when validation reports issues", () => {
    const root = seq(lit("cmd"));
    root.meta = {
      outputs: [{ name: "out", tokens: [{ kind: "ref", target: nodeRef("does_not_exist") }] }],
    };
    const result = solve(root);
    const resolution = resolveOutputs(root, result);
    const text = formatSolveResult(result, root, {
      scopes: resolution.scopes,
      diagnostics: resolution.diagnostics,
    });
    if (resolution.diagnostics.errors.length || resolution.diagnostics.warnings.length) {
      expect(text).toContain("diagnostics:");
    }
  });

  it("stacks the wrapper layers one parameter expands into", () => {
    // `-c` binds three layers all named `center_of_gravity` - the presence
    // flag, the list, and the element - and the flag and list even share an
    // access path (wrapper collapse), so only the qualifier separates them.
    const root = seq(
      lit("cmd"),
      opt(seq(lit("-c"), rep(float("center_of_gravity")))),
      opt(seq(lit("-f"), float("f"))),
    );
    expect(section(dump(root), "bindings:")).toEqual([
      "  center_of_gravity#flag: params.center_of_gravity",
      "    center_of_gravity#list: params.center_of_gravity",
      "      center_of_gravity#element: <iter:center_of_gravity#list>",
      "  f#flag: params.f",
      "    f#value: params.f",
    ]);
  });

  it("qualifies wrapper layers by their bound node, not by gate depth", () => {
    // The same `-c` nested under an outer optional: its gate is no longer bare,
    // but it is still the presence flag. The counter follows layout order, so
    // the outer flag reads before the inner one.
    const root = seq(
      lit("cmd"),
      opt(seq(lit("-g"), opt(seq(lit("-c"), rep(float("cog")))), path("ref"))),
    );
    expect(section(dump(root), "bindings:")).toEqual([
      "  cog#flag: params.cog",
      "    cog#flag2: params.cog.cog",
      "      cog#list: params.cog.cog",
      "        cog#element: <iter:cog#list>",
      "    ref: params.cog.ref",
      "    struct1: params.cog",
    ]);
  });

  it("qualifies co-named leaves by their union arm and tags the rest", () => {
    const armA = seq(lit("--a"), path("a"), str("x"));
    armA.meta = {
      name: "alpha",
      outputs: [{ name: "o", tokens: [{ kind: "ref", target: nodeRef("a") }] }],
    };
    const armB = seq(lit("--b"), path("b"), str("x"));
    armB.meta = { name: "beta" };
    const text = dump(seq(lit("cmd"), rep(alt(armA, armB), "mode")));

    expect(section(text, "bindings:")).toEqual([
      "  mode#list: params.mode",
      "    mode#union: <iter:mode#list>",
      "      a [alpha]: <iter:mode#list>.a",
      "      x#alpha: <iter:mode#list>.x",
      // The arm's own binding is named for the arm; no `[alpha]` on top.
      "      alpha: <iter:mode#list>",
      "      b [beta]: <iter:mode#list>.b",
      "      x#beta: <iter:mode#list>.x",
      "      beta: <iter:mode#list>",
    ]);
    // The scope header and every ref name a row that exists exactly once.
    expect(section(text, "outputs:")).toEqual([
      "  on alpha:",
      "    o [optional]: ref(a) when (iter(mode#list) AND mode#union=alpha)",
    ]);
  });

  it("gives every binding a name no other binding answers to", () => {
    const armA = seq(lit("--a"), opt(rep(float("v"))), str("shared"));
    armA.meta = { name: "alpha" };
    const armB = seq(lit("--b"), opt(rep(float("v"))), str("shared"));
    armB.meta = { name: "beta" };
    const root = seq(
      lit("cmd"),
      opt(seq(lit("-c"), rep(float("v")))),
      rep(alt(armA, armB), "mode"),
    );
    const names = rowNames(dump(root));
    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps names unique when a descriptor name already looks qualified", () => {
    // Boutiques input ids reach `meta.name` verbatim, so a name that collides
    // with what the qualifier would mint is reachable from a real descriptor.
    const root = seq(
      lit("cmd"),
      opt(seq(lit("-a"), float("x"))),
      opt(seq(lit("-b"), float("x"))),
      float("x#flag2"),
    );
    const names = rowNames(dump(root));
    expect(names).toContain("x#flag2");
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps names unique when a union arm is named like a tie-break counter", () => {
    const armA = seq(lit("--a"), str("x"), str("x"));
    armA.meta = { name: "alpha" };
    const armB = seq(lit("--b"), str("x"));
    armB.meta = { name: "alpha2" };
    const names = rowNames(dump(seq(lit("cmd"), alt(armA, armB))));
    expect(names).toContain("x#alpha");
    expect(new Set(names).size).toBe(names.length);
  });

  it("calls a repeat that nothing loops over a count, even as a union arm", () => {
    // The solver retypes an arm binding to its boxed variant struct, so the
    // repeat's own `count` type is gone by the time the dump runs.
    const root = seq(lit("cmd"), alt(rep(lit("-v"), "q"), str("q")), float("q"));
    expect(rowNames(dump(root))).toContain("q#count");
  });

  it("omits the outputs section when nothing is attached", () => {
    const text = dump(seq(lit("cmd"), path("input")));
    expect(text).not.toContain("outputs:");
    // Guard the assertion above: the dump is otherwise fully rendered.
    expect(text).toContain("bindings:");
  });
});
