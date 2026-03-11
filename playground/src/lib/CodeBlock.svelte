<script lang="ts">
  import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
  import { onMount } from "svelte";
  import { irGrammar, bindingsGrammar } from "./grammars.js";

  interface Props {
    code: string;
    lang?: BundledLanguage | "ir" | "bindings";
  }

  let { code, lang = "json" }: Props = $props();
  let highlighter = $state<Highlighter | null>(null);
  let grammarsLoaded = $state(false);
  let html = $state("");

  onMount(async () => {
    try {
      highlighter = await createHighlighter({
        themes: ["github-dark"],
        langs: ["json", "typescript"],
      });

      await highlighter.loadLanguage(irGrammar as any);
      await highlighter.loadLanguage(bindingsGrammar as any);

      grammarsLoaded = true;
    } catch (e) {
      console.error("Failed to load highlighter:", e);
    }
  });

  $effect(() => {
    if (highlighter && grammarsLoaded && code) {
      try {
        html = highlighter.codeToHtml(code, {
          lang: lang as any,
          theme: "github-dark",
        });
      } catch (_e) {
        html = `<pre><code>${escapeHtml(code)}</code></pre>`;
      }
    } else if (code) {
      html = `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
  });

  function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
</script>

{#if html}
  <div class="code-block">
    {@html html}
  </div>
{:else}
  <pre><code>{code}</code></pre>
{/if}

<style>
  .code-block {
    height: 100%;
    overflow: auto;
  }

  .code-block :global(pre) {
    margin: 0;
    padding: 0.75rem 1rem;
    font-family: var(--font-mono);
    font-size: var(--font-size-mono);
    line-height: 1.6;
    background: transparent !important;
    min-height: 100%;
  }

  .code-block :global(code) {
    font-family: inherit;
  }

  pre {
    margin: 0;
    padding: 0.75rem 1rem;
    font-family: var(--font-mono);
    font-size: var(--font-size-mono);
    line-height: 1.6;
    color: var(--text-secondary);
    min-height: 100%;
  }
</style>
