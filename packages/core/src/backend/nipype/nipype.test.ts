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
import { emitNipypeInterface } from "./emit.js";
import { generateNipype, NipypeBackend, nipypeNames } from "./nipype.js";

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
    withDefault(floatRange("frac", 0, 1), 0.5),
    intRange("iters", 1, 100),
    opt(seq(lit("-c"), listCount(int("center"), "center", 3, 3))),
    opt(lit("-v"), { name: "verbose", defaultValue: false }),
    namedAlt("mode", lit("fast"), lit("robust")),
  );
}
function bet(): string {
  return generateNipype(generateCtx(betExpr(), { app: { id: "bet" }, package: { name: "fsl" } }));
}

describe("nipype interface - module shape", () => {
  it("imports nipype base symbols and the styx wrapper via a relative import", () => {
    const code = bet();
    expect(code).toContain("from nipype.interfaces.base import (");
    expect(code).toContain("from ._bet import bet, BetOutputs");
  });

  it("declares the interface, input, and output spec classes", () => {
    const code = bet();
    expect(code).toContain("class BetInputSpec(BaseInterfaceInputSpec):");
    expect(code).toContain("class BetOutputSpec(TraitedSpec):");
    expect(code).toContain("class Bet(BaseInterface):");
    expect(code).toContain("input_spec = BetInputSpec");
    expect(code).toContain("output_spec = BetOutputSpec");
  });
});

describe("nipype InputSpec - rich traits", () => {
  it("maps a path with media types to File(exists=True) with a desc", () => {
    expect(bet()).toContain(
      'infile = File(exists=True, mandatory=True, desc="Input image (media types: image/nifti)")',
    );
  });

  it("maps a float range + default to traits.Range with usedefault", () => {
    expect(bet()).toContain("frac = traits.Range(value=0.5, low=0, high=1, usedefault=True)");
  });

  it("maps a mandatory int range to traits.Range(mandatory=True)", () => {
    expect(bet()).toContain("iters = traits.Range(low=1, high=100, mandatory=True)");
  });

  it("maps a bounded list to traits.List(minlen, maxlen)", () => {
    expect(bet()).toContain("center = traits.List(traits.Int(), minlen=3, maxlen=3)");
  });

  it("maps a flag to traits.Bool with its default", () => {
    expect(bet()).toContain("verbose = traits.Bool(False, usedefault=True)");
  });

  it("maps an enum to traits.Enum over its choices", () => {
    expect(bet()).toContain('mode = traits.Enum("fast", "robust", mandatory=True)');
  });
});

describe("nipype OutputSpec + execution glue", () => {
  it("declares output traits including the synthetic root", () => {
    expect(bet()).toContain("root = File(");
  });

  it("builds kwargs (mandatory direct, optional guarded) and delegates to the wrapper", () => {
    const code = bet();
    expect(code).toContain("kwargs = {}");
    expect(code).toContain('kwargs["infile"] = self.inputs.infile');
    expect(code).toContain("if isdefined(self.inputs.center):");
    expect(code).toContain("self._result: BetOutputs = bet(**kwargs)");
  });

  it("maps the wrapper result back out in _list_outputs", () => {
    const code = bet();
    expect(code).toContain("def _list_outputs(self):");
    expect(code).toContain("result = self._result");
    expect(code).toContain('outputs["root"] = result.root');
  });
});

describe("nipype - degradation", () => {
  it("degrades a discriminated-union field to traits.Any with a note", () => {
    const code = generateNipype(
      generateCtx(
        seq(
          lit("bet"),
          namedAlt("source", seq(lit("--file"), path("f")), seq(lit("--url"), str("u"))),
        ),
        { app: { id: "bet" }, package: { name: "fsl" } },
      ),
    );
    expect(code).toContain("source = traits.Any(");
    expect(code).toContain("nested configuration; pass a dict");
  });

  it("emits a pass-through InputSpec and a raising run for a non-struct root", () => {
    const syntheticSpec: TypedSpec = {
      rootIsStruct: false,
      params: [],
      outputs: [],
      streams: [],
      delegation: { moduleName: "thing", wrapperFn: "thing", outputsClass: "ThingOutputs" },
    };
    const code = emitNipypeInterface(
      generateCtx(rep(str("item")), { app: { id: "thing" } }),
      syntheticSpec,
      nipypeNames(generateCtx(rep(str("item")), { app: { id: "thing" } })),
    );
    expect(code).toContain("class ThingInputSpec(BaseInterfaceInputSpec):");
    expect(code).toContain("raise NotImplementedError(");
    expect(code).toContain("non-struct root");
  });
});

describe("nipype - generated source is valid Python", () => {
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
    console.warn("nipype ast.parse gate skipped: no python interpreter on PATH");
  }

  it.skipIf(!py)("ast.parse accepts both co-emitted modules", () => {
    const backend = new NipypeBackend();
    const app = backend.emitApp(
      generateCtx(betExpr(), { app: { id: "bet" }, package: { name: "fsl" } }),
    );
    const dir = mkdtempSync(join(tmpdir(), "styx-nipype-"));
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
