import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

/** Best-effort build metadata; falls back gracefully when git is unavailable. */
function buildMeta() {
  let version = "unknown";
  try {
    const pkgUrl = new URL("../packages/core/package.json", import.meta.url);
    version = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")).version;
  } catch {
    // Core not resolvable from here; leave default.
  }
  let commit = "unknown";
  let date = "";
  try {
    commit = execSync("git rev-parse --short HEAD").toString().trim();
    date = execSync("git log -1 --format=%cs").toString().trim();
  } catch {
    // Not a git checkout (e.g. published tarball); leave defaults.
  }
  return { version, commit, date };
}

const meta = buildMeta();

export default defineConfig({
  plugins: [svelte()],
  base: process.env.NODE_ENV === "production" ? "/styx/" : "/",
  define: {
    __STYX_VERSION__: JSON.stringify(meta.version),
    __STYX_COMMIT__: JSON.stringify(meta.commit),
    __BUILD_DATE__: JSON.stringify(meta.date),
  },
});
