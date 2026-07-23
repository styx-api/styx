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

  // Parsing + solving runs on every input change, so debounce keystrokes to keep
  // typing smooth on large descriptors (recon-all, antsRegistration). Pass toggles
  // stay instant since `outcome` depends on `passes` directly.
  const COMPILE_DEBOUNCE_MS = 150;
  let debouncedInput = $state<string>("");

  $effect(() => {
    const next = input;
    const id = setTimeout(() => (debouncedInput = next), COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  });

  // Build metadata injected by Vite (see vite.config.ts).
  const version = __STYX_VERSION__;
  const commit = __STYX_COMMIT__;
  const buildDate = __BUILD_DATE__;
  const commitUrl =
    commit !== "unknown" ? `https://github.com/styx-api/styx/commit/${commit}` : null;
  const versionTitle = `styx core ${version}${buildDate ? `, built ${buildDate}` : ""}`;

  const detectedFormat = $derived<FormatName | null>(input ? detectFormat(input) : null);

  const outcome = $derived(runCompile(debouncedInput, passes));

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
      // Loading an example is deliberate: compile it immediately, no debounce wait.
      debouncedInput = input;
      loading = null;
    }
  }

  onMount(() => {
    loadExample(defaultExample.url);
  });
</script>

<div class="app">
  <header>
    <span class="wordmark">styx</span>
    <span class="subtitle">compiler explorer</span>
    {#if commitUrl}
      <a class="version-tag" href={commitUrl} target="_blank" rel="noreferrer" title={versionTitle}>
        v{version} <span class="commit">{commit}</span>
      </a>
    {:else}
      <span class="version-tag" title={versionTitle}>v{version}</span>
    {/if}
    <div class="passes-group">
      <span class="passes-label">Passes</span>
      <PassToggles bind:passes />
    </div>
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
    --bg-base: #0e0e10;
    --bg-surface: #161619;
    --bg-elevated: #1e1e22;
    --bg-inset: #0a0a0c;
    --border: #2a2a30;
    --border-subtle: #1e1e23;
    --text: #f4f4f7;
    --text-secondary: #c2c2cc;
    --text-muted: #9494a1;
    --accent: #a5b0ff;
    --accent-hover: #c2caff;
    --accent-subtle: rgba(165, 176, 255, 0.18);
    --error: #f87171;
    --error-subtle: rgba(248, 113, 113, 0.12);
    --warning: #fbbf24;
    --warning-subtle: rgba(251, 191, 36, 0.12);
    --radius: 6px;
    --radius-lg: 10px;
    --radius-pill: 999px;
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
    padding: 1.25rem 1.5rem;
    gap: 1rem;
  }

  header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding-bottom: 0.15rem;
  }

  .wordmark {
    font-size: 1.3rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .subtitle {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-weight: 400;
    letter-spacing: 0.01em;
    padding-left: 0.6rem;
    border-left: 1px solid var(--border);
  }

  .version-tag {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-muted);
    text-decoration: none;
    white-space: nowrap;
    transition: color var(--transition);
  }

  .version-tag .commit {
    color: var(--text-secondary);
  }

  .version-tag:hover {
    color: var(--text-secondary);
  }

  a.version-tag:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }

  a.version-tag:hover .commit {
    color: var(--accent);
  }

  .passes-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }

  .passes-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
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
    gap: 1rem;
    min-height: 0;
  }

  /* Stack input over output on narrow viewports. */
  @media (max-width: 768px) {
    .app {
      padding: 0.75rem;
    }

    main {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 1fr;
    }

    .subtitle {
      display: none;
    }

    .passes-group {
      margin-left: 0;
    }
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
    gap: 0.6rem;
    padding: 0.65rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .panel-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
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

  .example-select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .example-select:disabled {
    opacity: 0.5;
    cursor: wait;
  }
</style>
