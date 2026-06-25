<script lang="ts">
  import type { UiController } from "../controller.svelte.js";
  import { STRINGS } from "../strings.js";

  interface Props {
    controller: UiController;
    onDismiss: () => void;
    /** Apple host only: run native Sign in with Apple. When set, the sheet shows the Apple button
     * instead of the email magic-link field. */
    onSignInWithApple?: () => void;
  }
  let { controller: c, onDismiss, onSignInWithApple }: Props = $props();
  let email = $state("");
  let sheet = $state<HTMLDivElement>();

  $effect(() => {
    sheet?.querySelector<HTMLElement>("button, input")?.focus();
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onDismiss();
  }
</script>

<div class="scrim" role="presentation" onclick={onDismiss}></div>
<div
  class="sheet"
  bind:this={sheet}
  role="dialog"
  aria-modal="true"
  aria-label={STRINGS.auth.title}
  tabindex="-1"
  onkeydown={onKeydown}
>
  <div class="grip" aria-hidden="true"></div>
  <h2>{STRINGS.auth.title}</h2>
  <p class="body">{STRINGS.auth.prompt}</p>

  {#if onSignInWithApple}
    <button class="apple" disabled={c.authFlow === "sending"} onclick={onSignInWithApple}>
      {c.authFlow === "sending" ? STRINGS.auth.signingIn : STRINGS.auth.apple}
    </button>
    {#if c.authFlow === "error"}<p class="error">{c.authError ?? STRINGS.auth.error}</p>{/if}
  {:else if c.authFlow === "sent"}
    <p class="sent">{STRINGS.auth.sent}</p>
    <button class="link" onclick={() => c.signIn(email)}>{STRINGS.auth.resend}</button>
  {:else}
    <input
      class="email"
      type="email"
      bind:value={email}
      placeholder={STRINGS.auth.emailPlaceholder}
      aria-label={STRINGS.auth.emailLabel}
    />
    <button class="primary" disabled={c.authFlow === "sending"} onclick={() => c.signIn(email)}>
      {c.authFlow === "sending" ? STRINGS.auth.sending : STRINGS.auth.send}
    </button>
    {#if c.authFlow === "error"}<p class="error">{c.authError ?? STRINGS.auth.error}</p>{/if}
  {/if}

  <button class="dismiss" onclick={onDismiss}>{STRINGS.auth.notNow}</button>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(11, 20, 48, 0.45);
  }
  .sheet {
    position: fixed;
    inset-block-end: 0;
    inset-inline: 0;
    margin-inline: auto;
    max-inline-size: 420px;
    background: var(--surface);
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    padding: var(--space-3) var(--space-6) var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .grip {
    align-self: center;
    inline-size: 36px;
    block-size: 4px;
    border-radius: 999px;
    background: var(--border);
    margin-block-end: var(--space-2);
  }
  h2 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .body {
    margin: 0;
    color: var(--ink-secondary);
  }
  .apple {
    background: #000;
    color: #fff;
    border: none;
    border-radius: var(--radius-control);
    padding: var(--space-4);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .primary {
    background: var(--still-blue);
    color: var(--on-blue);
    border: none;
    border-radius: var(--radius-control);
    padding: var(--space-4);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .email {
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    background: var(--surface);
    color: var(--ink);
  }
  .sent {
    color: var(--ink);
    margin: 0;
  }
  .error {
    color: #c2261e;
    margin: 0;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--still-blue);
    font: inherit;
    cursor: pointer;
    align-self: flex-start;
    padding: 0;
  }
  .dismiss {
    background: transparent;
    color: var(--ink-secondary);
    border: none;
    font: inherit;
    cursor: pointer;
    padding: var(--space-2);
  }
  :global(.toggle:disabled),
  button:disabled {
    opacity: 0.6;
  }
</style>
