import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});
