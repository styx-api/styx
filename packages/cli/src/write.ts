import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { BuiltFile } from "./build.js";

export function writeFiles(files: BuiltFile[]): void {
  for (const file of files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf8");
  }
}
