import { describe, expect, it } from "vitest";
import { mapType } from "./typemap.js";

describe("mapType inline struct keys", () => {
  it("quotes a non-identifier field key in an anonymous struct", () => {
    const out = mapType(
      {
        kind: "struct",
        fields: { "4d_input": { kind: "scalar", scalar: "int" } },
      },
      () => undefined, // force the anonymous (unnamed) struct branch
    );
    expect(out).toBe('{ "4d_input": number }');
  });
});
