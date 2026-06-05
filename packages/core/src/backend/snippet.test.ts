import { describe, expect, it } from "vitest";
import {
  alt,
  float,
  generateCtx,
  int,
  lit,
  namedAlt,
  opt,
  path,
  rep,
  seq,
  str,
} from "./python/test-helpers.js";
import { renderPythonCall } from "./python/snippet.js";
import { renderTypeScriptCall } from "./typescript/snippet.js";
import { generatePython } from "./python/python.js";
import { generateTypeScript } from "./typescript/typescript.js";

// A small struct-rooted tool: a required path, an optional float, and a
// defaulted flag. Used across both languages.
const betExpr = seq(
  lit("bet"),
  path("infile"),
  opt(seq(lit("-f"), float("frac"))),
  opt(seq(lit("-m")), { name: "mask", defaultValue: false }),
);
const betOpts = { app: { id: "bet" }, package: { name: "fsl" } };
const betConfig = {
  "@type": "fsl/bet",
  infile: "/data/t1.nii",
  frac: 0.5,
  mask: true,
};

describe("renderPythonCall - struct root (kwarg wrapper)", () => {
  it("renders a kwarg call with the package import", () => {
    const ctx = generateCtx(betExpr, betOpts);
    expect(renderPythonCall(ctx, betConfig)).toBe(
      [
        "import fsl",
        "",
        "fsl.bet(",
        '    infile="/data/t1.nii",',
        "    frac=0.5,",
        "    mask=True,",
        ")",
      ].join("\n"),
    );
  });

  it("uses `from <root> import <pkg>` when a package root is given", () => {
    const ctx = generateCtx(betExpr, betOpts);
    const code = renderPythonCall(ctx, betConfig, { packageRoot: "niwrap" });
    expect(code.startsWith("from niwrap import fsl\n\nfsl.bet(")).toBe(true);
  });

  it("omits the import when includeImport is false", () => {
    const ctx = generateCtx(betExpr, betOpts);
    const code = renderPythonCall(ctx, betConfig, { includeImport: false });
    expect(code.startsWith("fsl.bet(")).toBe(true);
    expect(code).not.toContain("import");
  });

  it("renders only the fields present in the config", () => {
    const ctx = generateCtx(betExpr, betOpts);
    const code = renderPythonCall(ctx, { "@type": "fsl/bet", infile: "/x" });
    expect(code).toContain("infile=");
    expect(code).not.toContain("frac=");
    expect(code).not.toContain("mask=");
  });

  it("emits an empty call when no user fields are set", () => {
    const ctx = generateCtx(seq(lit("t"), opt(str("x"))), {
      app: { id: "t" },
      package: { name: "p" },
    });
    expect(renderPythonCall(ctx, { "@type": "p/t" }, { includeImport: false })).toBe("p.t()");
  });
});

describe("renderPythonCall - host-name scrubbing", () => {
  it("uses the scrubbed kwarg name (float -> float_), not the wire key", () => {
    // The field is literally named `float` (a Python builtin); the wrapper's
    // keyword arg is `float_`, but the config is keyed by the wire name `float`.
    const ctx = generateCtx(seq(lit("t"), float("float")), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const code = renderPythonCall(ctx, { "@type": "p/t", float: 1.5 }, { includeImport: false });
    expect(code).toBe(["p.t(", "    float_=1.5,", ")"].join("\n"));
  });
});

describe("renderPythonCall - nested / union / list", () => {
  it("renders a nested struct as a dict literal keyed by wire names", () => {
    const ctx = generateCtx(
      seq(lit("t"), opt(seq(lit("--bounds"), int("min"), int("max")), { name: "bounds" })),
      { app: { id: "t" }, package: { name: "p" } },
    );
    const code = renderPythonCall(
      ctx,
      { "@type": "p/t", bounds: { min: 1, max: 10 } },
      { includeImport: false },
    );
    expect(code).toBe(
      ["p.t(", "    bounds={", '        "min": 1,', '        "max": 10,', "    },", ")"].join("\n"),
    );
  });

  it("renders a discriminated union variant as a dict literal with its @type", () => {
    const ctx = generateCtx(
      seq(
        lit("t"),
        namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url"))),
      ),
      { app: { id: "t" }, package: { name: "p" } },
    );
    const code = renderPythonCall(
      ctx,
      { "@type": "p/t", source: { "@type": "variant_0", file: "/data/x" } },
      { includeImport: false },
    );
    expect(code).toContain("source={");
    expect(code).toContain('"@type": "variant_0",');
    expect(code).toContain('"file": "/data/x",');
  });

  it("renders a list of structs, one object literal per element", () => {
    const ctx = generateCtx(seq(lit("t"), rep(seq(str("name"), int("value")), "items")), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const code = renderPythonCall(
      ctx,
      {
        "@type": "p/t",
        items: [
          { name: "a", value: 1 },
          { name: "b", value: 2 },
        ],
      },
      { includeImport: false },
    );
    expect(code).toBe(
      [
        "p.t(",
        "    items=[",
        "        {",
        '            "name": "a",',
        '            "value": 1,',
        "        },",
        "        {",
        '            "name": "b",',
        '            "value": 2,',
        "        },",
        "    ],",
        ")",
      ].join("\n"),
    );
  });

  it("renders a list of primitives inline", () => {
    const ctx = generateCtx(seq(lit("t"), rep(int("dim"), "dims")), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const code = renderPythonCall(
      ctx,
      { "@type": "p/t", dims: [1, 2, 3] },
      { includeImport: false },
    );
    expect(code).toBe(["p.t(", "    dims=[1, 2, 3],", ")"].join("\n"));
  });

  it("renders an explicitly-null optional struct/list field as None, not {}/[]", () => {
    // A form may emit `null` for an unset optional rather than omitting the key;
    // coercing that into an empty literal would be a value the generated code
    // rejects (a struct missing required keys / a non-list).
    const ctx = generateCtx(
      seq(
        lit("t"),
        opt(seq(lit("--b"), int("min"), int("max")), { name: "bounds" }),
        opt(seq(lit("-c"), rep(int("d"), "dims"))),
      ),
      { app: { id: "t" }, package: { name: "p" } },
    );
    const code = renderPythonCall(
      ctx,
      { "@type": "p/t", bounds: null, dims: null },
      { includeImport: false },
    );
    expect(code).toBe(["p.t(", "    bounds=None,", "    dims=None,", ")"].join("\n"));
  });
});

describe("renderPythonCall - union root", () => {
  it("calls the dict-style wrapper with a single object-literal argument", () => {
    // A root-level alternative solves to a union root (no kwarg wrapper).
    const ctx = generateCtx(alt(seq(lit("a"), str("x")), seq(lit("b"), str("y"))), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const code = renderPythonCall(
      ctx,
      { "@type": "variant_0", x: "hello" },
      { includeImport: false },
    );
    expect(code).toBe(["p.t({", '    "@type": "variant_0",', '    "x": "hello",', "})"].join("\n"));
  });
});

describe("renderTypeScriptCall - struct root (execute object)", () => {
  it("renders an execute call with the params object and an import", () => {
    const ctx = generateCtx(betExpr, betOpts);
    expect(renderTypeScriptCall(ctx, betConfig)).toBe(
      [
        'import { fsl } from "niwrap";',
        "",
        "fsl.betExecute({",
        '  "@type": "fsl/bet",',
        '  infile: "/data/t1.nii",',
        "  frac: 0.5,",
        "  mask: true,",
        "})",
      ].join("\n"),
    );
  });

  it("uses wire keys (not scrubbed host names) for object keys", () => {
    const ctx = generateCtx(seq(lit("t"), float("float")), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const code = renderTypeScriptCall(
      ctx,
      { "@type": "p/t", float: 1.5 },
      { includeImport: false },
    );
    expect(code).toContain("float: 1.5,");
    expect(code).not.toContain("float_");
  });

  it("respects packageRoot and includeImport", () => {
    const ctx = generateCtx(betExpr, betOpts);
    expect(renderTypeScriptCall(ctx, betConfig, { packageRoot: "@niwrap/all" })).toContain(
      'import { fsl } from "@niwrap/all";',
    );
    expect(
      renderTypeScriptCall(ctx, betConfig, { includeImport: false }).startsWith("fsl.betExecute("),
    ).toBe(true);
  });
});

describe("renderTypeScriptCall - nested / union / list", () => {
  it("renders a nested struct as an object literal keyed by wire names", () => {
    const ctx = generateCtx(
      seq(lit("t"), opt(seq(lit("--bounds"), int("min"), int("max")), { name: "bounds" })),
      { app: { id: "t" }, package: { name: "p" } },
    );
    const code = renderTypeScriptCall(
      ctx,
      { "@type": "p/t", bounds: { min: 1, max: 10 } },
      { includeImport: false },
    );
    expect(code).toBe(
      [
        "p.tExecute({",
        '  "@type": "p/t",',
        "  bounds: {",
        "    min: 1,",
        "    max: 10,",
        "  },",
        "})",
      ].join("\n"),
    );
  });

  it("renders a discriminated union variant with its @type", () => {
    const ctx = generateCtx(
      seq(
        lit("t"),
        namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url"))),
      ),
      { app: { id: "t" }, package: { name: "p" } },
    );
    const code = renderTypeScriptCall(
      ctx,
      { "@type": "p/t", source: { "@type": "variant_1", url: "http://x" } },
      { includeImport: false },
    );
    expect(code).toContain("source: {");
    expect(code).toContain('"@type": "variant_1",');
    expect(code).toContain('url: "http://x",');
  });

  it("renders a list of structs", () => {
    const ctx = generateCtx(seq(lit("t"), rep(seq(str("name"), int("value")), "items")), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const code = renderTypeScriptCall(
      ctx,
      { "@type": "p/t", items: [{ name: "a", value: 1 }] },
      { includeImport: false },
    );
    expect(code).toContain("items: [");
    expect(code).toContain("    {");
    expect(code).toContain('      name: "a",');
    expect(code).toContain("      value: 1,");
  });

  it("renders an explicitly-null optional struct/list field as null, not {}/[]", () => {
    const ctx = generateCtx(
      seq(
        lit("t"),
        opt(seq(lit("--b"), int("min"), int("max")), { name: "bounds" }),
        opt(seq(lit("-c"), rep(int("d"), "dims"))),
      ),
      { app: { id: "t" }, package: { name: "p" } },
    );
    const code = renderTypeScriptCall(
      ctx,
      { "@type": "p/t", bounds: null, dims: null },
      { includeImport: false },
    );
    expect(code).toBe(
      ["p.tExecute({", '  "@type": "p/t",', "  bounds: null,", "  dims: null,", "})"].join("\n"),
    );
  });
});

describe("renderTypeScriptCall - union root", () => {
  it("calls the dict-style wrapper with a single object-literal argument", () => {
    const ctx = generateCtx(alt(seq(lit("a"), str("x")), seq(lit("b"), str("y"))), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const code = renderTypeScriptCall(
      ctx,
      { "@type": "variant_0", x: "hello" },
      { includeImport: false },
    );
    expect(code).toBe(["p.t({", '  "@type": "variant_0",', '  x: "hello",', "})"].join("\n"));
  });
});

describe("snippet/codegen lockstep", () => {
  // The snippet must call a function the generated module actually exports - the
  // whole point of deriving names from the same buildEmitModel the emitter uses.
  it("Python snippet calls the wrapper the module defines (struct root)", () => {
    const ctx = generateCtx(betExpr, betOpts);
    const call = renderPythonCall(ctx, betConfig, { includeImport: false });
    expect(call.startsWith("fsl.bet(")).toBe(true);
    expect(generatePython(ctx)).toContain("def bet(");
  });

  it("TypeScript snippet calls the *Execute the module defines (struct root)", () => {
    const ctx = generateCtx(betExpr, betOpts);
    const call = renderTypeScriptCall(ctx, betConfig, { includeImport: false });
    expect(call.startsWith("fsl.betExecute(")).toBe(true);
    expect(generateTypeScript(ctx)).toContain("export function betExecute(");
  });

  it("both snippets call the same dict-style wrapper for a union root", () => {
    const ctx = generateCtx(alt(seq(lit("a"), str("x")), seq(lit("b"), str("y"))), {
      app: { id: "t" },
      package: { name: "p" },
    });
    const cfg = { "@type": "variant_0", x: "hello" };
    expect(renderPythonCall(ctx, cfg, { includeImport: false }).startsWith("p.t(")).toBe(true);
    expect(renderTypeScriptCall(ctx, cfg, { includeImport: false }).startsWith("p.t(")).toBe(true);
    // Union root: the user-facing wrapper IS the dict-style entry (no *Execute).
    expect(generateTypeScript(ctx)).toContain("export function t(params:");
    expect(generatePython(ctx)).toContain("def t(params:");
  });
});
