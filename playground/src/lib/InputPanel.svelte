<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, minimalSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import { json } from "@codemirror/lang-json";
  import { oneDark } from "@codemirror/theme-one-dark";
  import { exampleGroups } from "./examples.js";

  interface Props {
    input: string;
  }

  let { input = $bindable() }: Props = $props();
  let loading = $state<string | null>(null);
  let editorContainer: HTMLDivElement;
  let editorView: EditorView;

  async function loadExample(url: string) {
    loading = url;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const jsonData = await res.json();
      input = JSON.stringify(jsonData, null, 2);
      if (editorView) {
        editorView.dispatch({
          changes: { from: 0, to: editorView.state.doc.length, insert: input },
        });
      }
    } catch (e) {
      input = `// Failed to load: ${e instanceof Error ? e.message : e}`;
    } finally {
      loading = null;
    }
  }

  onMount(() => {
    const state = EditorState.create({
      doc: input,
      extensions: [
        minimalSetup,
        json(),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            input = update.state.doc.toString();
          }
        }),
        EditorView.theme({
          "&": { backgroundColor: "transparent" },
          ".cm-gutters": { backgroundColor: "transparent", borderRight: "none" },
        }),
      ],
    });

    editorView = new EditorView({
      state,
      parent: editorContainer,
    });

    return () => {
      editorView?.destroy();
    };
  });

  $effect(() => {
    if (editorView && editorView.state.doc.toString() !== input) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: input },
      });
    }
  });
</script>

<div class="toolbar">
  <select
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

<div class="editor" bind:this={editorContainer}></div>

<style>
  .toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0.375rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  select {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    transition: border-color var(--transition);
  }

  select:hover:not(:disabled) {
    border-color: var(--text-muted);
  }

  select:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .editor :global(.cm-editor) {
    height: 100%;
  }

  .editor :global(.cm-scroller) {
    font-family: var(--font-mono);
    font-size: var(--font-size-mono);
  }
</style>
