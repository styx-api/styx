<script lang="ts">
  interface Props {
    passes: {
      flatten: boolean;
      simplify: boolean;
      removeEmpty: boolean;
      canonicalize: boolean;
    };
  }

  let { passes = $bindable() }: Props = $props();

  const passLabels: { key: keyof typeof passes; label: string }[] = [
    { key: "flatten", label: "Flatten" },
    { key: "simplify", label: "Simplify" },
    { key: "removeEmpty", label: "Remove Empty" },
    { key: "canonicalize", label: "Canonicalize" },
  ];
</script>

<div class="passes">
  {#each passLabels as { key, label }}
    <label class:active={passes[key]}>
      <input type="checkbox" bind:checked={passes[key]} />
      <span>{label}</span>
    </label>
  {/each}
</div>

<style>
  .passes {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
    margin-left: auto;
  }

  label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius);
    font-size: 0.75rem;
    color: var(--text-muted);
    transition: all var(--transition);
    user-select: none;
  }

  label:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  label.active {
    color: var(--text-secondary);
  }

  input[type="checkbox"] {
    cursor: pointer;
    accent-color: var(--accent);
    width: 12px;
    height: 12px;
  }
</style>
