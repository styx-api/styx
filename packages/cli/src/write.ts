import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { BuiltFile } from "./build.js";

export function writeFiles(files: BuiltFile[]): void {
  // Guard against two files claiming the same destination with different content:
  // a silent last-write-wins would drop output. Identical duplicates are harmless
  // and collapse to a single write.
  const byPath = new Map<string, string>();
  for (const file of files) {
    const prev = byPath.get(file.path);
    if (prev !== undefined && prev !== file.content) {
      throw new Error(`write conflict: two files target ${file.path} with different content`);
    }
    byPath.set(file.path, file.content);
  }

  for (const [dest, content] of byPath) {
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, content, "utf8");
    } catch (e) {
      throw new Error(`failed to write ${dest}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
