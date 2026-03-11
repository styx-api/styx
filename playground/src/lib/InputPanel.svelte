<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, minimalSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import { json } from "@codemirror/lang-json";
  import { oneDark } from "@codemirror/theme-one-dark";

  interface Props {
    input: string;
  }

  let { input = $bindable() }: Props = $props();
  let editorContainer: HTMLDivElement;
  let editorView: EditorView;

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

<div class="editor" bind:this={editorContainer}></div>

<style>
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
