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
  let code = $state("");
  let sheet = $state<HTMLDivElement>();

  // Code-entry (plan U2/R1): one plain input, no segmented boxes. Which states show it, and the
  // calm line for each failure kind (never raw backend text, never the magic-link copy).
  const inCodeEntry = $derived(
    c.canUseCode &&
      (c.authFlow === "code-entry" || c.authFlow === "verifying" || c.authFlow === "code-error"),
  );
  const codeErrorLine = $derived.by(() => {
    if (c.codeErrorKind === null) return null;
    if (c.codeErrorKind === "expired") return STRINGS.codeAuth.expiredCode;
    if (c.suggestNewCode) return STRINGS.codeAuth.requestNew;
    return {
      wrong: STRINGS.codeAuth.wrongCode,
      "check-failed": STRINGS.codeAuth.verifyError,
      "resend-failed": STRINGS.codeAuth.resendError,
    }[c.codeErrorKind];
  });

  /** Keep only digits so a full pasted code (even "123 456") fills the field in one go. */
  function onCodeInput(): void {
    code = code.replace(/\D/g, "").slice(0, 6);
  }

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
  <p class="body">{inCodeEntry ? STRINGS.codeAuth.prompt : STRINGS.auth.prompt}</p>

  {#if onSignInWithApple}
    <button class="apple" disabled={c.authFlow === "sending"} onclick={onSignInWithApple}>
      {c.authFlow === "sending" ? STRINGS.auth.signingIn : STRINGS.auth.apple}
    </button>
    {#if c.authFlow === "error"}<p class="error">{c.authError ?? STRINGS.auth.error}</p>{/if}
  {:else if inCodeEntry}
    <p class="sent">{STRINGS.codeAuth.sentTo} {c.codeEmail}</p>
    <input
      class="code"
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      autocomplete="one-time-code"
      maxlength="6"
      bind:value={code}
      oninput={onCodeInput}
      aria-label={STRINGS.codeAuth.codeLabel}
    />
    <button
      class="primary"
      disabled={code.length !== 6 || c.authFlow === "verifying"}
      onclick={() => c.verifyCode(code)}
    >
      {c.authFlow === "verifying" ? STRINGS.codeAuth.verifying : STRINGS.codeAuth.verify}
    </button>
    {#if codeErrorLine}<p class="error">{codeErrorLine}</p>{/if}
    <button class="link" disabled={c.resendCooldown > 0} onclick={() => c.resendCode()}>
      {c.resendCooldown > 0
        ? `${STRINGS.codeAuth.resendWait} ${c.resendCooldown}s`
        : STRINGS.codeAuth.resend}
    </button>
    <button class="link" onclick={() => c.useDifferentEmail()}>
      {STRINGS.codeAuth.differentEmail}
    </button>
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
      {c.authFlow === "sending"
        ? STRINGS.auth.sending
        : c.canUseCode
          ? STRINGS.codeAuth.send
          : STRINGS.auth.send}
    </button>
    {#if c.authFlow === "error"}
      <!-- Code hosts get the code-flow line; authError (magic-link hosts only) never renders here. -->
      <p class="error">
        {c.canUseCode ? STRINGS.codeAuth.sendError : (c.authError ?? STRINGS.auth.error)}
      </p>
    {/if}
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
  .email,
  .code {
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    background: var(--surface);
    color: var(--ink);
  }
  .code {
    letter-spacing: 0.3em;
    text-align: center;
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
