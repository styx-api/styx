<script lang="ts">
  import {
    createHighlighter,
    type Highlighter,
    type BundledLanguage,
    type LanguageRegistration,
  } from "shiki";
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
  let copied = $state(false);

  async function copyToClipboard() {
    await navigator.clipboard.writeText(code);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  onMount(async () => {
    try {
      highlighter = await createHighlighter({
        themes: ["github-dark"],
        langs: ["json", "typescript", "python"],
      });

      // Hand-authored TextMate grammars; cast to shiki's registration shape.
      await highlighter.loadLanguage(irGrammar as unknown as LanguageRegistration);
      await highlighter.loadLanguage(bindingsGrammar as unknown as LanguageRegistration);

      grammarsLoaded = true;
    } catch (e) {
      console.error("Failed to load highlighter:", e);
    }
  });

  $effect(() => {
    if (highlighter && grammarsLoaded && code) {
      try {
        html = highlighter.codeToHtml(code, {
          lang: lang as string,
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

<div class="wrapper">
  {#if code}
    <button class="copy" onclick={copyToClipboard} title="Copy to clipboard">
      {#if copied}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      {:else}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      {/if}
    </button>
  {/if}

  {#if html}
    <div class="code-block">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: shiki highlighter output or escapeHtml fallback -->
      {@html html}
    </div>
  {:else}
    <pre><code>{code}</code></pre>
  {/if}
</div>

<style>
  .wrapper {
    position: relative;
    height: 100%;
    overflow: auto;
  }

  .copy {
    position: sticky;
    top: 0.5rem;
    float: right;
    margin: 0.5rem 0.5rem 0 0;
    padding: 0.35rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition);
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .copy:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }

  .code-block {
    height: 100%;
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
