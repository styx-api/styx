import ts from "typescript";
import * as styxdefs from "styxdefs";
import { describe, expect, it } from "vitest";
import type { AppMeta, Expr } from "../../ir/index.js";
import { executeExport, generateCtx, lit, seq, str } from "./test-helpers.js";
import { generateTypeScript } from "./typescript.js";

/**
 * Contract test: run generated TypeScript against the REAL published
 * `styxdefs` runtime (its `DryRunner` + types), not the hand-mock in
 * `test-helpers.ts`. The mock can silently drift from the runtime's actual
 * `Execution` signatures (e.g. a renamed/added method, an extra positional
 * arg); exercising the real package makes that drift a test failure.
 */

const mutPath = (name: string): Expr => ({
  kind: "path",
  attrs: { mutable: true },
  meta: { name },
});

interface RealRunResult {
  args: string[];
  outputs: unknown;
}

/**
 * Transpile the generated TS to CJS and run it, resolving its
 * `require("styxdefs")` to the real installed package and capturing the
 * command line via a real `DryRunner` installed as the global runner.
 */
function runAgainstRealRuntime(
  expr: Expr,
  params: Record<string, unknown>,
  options?: { app?: AppMeta; package?: { name?: string } },
): RealRunResult {
  const ctx = generateCtx(expr, options);
  const tsCode = generateTypeScript(ctx);
  const wrapperExport = executeExport(ctx);

  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  // Fresh real DryRunner per run so lastCargs is isolated.
  const runner = new styxdefs.DryRunner();
  styxdefs.setGlobalRunner(runner);

  const mod = { exports: {} as Record<string, unknown> };
  const fn = new Function("require", "module", "exports", jsCode);
  fn(
    (name: string) => {
      if (name === "styxdefs") return styxdefs;
      throw new Error(`Unexpected require: ${name}`);
    },
    mod,
    mod.exports,
  );

  const exportedFn = mod.exports[wrapperExport] as
    | ((params: Record<string, unknown>) => unknown)
    | undefined;
  if (!exportedFn) throw new Error(`No \`${wrapperExport}\` function found in generated code`);

  const outputs = exportedFn(params);
  return { args: runner.lastCargs ?? [], outputs };
}

describe("TypeScript codegen against the real styxdefs runtime", () => {
  it("builds the command line via the runtime's inputFile / run", () => {
    const { args } = runAgainstRealRuntime(seq(lit("tool"), str("input")), { input: "value" });
    expect(args).toEqual(["tool", "value"]);
  });

  it("resolves a path input through the runtime's inputFile", () => {
    const { args } = runAgainstRealRuntime(
      seq(lit("tool"), { kind: "path", attrs: {}, meta: { name: "infile" } }),
      {
        infile: "/data/scan.nii",
      },
    );
    expect(args).toEqual(["tool", "/data/scan.nii"]);
  });

  it("stages a mutable input as an output via the runtime's mutableCopy", () => {
    // mutable input on the command line -> inputFile(host, false, true);
    // surfaced as an output -> mutableCopy(host). Both exist on the real
    // Execution interface; a mock-only signature would pass but this won't.
    const { args, outputs } = runAgainstRealRuntime(seq(lit("tool"), mutPath("infile")), {
      infile: "/data/scan.nii",
    });
    expect(args).toEqual(["tool", "/data/scan.nii"]);
    expect(outputs).toMatchObject({ infile: "/data/scan.nii" });
  });

  it("captures stdout/stderr stream outputs via the runtime's run handlers", () => {
    const app: AppMeta = { id: "tool", stdout: { name: "stdout" }, stderr: { name: "stderr" } };
    const { outputs } = runAgainstRealRuntime(
      seq(lit("tool"), str("input")),
      { input: "x" },
      { app },
    );
    // The DryRunner never invokes the handlers, so the arrays stay empty -
    // but wiring them at all proves run()'s handler positions line up.
    expect(outputs).toMatchObject({ stdout: [], stderr: [] });
  });

  it("throws the runtime's real StyxValidationError on a missing required field", () => {
    expect(() => runAgainstRealRuntime(seq(lit("tool"), str("required")), {})).toThrow(
      styxdefs.StyxValidationError,
    );
  });

  it("substitutes a defaulted field's default when a hand-authored config omits it", () => {
    // A defaulted field (`out="default_out"`) is omittable in the schema/types,
    // so a config may omit it. Executed directly, the runtime must substitute the
    // default - never stringify `undefined` into the command line.
    const defaulted: Expr = {
      kind: "str",
      attrs: {},
      meta: { name: "out", defaultValue: "default_out" },
    };
    const { args } = runAgainstRealRuntime(seq(lit("tool"), defaulted), {});
    expect(args).toEqual(["tool", "default_out"]);
    expect(args).not.toContain("undefined");
  });

  it("drops an omitted flag without error (absent == off)", () => {
    // A flag is omittable (default false). A config that omits it must execute
    // cleanly with the flag simply absent from the command line.
    const flag: Expr = {
      kind: "optional",
      attrs: { node: seq(lit("--loud")) },
      meta: { name: "loud", defaultValue: false },
    };
    const { args } = runAgainstRealRuntime(seq(lit("tool"), str("name"), flag), { name: "x" });
    expect(args).toEqual(["tool", "x"]);
  });

  it("substitutes a defaulted ENUM (value-choices) field's default when omitted", () => {
    // A `value-choices` String with a default lowers to a literal-union
    // `alternative` read in walkAlternative (not walkTerminal). A schema-valid
    // config may omit it; the runtime must substitute the default, not emit
    // `undefined`. Regression guard for the alternative-dispatch read path.
    const enumField: Expr = {
      kind: "alternative",
      attrs: { alts: [lit("fast"), lit("slow"), lit("auto")] },
      meta: { name: "mode", defaultValue: "auto" },
    };
    const { args } = runAgainstRealRuntime(seq(lit("tool"), enumField), {});
    expect(args).toEqual(["tool", "auto"]);
    expect(args).not.toContain("undefined");
  });
});
