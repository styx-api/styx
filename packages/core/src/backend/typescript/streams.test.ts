import type { AppMeta, Expr } from "../../ir/index.js";
import { describe, expect, it } from "vitest";
import { executeWithOutputs, generate, lit, seq, str } from "./test-helpers.js";

const mutPath = (name: string): Expr => ({
  kind: "path",
  attrs: { mutable: true },
  meta: { name },
});

const streamApp = (stdout?: boolean, stderr?: boolean): AppMeta => ({
  id: "mytool",
  ...(stdout && { stdout: { name: "stdout" } }),
  ...(stderr && { stderr: { name: "stderr", doc: { description: "Standard error." } } }),
});

describe("TypeScript stream outputs (stdout/stderr)", () => {
  it("declares string[] fields on the Outputs interface", () => {
    const code = generate(seq(lit("mytool"), str("input")), { app: streamApp(true, true) });
    expect(code).toContain("stdout: string[];");
    expect(code).toContain("stderr: string[];");
    expect(code).toContain("/** Standard error. */");
  });

  it("initializes stream fields to empty arrays in the build function", () => {
    const code = generate(seq(lit("mytool"), str("input")), { app: streamApp(true, true) });
    expect(code).toContain("stdout: [],");
    expect(code).toContain("stderr: [],");
  });

  it("wires handleStdout / handleStderr into execution.run", () => {
    const code = generate(seq(lit("mytool"), str("input")), { app: streamApp(true, true) });
    expect(code).toContain(
      "execution.run(args, (s: string): void => { out.stdout.push(s); }, " +
        "(s: string): void => { out.stderr.push(s); });",
    );
    expect(code).toContain("return out;");
  });

  it("passes undefined for stdout when only stderr is captured", () => {
    const code = generate(seq(lit("mytool"), str("input")), { app: streamApp(false, true) });
    expect(code).toContain(
      "execution.run(args, undefined, (s: string): void => { out.stderr.push(s); });",
    );
  });

  it("does not import OutputPathType for a stream-only tool", () => {
    const code = generate(seq(lit("mytool"), str("input")), { app: streamApp(true, true) });
    expect(code).not.toContain("OutputPathType");
  });

  it("bumps a stream field whose name collides with an output field", () => {
    const code = generate(seq(lit("tool"), mutPath("stdout")), {
      app: { id: "tool", stdout: { name: "stdout" } },
    });
    expect(code).toContain("stdout: OutputPathType;");
    expect(code).toContain("stdout_: string[];");
    expect(code).toContain("stdout_: [],");
  });

  it("produces a runnable wrapper whose outputs carry empty stream arrays", () => {
    const { outputs } = executeWithOutputs(
      seq(lit("mytool"), str("input")),
      { input: "x" },
      { app: streamApp(true, true) },
    );
    expect(outputs).toMatchObject({ stdout: [], stderr: [] });
  });
});
