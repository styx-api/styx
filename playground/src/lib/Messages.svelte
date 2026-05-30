<script lang="ts">
  interface Message {
    message: string;
    location?: { file?: string; line?: number; column?: number };
  }

  interface Props {
    type: "errors" | "warnings";
    messages: Message[];
  }

  let { type, messages }: Props = $props();

  function formatLocation(loc?: { file?: string; line?: number; column?: number }) {
    if (!loc) return "";
    const parts = [loc.file, loc.line && `line ${loc.line}`, loc.column && `col ${loc.column}`];
    return parts.filter(Boolean).join(", ");
  }
</script>

<section class="messages" class:errors={type === "errors"} class:warnings={type === "warnings"}>
  <header>
    <span class="label">{type === "errors" ? "Errors" : "Warnings"}</span>
    <span class="count">{messages.length}</span>
  </header>
  {#each messages as msg, i (i)}
    <div class="message">
      <span class="msg-text">{msg.message}</span>
      {#if msg.location}
        <span class="msg-loc">{formatLocation(msg.location)}</span>
      {/if}
    </div>
  {/each}
</section>

<style>
  .messages {
    border-bottom: 1px solid var(--border);
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    background: var(--bg-elevated);
  }

  .label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .count {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius);
  }

  .errors .label {
    color: var(--error);
  }

  .errors .count {
    color: var(--error);
    background: var(--error-subtle);
  }

  .warnings .label {
    color: var(--warning);
  }

  .warnings .count {
    color: var(--warning);
    background: var(--warning-subtle);
  }

  .message {
    padding: 0.375rem 0.75rem;
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-family: var(--font-mono);
    font-size: var(--font-size-mono);
  }

  .message + .message {
    border-top: 1px solid var(--border-subtle);
  }

  .errors .msg-text {
    color: var(--error);
  }

  .warnings .msg-text {
    color: var(--warning);
  }

  .msg-loc {
    color: var(--text-muted);
    white-space: nowrap;
    font-size: 0.75rem;
  }
</style>
