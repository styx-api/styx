<script lang="ts">
  import { PASS_REGISTRY, type PassConfig } from "./passes.js";

  interface Props {
    passes: PassConfig;
  }

  let { passes = $bindable() }: Props = $props();
</script>

<div class="passes">
  {#each PASS_REGISTRY as { key, label } (key)}
    <label class:active={passes[key]}>
      <input type="checkbox" bind:checked={passes[key]} />
      <span>{label}</span>
    </label>
  {/each}
</div>

<style>
  .passes {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    cursor: pointer;
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--bg-surface);
    font-size: 0.75rem;
    color: var(--text-secondary);
    transition: all var(--transition);
    user-select: none;
  }

  label:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }

  label:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  label.active {
    color: var(--text);
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  input[type="checkbox"] {
    cursor: pointer;
    accent-color: var(--accent);
    width: 12px;
    height: 12px;
    margin: 0;
  }
</style>
