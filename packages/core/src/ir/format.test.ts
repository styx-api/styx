import { describe, expect, it } from "vitest";
import { lit, opt, path, seq } from "./builders.js";
import { format } from "./format.js";
import { nodeRef } from "./meta.js";
import type { Output } from "./meta.js";

describe("format (IR)", () => {
  it("renders outputs on the node that owns them", () => {
    const host = opt(path("input"));
    const outputs: Output[] = [
      {
        name: "out",
        tokens: [
          { kind: "ref", target: nodeRef("input"), stripExtensions: [".nii"], fallback: "" },
          { kind: "literal", value: ".out" },
        ],
        optional: true,
        mediaTypes: ["text/plain"],
      },
    ];
    host.meta = { ...host.meta, outputs };

    const text = format(seq(lit("cmd"), host));
    // The outputs block lives directly under the owning node header, before children.
    expect(text).toContain("optional");
    expect(text).toContain("outputs:");
    expect(text).toContain('out [optional] (text/plain): ref(input) {strip=[".nii"], fallback=""} + ".out"');
    // Outputs appear before the wrapped child (path)
    const optionalIdx = text.indexOf("optional");
    const outputsIdx = text.indexOf("outputs:");
    const pathIdx = text.indexOf("path [input]");
    expect(optionalIdx).toBeLessThan(outputsIdx);
    expect(outputsIdx).toBeLessThan(pathIdx);
  });

  it("renders literal-only outputs without crashing", () => {
    const root = seq(lit("cmd"));
    root.meta = { outputs: [{ name: "log", tokens: [{ kind: "literal", value: "run.log" }] }] };
    const text = format(root);
    expect(text).toContain('log: "run.log"');
  });

  it("omits the outputs block when no outputs are attached", () => {
    const text = format(seq(lit("cmd"), path("input")));
    expect(text).not.toContain("outputs:");
  });
});
