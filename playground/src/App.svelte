<script lang="ts">
  import { compile, detectFormat } from "@styx/core";
  import type { FormatName, ParseResult } from "@styx/core";
  import { createPipeline, flatten, simplify, removeEmpty, canonicalize } from "@styx/core";
  import { onMount } from "svelte";
  import InputPanel from "./lib/InputPanel.svelte";
  import OutputPanel from "./lib/OutputPanel.svelte";
  import PassToggles from "./lib/PassToggles.svelte";
  import { defaultExample, exampleGroups } from "./lib/examples.js";

  let input = $state<string>("");
  let loading = $state<string | null>(null);
  let passes = $state({
    flatten: true,
    simplify: true,
    removeEmpty: true,
    canonicalize: false,
  });

  const detectedFormat = $derived<FormatName | null>(input ? detectFormat(input) : null);

  type CompileResult =
    | { ok: true; value: ParseResult; timeMs: number }
    | { ok: false; error: string; timeMs: number };

  const result: CompileResult = $derived.by(() => {
    if (!input) return { ok: false, error: "", timeMs: 0 };

    const start = performance.now();
    try {
      const parseResult = compile(input);

      const availablePasses = [];
      if (passes.flatten) availablePasses.push(flatten);
      if (passes.simplify) availablePasses.push(simplify);
      if (passes.removeEmpty) availablePasses.push(removeEmpty);
      if (passes.canonicalize) availablePasses.push(canonicalize);

      if (availablePasses.length > 0) {
        const pipeline = createPipeline(availablePasses, { fixpoint: true });
        const passResult = pipeline.apply(parseResult.expr);
        parseResult.expr = passResult.expr;

        if (passResult.warnings) {
          parseResult.warnings.push(...passResult.warnings.map((w) => ({ message: w })));
        }
      }

      const timeMs = performance.now() - start;
      return { ok: true as const, value: parseResult, timeMs };
    } catch (e) {
      const timeMs = performance.now() - start;
      return { ok: false as const, error: e instanceof Error ? e.message : String(e), timeMs };
    }
  });

  async function loadExample(url: string) {
    loading = url;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const jsonData = await res.json();
      input = JSON.stringify(jsonData, null, 2);
    } catch (e) {
      input = `// Failed to load: ${e instanceof Error ? e.message : e}`;
    } finally {
      loading = null;
    }
  }

  onMount(() => {
    loadExample(defaultExample.url);
  });
</script>

<div class="app">
  <header>
    <h1>styx<span class="version">2</span></h1>
    <span class="subtitle">compiler explorer</span>
    <PassToggles bind:passes />
  </header>

  <main>
    <section class="panel">
      <div class="panel-header">
        <span class="panel-label">Input</span>
        {#if detectedFormat}
          <span class="format-badge">{detectedFormat}</span>
        {/if}
        <select
          class="example-select"
          onchange={(e) => {
            const url = e.currentTarget.value;
            if (url) {
              loadExample(url);
              e.currentTarget.value = "";
            }
          }}
          disabled={loading !== null}
        >
          <option value="">{loading ? "Loading..." : "Load example"}</option>
          {#each exampleGroups as group}
            <optgroup label={group.label}>
              {#each group.examples as ex}
                <option value={ex.url}>{ex.name}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </div>
      <InputPanel bind:input />
    </section>
    <section class="panel">
      <OutputPanel {result} />
    </section>
  </main>
</div>

<style>
  :global(*) {
    margin: 0;
    box-sizing: border-box;
  }

  :global(body) {
    font-family:
      "Inter",
      -apple-system,
      BlinkMacSystemFont,
      system-ui,
      sans-serif;
    background: var(--bg-base);
    color: var(--text);
    overflow: hidden;
  }

  :global(:root) {
    --bg-base: #111113;
    --bg-surface: #18181b;
    --bg-elevated: #1e1e22;
    --bg-inset: #0c0c0e;
    --border: #27272a;
    --border-subtle: #1f1f23;
    --text: #e4e4e7;
    --text-secondary: #a1a1aa;
    --text-muted: #71717a;
    --accent: #6366f1;
    --accent-subtle: rgba(99, 102, 241, 0.12);
    --error: #ef4444;
    --error-subtle: rgba(239, 68, 68, 0.12);
    --warning: #f59e0b;
    --warning-subtle: rgba(245, 158, 11, 0.12);
    --radius: 6px;
    --radius-lg: 8px;
    --font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
    --font-size-mono: 13px;
    --transition: 150ms ease;
  }

  :global(*::-webkit-scrollbar) {
    width: 6px;
    height: 6px;
  }

  :global(*::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(*::-webkit-scrollbar-thumb) {
    background: var(--border);
    border-radius: 3px;
  }

  :global(*::-webkit-scrollbar-thumb:hover) {
    background: var(--text-muted);
  }

  :global(*) {
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    max-width: 1800px;
    margin: 0 auto;
    padding: 1rem 1.25rem;
    gap: 0.75rem;
  }

  header {
    flex-shrink: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  h1 {
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .version {
    color: var(--accent);
    font-weight: 300;
  }

  .subtitle {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-weight: 400;
    letter-spacing: 0.02em;
  }

  .format-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.45rem;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-radius: var(--radius);
    background: var(--accent-subtle);
    color: var(--accent);
  }

  main {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    min-height: 0;
  }

  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .panel-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .panel-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .example-select {
    margin-left: auto;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: 0.7rem;
    cursor: pointer;
    transition: border-color var(--transition);
  }

  .example-select:hover:not(:disabled) {
    border-color: var(--text-muted);
  }

  .example-select:disabled {
    opacity: 0.5;
    cursor: wait;
  }
</style>
