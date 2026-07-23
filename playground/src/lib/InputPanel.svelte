<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, minimalSetup } from "codemirror";
  import { Compartment, EditorState, type Extension } from "@codemirror/state";
  import { json } from "@codemirror/lang-json";
  import { oneDark } from "@codemirror/theme-one-dark";
  import type { FormatName } from "@styx-api/core";
  import { argtype } from "./argtype-mode.js";

  interface Props {
    input: string;
    format: FormatName | null;
  }

  let { input = $bindable(), format }: Props = $props();
  let editorContainer: HTMLDivElement;
  let editorView: EditorView;

  // Swap the syntax-highlighting language to match the detected format: the
  // JSON frontends all use CodeMirror's JSON mode, argtype uses its own.
  const language = new Compartment();

  function languageFor(fmt: FormatName | null): Extension {
    return fmt === "argtype" ? argtype() : json();
  }

  onMount(() => {
    const state = EditorState.create({
      doc: input,
      extensions: [
        minimalSetup,
        language.of(languageFor(format)),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            input = update.state.doc.toString();
          }
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

  // Reconfigure the language whenever the detected format changes.
  $effect(() => {
    editorView?.dispatch({ effects: language.reconfigure(languageFor(format)) });
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
    background: transparent !important;
  }

  .editor :global(.cm-gutters) {
    background: transparent !important;
    border-right: none !important;
  }

  .editor :global(.cm-selectionBackground) {
    background: rgba(165, 176, 255, 0.15) !important;
  }

  .editor :global(.cm-focused .cm-selectionBackground) {
    background: rgba(165, 176, 255, 0.25) !important;
  }

  .editor :global(.cm-cursor) {
    border-left-color: var(--accent) !important;
  }

  .editor :global(.cm-activeLine) {
    background: rgba(255, 255, 255, 0.03) !important;
  }

  .editor :global(.cm-activeLineGutter) {
    background: rgba(255, 255, 255, 0.03) !important;
  }

  .editor :global(.cm-scroller) {
    font-family: var(--font-mono);
    font-size: var(--font-size-mono);
  }
</style>
