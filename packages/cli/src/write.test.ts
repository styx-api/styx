import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFiles } from "./write.js";

let out: string;
beforeEach(() => {
  out = mkdtempSync(path.join(os.tmpdir(), "styx-write-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("writeFiles", () => {
  it("throws on two files targeting the same path with different content", () => {
    const p = path.join(out, "a.py");
    expect(() =>
      writeFiles([
        { path: p, content: "one" },
        { path: p, content: "two" },
      ]),
    ).toThrow(/write conflict/);
  });

  it("collapses identical duplicates to a single write", () => {
    const p = path.join(out, "a.py");
    writeFiles([
      { path: p, content: "same" },
      { path: p, content: "same" },
    ]);
    expect(readFileSync(p, "utf8")).toBe("same");
  });

  it("writes distinct files, creating parent directories", () => {
    writeFiles([
      { path: path.join(out, "pkg", "a.py"), content: "a" },
      { path: path.join(out, "pkg", "b.py"), content: "b" },
    ]);
    expect(readFileSync(path.join(out, "pkg", "a.py"), "utf8")).toBe("a");
    expect(readFileSync(path.join(out, "pkg", "b.py"), "utf8")).toBe("b");
  });
});
