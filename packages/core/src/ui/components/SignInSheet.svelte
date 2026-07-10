<script lang="ts">
  import type { UiController } from "../controller.svelte.js";
  import { isValidEmail } from "../email.js";
  import { trapFocus } from "../focus-trap.js";
  import { STRINGS } from "../strings.js";

  interface Props {
    controller: UiController;
    onDismiss: () => void;
  }
  let { controller: c, onDismiss }: Props = $props();
  let email = $state("");
  let code = $state("");
  let sheet = $state<HTMLDivElement>();

  // Gate the send CTA on a syntactically valid address so a malformed email never fires a failing
  // auth request. The hint only appears once the user has typed something — an empty field just
  // leaves the button disabled without nagging.
  const emailValid = $derived(isValidEmail(email));
  const showEmailHint = $derived(email.trim().length > 0 && !emailValid);

  $effect(() =>
    trapFocus({
      container: () => sheet,
      focusable: "button, input",
      onDismiss: () => onDismiss(),
    }),
  );

  // Code-entry (plan U2/R1): one plain input, no segmented boxes. Which states show it, and the
  // calm line for each failure kind (never raw backend text, never the magic-link copy).
  const inCodeEntry = $derived(
    c.canUseCode &&
      (c.authFlow === "code-entry" ||
        c.authFlow === "verifying" ||
        c.authFlow === "code-error"),
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
    // Track authFlow so focus re-lands when the view swaps (email → code entry): reading only the
    // stable `sheet` ref would run the effect once and never again, leaving focus on document.body,
    // which also breaks Escape-to-dismiss via bubbling (F8 — mirrors PaywallSheet's swap tracking).
    void c.authFlow;
    sheet?.querySelector<HTMLElement>("button, input")?.focus();
  });
</script>

<button
  type="button"
  class="scrim"
  aria-label={STRINGS.auth.dismissLabel}
  tabindex="-1"
  onclick={onDismiss}
></button>
<div
  class="sheet"
  bind:this={sheet}
  role="dialog"
  aria-modal="true"
  aria-label={STRINGS.auth.title}
  tabindex="-1"
>
  <div class="grip" aria-hidden="true"></div>
  <h2>{STRINGS.auth.title}</h2>
  <p class="body">
    {inCodeEntry ? STRINGS.codeAuth.prompt : STRINGS.auth.prompt}
  </p>

  {#if inCodeEntry}
    <p class="sent">{STRINGS.codeAuth.sentTo} {c.codeEmail}</p>
    <label class="field-label" for="still-code"
      >{STRINGS.codeAuth.codeLabel}</label
    >
    <input
      id="still-code"
      class="code"
      name="code"
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      autocomplete="one-time-code"
      spellcheck="false"
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
      {c.authFlow === "verifying"
        ? STRINGS.codeAuth.verifying
        : STRINGS.codeAuth.verify}
    </button>
    {#if codeErrorLine}<p class="error" role="status">{codeErrorLine}</p>{/if}
    <button
      class="link"
      disabled={c.resendCooldown > 0}
      onclick={() => c.resendCode()}
    >
      {c.resendCooldown > 0
        ? `${STRINGS.codeAuth.resendWait} ${c.resendCooldown}s`
        : STRINGS.codeAuth.resend}
    </button>
    <button class="link" onclick={() => c.useDifferentEmail()}>
      {STRINGS.codeAuth.differentEmail}
    </button>
  {:else if c.authFlow === "sent"}
    <p class="sent">{STRINGS.auth.sent}</p>
    <button class="link" onclick={() => c.signIn(email)}
      >{STRINGS.auth.resend}</button
    >
  {:else}
    <label class="field-label" for="still-email"
      >{STRINGS.auth.emailLabel}</label
    >
    <input
      id="still-email"
      class="email"
      type="email"
      name="email"
      autocomplete="email"
      autocapitalize="none"
      spellcheck="false"
      bind:value={email}
      placeholder={STRINGS.auth.emailPlaceholder}
      aria-invalid={showEmailHint}
      aria-describedby={showEmailHint ? "still-email-hint" : undefined}
    />
    <button
      class="primary"
      disabled={!emailValid || c.authFlow === "sending"}
      onclick={() => c.signIn(email)}
    >
      {c.authFlow === "sending"
        ? STRINGS.auth.sending
        : c.canUseCode
          ? STRINGS.codeAuth.send
          : STRINGS.auth.send}
    </button>
    {#if showEmailHint}
      <p id="still-email-hint" class="hint" role="status">
        {STRINGS.auth.invalidEmail}
      </p>
    {/if}
    {#if c.authFlow === "error"}
      <!-- Code hosts get the code-flow line; authError (magic-link hosts only) never renders here. -->
      <p class="error" role="status">
        {c.canUseCode
          ? STRINGS.codeAuth.sendError
          : (c.authError ?? STRINGS.auth.error)}
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
    border: 0;
    padding: 0;
    z-index: 100;
  }
  .sheet {
    position: fixed;
    inset-block-end: 0;
    inset-inline: 0;
    margin-inline: auto;
    inline-size: min(100%, 420px);
    /* vh fallback for older WebKit (iOS 15.0–15.3) that drops the dvh declaration below. */
    max-block-size: calc(100vh - env(safe-area-inset-top) - var(--space-3));
    max-block-size: calc(100dvh - env(safe-area-inset-top) - var(--space-3));
    background: var(--surface);
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    padding: var(--space-3) var(--space-6)
      calc(var(--space-6) + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow-y: auto;
    overscroll-behavior: contain;
    z-index: 101;
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
  .field-label {
    margin-block-end: calc(var(--space-2) * -1);
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
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
  .email:focus-visible,
  .code:focus-visible {
    border-color: var(--still-blue);
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
    color: var(--danger);
    margin: 0;
  }
  .hint {
    color: var(--ink-secondary);
    font-size: 14px;
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
