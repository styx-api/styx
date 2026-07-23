import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  base: process.env.NODE_ENV === "production" ? "/styx/" : "/",
});
