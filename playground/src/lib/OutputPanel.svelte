<script lang="ts">
  import { solve, createContext, type ParseResult } from "@styx/core";
  import { tabs, type SolvedParseResult } from "./tabs.js";
  import Messages from "./Messages.svelte";
  import CodeBlock from "./CodeBlock.svelte";

  interface Props {
    result:
      | { ok: true; value: ParseResult; timeMs: number }
      | { ok: false; error: string; timeMs: number };
  }

  let { result }: Props = $props();
  let activeTab = $state(tabs[0].id);

  const activeTabDef = $derived(tabs.find((t) => t.id === activeTab) ?? tabs[0]);

  // Solve once per input change, not per tab switch
  const solved: SolvedParseResult | null = $derived.by(() => {
    if (!result.ok) return null;
    const parseResult = result.value;
    const solveResult = solve(parseResult.expr);
    const ctx = createContext(parseResult.expr, solveResult, { app: parseResult.meta });
    return { parseResult, solveResult, ctx };
  });

  const output = $derived.by(() => {
    if (!solved) return null;
    try {
      return { ok: true as const, code: activeTabDef.compute(solved) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
</script>

<div class="output">
  {#if result.ok}
    {@const { errors, warnings } = result.value}

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
    {#each tabs as tab}
      <button class="tab" class:active={activeTab === tab.id} onclick={() => (activeTab = tab.id)}>
        {tab.label}
      </button>
    {/each}
    {#if result.timeMs > 0}
      <span class="timing">{result.timeMs.toFixed(0)}ms</span>
    {/if}
  </div>

  <div class="content">
    {#if !result.ok}
      {#if result.error}
        <Messages type="errors" messages={[{ message: result.error }]} />
      {:else}
        <div class="empty">Load an example or paste a descriptor to begin.</div>
      {/if}
    {:else if output?.ok}
      <CodeBlock code={output.code} lang={activeTabDef.lang} />
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
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    padding: 0 0.5rem;
    gap: 0;
  }

  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.6rem 0.75rem;
    font-size: 0.7rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: all var(--transition);
  }

  .tab:hover {
    color: var(--text-secondary);
  }

  .tab.active {
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
