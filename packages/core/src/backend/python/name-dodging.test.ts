import { describe, expect, it } from "vitest";
import { generate, int, lit, opt, path, seq, str } from "./test-helpers.js";

describe("Python name dodging - host vs wire", () => {
  it("scrubs reserved-word field names with trailing underscore", () => {
    const code = generate(
      seq(lit("ants"), opt(seq(lit("--float"), { kind: "str", attrs: {}, meta: { name: "float" } }))),
      { app: { id: "tool" } },
    );
    // Signature uses scrubbed host name
    expect(code).toMatch(/float_:\s*str\s*\|\s*None/);
    // Body uses wire name as dict key, host name as value
    expect(code).toMatch(/params\["float"\]\s*=\s*float_/);
    // cargs accesses params by wire key
    expect(code).toMatch(/params\["float"\]/);
  });

  it("prefixes digit-leading field names with v_", () => {
    const code = generate(
      seq(lit("cmd"), { kind: "path", attrs: {}, meta: { name: "4d_input" } }),
      { app: { id: "tool" } },
    );
    expect(code).toMatch(/v_4d_input:\s*InputPathType/);
    expect(code).toMatch(/"4d_input":\s*v_4d_input/);
  });

  it("forces functional TypedDict syntax for Python keyword field names", () => {
    const code = generate(
      seq(lit("topup"), opt(seq(lit("--lambda"), { kind: "float", attrs: {}, meta: { name: "lambda" } }))),
      { app: { id: "tool" } },
    );
    expect(code).toMatch(/Tool = typing\.TypedDict\(/);
    expect(code).toMatch(/"lambda":\s*float\s*\|\s*None/);
    expect(code).toMatch(/lambda_:\s*float\s*\|\s*None/);
  });

  it("dodges collisions with function-local names (runner/params)", () => {
    const code = generate(
      seq(lit("cmd"), { kind: "str", attrs: {}, meta: { name: "runner" } }),
      { app: { id: "tool" } },
    );
    // Wire key 'runner' must not collide with the wrapper's `runner` param
    expect(code).toMatch(/runner_2:\s*str/);
    expect(code).toMatch(/"runner":\s*runner_2/);
  });
});
