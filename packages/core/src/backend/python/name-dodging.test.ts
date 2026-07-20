import { describe, expect, it } from "vitest";
import { appModuleName } from "./python.js";
import { generate, lit, opt, seq } from "./test-helpers.js";

describe("Python name dodging - host vs wire", () => {
  it("scrubs reserved-word field names with trailing underscore", () => {
    const code = generate(
      seq(
        lit("ants"),
        opt(seq(lit("--float"), { kind: "str", attrs: {}, meta: { name: "float" } })),
      ),
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
      seq(
        lit("topup"),
        opt(seq(lit("--lambda"), { kind: "float", attrs: {}, meta: { name: "lambda" } })),
      ),
      { app: { id: "tool" } },
    );
    expect(code).toMatch(/Tool = typing\.TypedDict\(/);
    // Dict field: NotRequired, non-nullable. Kwarg signature: keeps `| None`
    // sentinel default (the "not provided" param value, not the field type).
    expect(code).toMatch(/"lambda":\s*typing\.NotRequired\[float\]/);
    expect(code).toMatch(/lambda_:\s*float\s*\|\s*None/);
  });

  it("dodges collisions with function-local names (runner/params)", () => {
    const code = generate(seq(lit("cmd"), { kind: "str", attrs: {}, meta: { name: "runner" } }), {
      app: { id: "tool" },
    });
    // Wire key 'runner' must not collide with the wrapper's `runner` param
    expect(code).toMatch(/runner_2:\s*str/);
    expect(code).toMatch(/"runner":\s*runner_2/);
  });

  it("scrubs digit-leading app ids in public names (cargs, metadata, wrapper)", () => {
    // `3dPFM` -> snake_case `3d_pfm` would start with a digit (invalid
    // module/function name). The public-name scrub prepends `v_`.
    const code = generate(seq(lit("3dPFM")), { app: { id: "3dPFM" } });
    expect(code).toMatch(/def v_3d_pfm\b/);
    expect(code).toMatch(/V_3D_PFM_METADATA\b/);
    expect(code).toMatch(/def v_3d_pfm_cargs\b/);
  });

  it("scrubs digit-leading app ids in appModuleName for file name", () => {
    expect(appModuleName({ id: "3dPFM" })).toBe("v_3d_pfm");
    expect(appModuleName({ id: "lambda" })).toBe("lambda_");
    expect(appModuleName({ id: "normal_tool" })).toBe("normal_tool");
  });

  it("scrubs Python keyword field names in the outputs NamedTuple", () => {
    // An output named `lambda` would shadow the keyword and break the
    // NamedTuple constructor. pyId appends a trailing underscore.
    const code = generate(
      seq(lit("tool"), {
        kind: "str",
        attrs: {},
        meta: {
          name: "x",
          outputs: [
            {
              name: "lambda",
              tokens: [{ kind: "literal", value: "out.nii" }],
            },
          ],
        },
      }),
      { app: { id: "tool" } },
    );
    expect(code).toMatch(/lambda_:\s*OutputPathType/);
    expect(code).toMatch(/lambda_=lambda__v/);
  });

  it("prefixes a digit-leading output field with v_, never a leading underscore", () => {
    // The Outputs type is a typing.NamedTuple, which raises ValueError at import
    // time for a field name starting with `_`. Real afni tools (3dclust_output,
    // 1D_dsets_directory) have digit-leading output ids, so this must use the
    // letter-leading `v_` prefix (like styx1 / pyScrubIdent), not `_`.
    const code = generate(
      seq(lit("tool"), {
        kind: "str",
        attrs: {},
        meta: {
          name: "x",
          outputs: [{ name: "3dclust_output", tokens: [{ kind: "literal", value: "out.nii" }] }],
        },
      }),
      { app: { id: "tool" } },
    );
    expect(code).toContain("v_3dclust_output: OutputPathType");
    // No output field name may start with an underscore.
    expect(code).not.toMatch(/^ {4}_\w+: OutputPathType/m);
  });
});
