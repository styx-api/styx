<script lang="ts">
  import { tabs, tabGroups, defaultTabId } from "./tabs.js";
  import type { CompileOutcome } from "./compiler.js";
  import Messages from "./Messages.svelte";
  import CodeBlock from "./CodeBlock.svelte";

  interface Props {
    outcome: CompileOutcome;
  }

  let { outcome }: Props = $props();
  let activeTab = $state(defaultTabId);
  let subTabSelections = $state<Record<string, string>>({});

  const activeTabDef = $derived(tabs.find((t) => t.id === activeTab) ?? tabs[0]);

  const output = $derived.by(() => {
    if (outcome.status !== "ok") return null;
    try {
      return { ok: true as const, files: activeTabDef.compute(outcome.compilation) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  const fileNames = $derived(output?.ok ? Array.from(output.files.keys()) : []);

  const activeFileName = $derived.by(() => {
    if (!output?.ok) return null;
    const selected = subTabSelections[activeTab];
    if (selected !== undefined && output.files.has(selected)) return selected;
    return fileNames[0] ?? null;
  });

  const activeFileContent = $derived(
    output?.ok && activeFileName !== null ? (output.files.get(activeFileName) ?? "") : "",
  );

  function selectSubTab(filename: string) {
    subTabSelections = { ...subTabSelections, [activeTab]: filename };
  }
</script>

<div class="output">
  {#if outcome.status === "ok"}
    {@const { errors, warnings } = outcome.compilation.parse}

    {#if errors.length > 0 || warnings.length > 0}
      <div class="messages-container">
        {#if errors.length > 0}
          <Messages type="errors" messages={errors} />
        {/if}
        {#if warnings.length > 0}
          <Messages type="warnings" messages={warnings} />
        {/if}
      </div>
    {/if}
  {/if}

  <div class="tab-bar">
    {#each tabGroups as group (group.label)}
      <div class="tab-group" style="--group-accent: {group.accent}">
        <span class="group-label">{group.label}</span>
        {#each group.tabs as tab (tab.id)}
          <button
            class="tab"
            class:active={activeTab === tab.id}
            aria-pressed={activeTab === tab.id}
            onclick={() => (activeTab = tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>
    {/each}
    {#if outcome.status !== "empty" && outcome.timeMs > 0}
      <span class="timing">{outcome.timeMs.toFixed(0)}ms</span>
    {/if}
  </div>

  {#if fileNames.length > 1}
    <div class="sub-tab-bar">
      {#each fileNames as name (name)}
        <button
          class="sub-tab"
          class:active={activeFileName === name}
          aria-pressed={activeFileName === name}
          onclick={() => selectSubTab(name)}
        >
          {name}
        </button>
      {/each}
    </div>
  {/if}

  <div class="content">
    {#if outcome.status === "empty"}
      <div class="empty">Load an example or paste a descriptor to begin.</div>
    {:else if outcome.status === "error"}
      <Messages type="errors" messages={[{ message: outcome.error }]} />
    {:else if output?.ok}
      <CodeBlock code={activeFileContent} lang={activeTabDef.lang} />
    {:else if output && !output.ok}
      <Messages type="errors" messages={[{ message: output.error }]} />
    {/if}
  </div>
</div>

<style>
  .output {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .messages-container {
    flex-shrink: 0;
    max-height: 30%;
    overflow-y: auto;
    border-bottom: 1px solid var(--border);
  }

  .tab-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    padding: 0.6rem 0.75rem;
    gap: 0.5rem 1rem;
  }

  .tab-group {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .group-label {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--group-accent, var(--text-muted));
    white-space: nowrap;
  }

  .tab {
    background: var(--bg-surface);
    border: 1px solid color-mix(in srgb, var(--group-accent, var(--border)) 22%, var(--border));
    border-radius: var(--radius-pill);
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0.3rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
    transition: all var(--transition);
  }

  .tab:hover {
    color: var(--text);
    border-color: var(--group-accent, var(--text-muted));
  }

  .tab:focus-visible,
  .sub-tab:focus-visible {
    outline: 2px solid var(--group-accent, var(--accent));
    outline-offset: 2px;
  }

  .tab.active {
    color: var(--text);
    border-color: var(--group-accent, var(--accent));
    background: color-mix(in srgb, var(--group-accent, var(--accent)) 16%, var(--bg-surface));
  }

  .sub-tab-bar {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-inset);
    padding: 0 0.5rem;
    gap: 0.25rem;
    overflow-x: auto;
  }

  .sub-tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.4rem 0.6rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    white-space: nowrap;
    transition: all var(--transition);
  }

  .sub-tab:hover {
    color: var(--text-secondary);
  }

  .sub-tab.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .timing {
    margin-left: auto;
    padding: 0 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--text-muted);
    align-self: center;
  }

  .content {
    flex: 1;
    min-height: 0;
    background: var(--bg-inset);
    display: flex;
    flex-direction: column;
    overflow: auto;
  }

  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
</style>
