<script lang="ts">
  import { detectFormat } from "@styx-api/core";
  import type { FormatName } from "@styx-api/core";
  import { onMount } from "svelte";
  import InputPanel from "./lib/InputPanel.svelte";
  import OutputPanel from "./lib/OutputPanel.svelte";
  import PassToggles from "./lib/PassToggles.svelte";
  import { runCompile } from "./lib/compiler.js";
  import { defaultPassConfig, type PassConfig } from "./lib/passes.js";
  import { defaultExample, exampleGroups } from "./lib/examples.js";

  let input = $state<string>("");
  let loading = $state<string | null>(null);
  let passes = $state<PassConfig>({ ...defaultPassConfig });

  const detectedFormat = $derived<FormatName | null>(input ? detectFormat(input) : null);

  const outcome = $derived(runCompile(input, passes));

  async function loadExample(url: string) {
    loading = url;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // JSON descriptors are pretty-printed; non-JSON sources (argtype) are
      // shown verbatim.
      try {
        input = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        input = text;
      }
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
          {#each exampleGroups as group (group.label)}
            <optgroup label={group.label}>
              {#each group.examples as ex (ex.url)}
                <option value={ex.url}>{ex.name}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </div>
      <InputPanel bind:input format={detectedFormat} />
    </section>
    <section class="panel">
      <OutputPanel {outcome} />
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
