import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Expr, Float, Int, Path, Repeat } from "../../ir/index.js";
import {
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
} from "../python/test-helpers.js";
import type { TypedSpec } from "../typed-spec.js";
import { emitPydraTask } from "./emit.js";
import { generatePydra, PydraBackend, pydraNames } from "./pydra.js";

// -- IR construction helpers --

function intRange(name: string, min?: number, max?: number): Int {
  const n = int(name);
  if (min !== undefined) n.attrs.minValue = min;
  if (max !== undefined) n.attrs.maxValue = max;
  return n;
}
function floatRange(name: string, min?: number, max?: number): Float {
  const n = float(name);
  if (min !== undefined) n.attrs.minValue = min;
  if (max !== undefined) n.attrs.maxValue = max;
  return n;
}
function listCount(node: Expr, name: string, min?: number, max?: number): Repeat {
  const r = rep(node, name);
  if (min !== undefined) r.attrs.countMin = min;
  if (max !== undefined) r.attrs.countMax = max;
  return r;
}
function pathMedia(name: string, doc: string, types: string[]): Path {
  const n = path({ name, doc: { description: doc } });
  n.attrs.mediaTypes = types;
  return n;
}
function withDefault<T extends Expr>(node: T, dv: string | number | boolean): T {
  node.meta = { ...node.meta, defaultValue: dv };
  return node;
}

/** A bet-shaped tool exercising every rich type feature. */
function betExpr(): Expr {
  return seq(
    lit("bet"),
    pathMedia("infile", "Input image", ["image/nifti"]),
    intRange("iters", 1, 100),
    namedAlt("mode", lit("fast"), lit("robust")),
    withDefault(floatRange("frac", 0, 1), 0.5),
    opt(lit("-v"), { name: "verbose", defaultValue: false }),
    opt(seq(lit("-c"), listCount(int("center"), "center", 3, 3))),
  );
}
function bet(): string {
  return generatePydra(generateCtx(betExpr(), { app: { id: "bet" }, package: { name: "fsl" } }));
}

describe("pydra task - module shape", () => {
  it("imports the compose API, fileformats, attrs, typing, and the wrapper", () => {
    const code = bet();
    expect(code).toContain("from pydra.compose import python");
    expect(code).toContain("from fileformats.generic import Directory, File");
    expect(code).toContain("import attrs.validators");
    expect(code).toContain("import typing as ty");
    expect(code).toContain("from ._bet import bet");
    expect(code).toContain("@python.define(");
  });
});

describe("pydra inputs - rich python.arg fields", () => {
  it("maps a path with media types to File (mandatory = no default)", () => {
    expect(bet()).toContain(
      '"infile": python.arg(type=File, help="Input image (media types: image/nifti)"),',
    );
  });

  it("enforces a numeric range via a NOTHING-guarded attrs validator (mandatory int)", () => {
    expect(bet()).toContain(
      '"iters": python.arg(type=int, validator=_styx_optional(attrs.validators.and_(attrs.validators.ge(1), attrs.validators.le(100)))),',
    );
  });

  it("carries a float default alongside its range validator", () => {
    expect(bet()).toContain(
      '"frac": python.arg(type=float, default=0.5, validator=_styx_optional(attrs.validators.and_(attrs.validators.ge(0), attrs.validators.le(1)))),',
    );
  });

  it("maps a flag to a defaulted bool", () => {
    expect(bet()).toContain('"verbose": python.arg(type=bool, default=False),');
  });

  it("maps an enum to allowed_values", () => {
    expect(bet()).toContain('"mode": python.arg(type=str, allowed_values=["fast", "robust"]),');
  });

  it("wraps an optional list in ty.Optional + a guarded length validator", () => {
    expect(bet()).toContain(
      '"center": python.arg(type=ty.Optional[list[int]], default=None, validator=_styx_optional(attrs.validators.and_(attrs.validators.min_len(3), attrs.validators.max_len(3)))),',
    );
  });

  it("emits the NOTHING/None-guard helper when validators are present", () => {
    const code = bet();
    expect(code).toContain("def _styx_optional(validator):");
    expect(code).toContain("if value is attrs.NOTHING or value is None:");
  });
});

describe("pydra outputs + delegation", () => {
  it("declares the synthetic root output as a Directory", () => {
    expect(bet()).toContain('"root": python.out(type=Directory),');
  });

  it("delegates to the styx wrapper and returns the mapped result", () => {
    const code = bet();
    expect(code).toContain("def Bet(");
    expect(code).toContain("result = bet(");
    expect(code).toContain("return result.root");
  });

  it("converts file inputs to a styxdefs-accepted path at the wrapper boundary", () => {
    const code = bet();
    expect(code).toContain("import os");
    expect(code).toContain("def _styx_path(value):");
    expect(code).toContain("infile=_styx_path(infile),");
    // non-path params pass straight through
    expect(code).toContain("iters=iters,");
  });
});

describe("pydra - degradation", () => {
  it("degrades a discriminated-union field to ty.Any with a note", () => {
    const code = generatePydra(
      generateCtx(
        seq(
          lit("bet"),
          namedAlt("source", seq(lit("--file"), path("f")), seq(lit("--url"), str("u"))),
        ),
        { app: { id: "bet" }, package: { name: "fsl" } },
      ),
    );
    expect(code).toContain('"source": python.arg(type=ty.Any');
    expect(code).toContain("nested configuration; pass a dict");
  });

  it("emits a raising body for a non-struct root", () => {
    const syntheticSpec: TypedSpec = {
      rootIsStruct: false,
      params: [],
      outputs: [{ id: "root", name: "root", shape: { kind: "single", optional: false } }],
      streams: [],
      delegation: { moduleName: "thing", wrapperFn: "thing", outputsClass: "ThingOutputs" },
    };
    const ctx = generateCtx(rep(str("item")), { app: { id: "thing" } });
    const code = emitPydraTask(ctx, syntheticSpec, pydraNames(ctx));
    expect(code).toContain("inputs={},");
    expect(code).toContain("raise NotImplementedError(");
    expect(code).toContain("non-struct root");
  });
});

describe("pydra - generated source is valid Python", () => {
  function findPython(): string | undefined {
    for (const exe of ["python", "python3"]) {
      try {
        execFileSync(exe, ["--version"], { stdio: "ignore" });
        return exe;
      } catch {
        // try next
      }
    }
    return undefined;
  }
  const py = findPython();
  if (!py) {
    console.warn("pydra ast.parse gate skipped: no python interpreter on PATH");
  }

  it.skipIf(!py)("ast.parse accepts both co-emitted modules", () => {
    const backend = new PydraBackend();
    const app = backend.emitApp(
      generateCtx(betExpr(), { app: { id: "bet" }, package: { name: "fsl" } }),
    );
    const dir = mkdtempSync(join(tmpdir(), "styx-pydra-"));
    try {
      for (const [name, content] of app.files) writeFileSync(join(dir, name), content, "utf-8");
      for (const name of app.files.keys()) {
        execFileSync(
          py!,
          [
            "-c",
            "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())",
            join(dir, name),
          ],
          { stdio: "pipe" },
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
