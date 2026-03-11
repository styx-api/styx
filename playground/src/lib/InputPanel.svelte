<!-- components/InputPanel.svelte -->
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
  let loading = $state<string | null>(null);
  let editorContainer: HTMLDivElement;
  let editorView: EditorView;

  interface ExampleGroup {
    label: string;
    examples: { name: string; url: string }[];
  }

  const exampleGroups: ExampleGroup[] = [
    {
      label: "Boutiques",
      examples: [
        {
          name: "FSL bet",
          url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/fsl/6.0.4/bet/boutiques.json",
        },
        {
          name: "FSL flirt",
          url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/fsl/6.0.4/flirt/boutiques.json",
        },
        {
          name: "FSL fast",
          url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/fsl/6.0.4/fast/boutiques.json",
        },
        {
          name: "FreeSurfer recon-all",
          url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/freesurfer/7.4.1/recon-all/boutiques.json",
        },
        {
          name: "ANTs antsRegistration",
          url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/ants/2.5.3/antsRegistration/boutiques.json",
        },
      ],
    },
    {
      label: "Argdump",
      examples: [
        {
          name: "fmriprep",
          url: "https://raw.githubusercontent.com/styx-api/argdump/main/examples/fmriprep.json",
        },
        {
          name: "mriqc",
          url: "https://raw.githubusercontent.com/styx-api/argdump/main/examples/mriqc.json",
        },
      ],
    },
  ];

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

  // Update editor when input changes externally
  $effect(() => {
    if (editorView && editorView.state.doc.toString() !== input) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: input },
      });
    }
  });
</script>

<div class="header">
  <h2>Input</h2>
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
    <option value="">{loading ? "Loading..." : "Load example..."}</option>
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
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  h2 {
    margin: 0;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
  }

  select {
    padding: 0.35rem 0.5rem;
    border: 1px solid #333;
    border-radius: 4px;
    background: #0d0d0d;
    color: #eee;
    font-size: 13px;
    cursor: pointer;
  }

  select:hover:not(:disabled) {
    border-color: #555;
  }

  select:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .editor {
    flex: 1;
    border: 1px solid #333;
    border-radius: 4px;
    overflow: hidden;
    min-height: 0;
  }

  .editor :global(.cm-editor) {
    height: 100%;
  }

  .editor :global(.cm-scroller) {
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 14px;
  }
</style>
