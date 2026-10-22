<script lang="ts">
  import type { UiController } from "../controller.svelte.js";
  import { isValidEmail } from "../email.js";
  import { trapFocus } from "../focus-trap.js";
  import { STRINGS } from "../strings.js";

  interface Props {
    controller: UiController;
    onDismiss: () => void;
    /** The email step's heading and prompt, when the host that opened the sheet has its own
     * (the Apple purchase sheet, ISS-0085). The consent and code steps keep their own words. */
    title?: string;
    prompt?: string;
    /** One added line under the prompt, supplied by the host that opened the sheet. */
    note?: string;
    /** A host-supplied way to continue without signing in (Apple Get Still Pro, ISS-0071). */
    skip?: { label: string; onSkip: () => void };
    /** Which kind of surface opened the sheet. The Apple apps' full-width buttons are 54 px tall
     * and the browsers' 44 px (owner ruling, canvas fidelity check of 22 Oct 2026). */
    host?: "apple" | "browser";
  }
  let { controller: c, onDismiss, title, prompt, note, skip, host = "browser" }: Props = $props();
  let email = $state("");
  let code = $state("");
  let sheet = $state<HTMLDivElement>();
  // Where the current press and release on the dimmed layer landed (see the layer's markup).
  let pressOnLayer = false;
  let releaseOnLayer = false;
  // Firefox asks for an affirmative yes, not just an acknowledgement, so the checkbox gates its
  // Continue button. Sheet-local: it means nothing once the step is past.
  let agreedToShareEmail = $state(false);
  const consentSatisfied = $derived(
    c.emailConsent === "opt-in" ? agreedToShareEmail : true,
  );

  // Gate the send CTA on a syntactically valid address so a malformed email never fires a failing
  // auth request. The hint only appears once the user has typed something — an empty field just
  // leaves the button disabled without nagging.
  const emailValid = $derived(isValidEmail(email));
  const showEmailHint = $derived(email.trim().length > 0 && !emailValid);
  const sendDisabled = $derived(
    !emailValid || c.authFlow === "sending" || c.sendBlockRemaining > 0,
  );
  const verifyDisabled = $derived(
    code.length !== 6 ||
      c.authFlow === "verifying" ||
      c.verifyBlockRemaining > 0,
  );

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
  /** The consent step's own title, which differs in voice: Chrome states a fact, Firefox asks. */
  const consentTitle = $derived(
    c.emailConsent === "opt-in"
      ? STRINGS.emailConsent.optInTitle
      : STRINGS.emailConsent.disclosureTitle,
  );

  const codeErrorLine = $derived.by(() => {
    // The verify lock disables the Verify button straight off verifyBlockRemaining, so its
    // explanation must render whenever the lock is active — checked FIRST, independent of
    // codeErrorKind. Otherwise a resend that succeeds mid-lock (which nulls codeErrorKind) or a
    // later resend-rate-limit (which overwrites it) would leave the button silently disabled with
    // no copy (a resend does NOT lift the server-side per-IP verify throttle, so the button stays
    // disabled — it just needs its reason shown).
    if (c.verifyBlockRemaining > 0)
      return `${STRINGS.codeAuth.verifyBlocked} ${c.verifyBlockRemaining}s`;
    if (c.codeErrorKind === null) return null;
    if (c.codeErrorKind === "expired") return STRINGS.codeAuth.expiredCode;
    // The rate-limited kinds outrank suggestNewCode (R3): "send a new code" is the worst advice
    // during a lockout. Both self-clear when their lock elapses (the controller nulls the kind).
    if (c.codeErrorKind === "verify-rate-limited")
      return STRINGS.codeAuth.verifyError; // lock already elapsed; kind lingering
    if (c.codeErrorKind === "resend-rate-limited")
      return STRINGS.codeAuth.resendBlocked;
    if (c.suggestNewCode) return STRINGS.codeAuth.requestNew;
    return {
      wrong: STRINGS.codeAuth.wrongCode,
      "check-failed": STRINGS.codeAuth.verifyError,
      "resend-failed": STRINGS.codeAuth.resendError,
    }[c.codeErrorKind];
  });

  /** The resend button obeys BOTH windows — the ordinary post-send cooldown and a rate-limit
   * lock (R4) — showing whichever countdown is longer. */
  const resendWaitSeconds = $derived(
    Math.max(c.resendCooldown, c.sendBlockRemaining),
  );

  /** Keep only digits so a full pasted code (even "123 456") fills the field in one go. */
  function onCodeInput(): void {
    code = code.replace(/\D/g, "").slice(0, 6);
  }

  $effect(() => {
    // Track authFlow so focus re-lands when the view swaps (email → code entry): reading only the
    // stable `sheet` ref would run the effect once and never again, leaving focus on document.body,
    // which also breaks Escape-to-dismiss via bubbling (F8 — mirrors PaywallSheet's swap tracking).
    // The consent step is a third view, so its exit has to move focus too.
    void c.authFlow;
    void c.needsEmailConsent;
    sheet?.querySelector<HTMLElement>("button, input")?.focus();
  });
</script>

<!-- The dimmed layer holds the backdrop button and the panel side by side, so the button covers
     only the dimmed band above the panel and never sits underneath it (ISS-0114): a pointer, Voice
     Control or an automated click aimed at the button's middle reaches it. Beside a narrow panel on a
     wide page the layer itself is the dimming, and a click there closes the sheet as before; the
     button stays the one named control. Because the panel now sits inside the layer, a drag that
     starts in the panel and ends on the dimming (or the reverse) is delivered as a click on the
     layer itself, so the layer closes only when both the press and the release landed on it:
     selecting a typed address by dragging past the panel's edge must not throw it away. -->
<div
  class="layer"
  data-host={host}
  role="presentation"
  onpointerdown={(event) => {
    pressOnLayer = event.target === event.currentTarget;
    releaseOnLayer = false;
  }}
  onpointerup={(event) => {
    releaseOnLayer = event.target === event.currentTarget;
  }}
  onclick={(event) => {
    const outside =
      pressOnLayer && releaseOnLayer && event.target === event.currentTarget;
    pressOnLayer = false;
    releaseOnLayer = false;
    if (outside) onDismiss();
  }}
>
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
    aria-labelledby="still-signin-title"
    tabindex="-1"
  >
    <div class="grip" aria-hidden="true"></div>
    <!-- The dialog is named by its own heading rather than by a fixed string, because the heading
         changes on the consent step. A screen reader must not announce "sign in" on the one screen
         that is asking a question about an email address. -->
    <h2 id="still-signin-title">
      {c.needsEmailConsent ? consentTitle : (title ?? STRINGS.auth.title)}
    </h2>
    <p class="body">
      {#if c.needsEmailConsent}
        {STRINGS.emailConsent.body}
      {:else}
        {inCodeEntry
          ? STRINGS.codeAuth.prompt
          : (prompt ?? STRINGS.auth.prompt)}
      {/if}
    </p>
    {#if note}<p class="body">{note}</p>{/if}

    {#if c.needsEmailConsent}
      <!-- Nothing below this point renders until the surface's own rule is satisfied, which is the
           point: the email field does not exist yet, so no address can be typed, pasted, or sent. -->
      {#if c.emailConsent === "opt-in"}
        <label class="agree">
          <input type="checkbox" bind:checked={agreedToShareEmail} />
          <span>{STRINGS.emailConsent.agree}</span>
        </label>
      {/if}
      <button
        class="primary"
        disabled={!consentSatisfied}
        onclick={() => c.acceptEmailConsent()}
      >
        {STRINGS.emailConsent.proceed}
      </button>
    {:else if inCodeEntry}
      <form
        class="auth-form"
        novalidate
        onsubmit={(event) => {
          event.preventDefault();
          if (!verifyDisabled) void c.verifyCode(code);
        }}
      >
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
        <button type="submit" class="primary" disabled={verifyDisabled}>
          {c.authFlow === "verifying"
            ? STRINGS.codeAuth.verifying
            : STRINGS.codeAuth.verify}
        </button>
        {#if codeErrorLine}<p class="error" role="status">
            {codeErrorLine}
          </p>{/if}
        <button
          type="button"
          class="link code-step"
          disabled={resendWaitSeconds > 0}
          onclick={() => c.resendCode()}
        >
          {resendWaitSeconds > 0
            ? `${STRINGS.codeAuth.resendWait} ${resendWaitSeconds}s`
            : STRINGS.codeAuth.resend}
        </button>
        <button
          type="button"
          class="link code-step"
          onclick={() => c.useDifferentEmail()}
        >
          {STRINGS.codeAuth.differentEmail}
        </button>
      </form>
    {:else if c.authFlow === "sent"}
      <p class="sent">{STRINGS.auth.sent}</p>
      <button class="link" onclick={() => c.signIn(email)}
        >{STRINGS.auth.resend}</button
      >
    {:else}
      <form
        class="auth-form"
        novalidate
        onsubmit={(event) => {
          event.preventDefault();
          if (!sendDisabled) void c.signIn(email);
        }}
      >
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
        <button type="submit" class="primary" disabled={sendDisabled}>
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
          <!-- Code hosts get the code-flow line; authError (magic-link hosts only) never renders here.
             A live send lock (R2) shows the wait copy instead — it must never claim a code exists,
             because under the hourly cap none was ever sent. The lock's elapse clears this state. -->
          <p class="error" role="status">
            {c.sendBlockRemaining > 0
              ? `${STRINGS.codeAuth.sendBlocked} ${c.sendBlockRemaining}s`
              : c.canUseCode
                ? STRINGS.codeAuth.sendError
                : (c.authError ?? STRINGS.auth.error)}
          </p>
        {/if}
      </form>
    {/if}

    {#if skip}
      <button type="button" class="link" onclick={skip.onSkip}
        >{skip.label}</button
      >
    {/if}

    <button type="button" class="dismiss" onclick={onDismiss}>
      {c.needsEmailConsent && c.emailConsent === "opt-in"
        ? STRINGS.emailConsent.notNow
        : STRINGS.auth.cancel}
    </button>
  </div>
</div>

<style>
  .layer {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: rgba(11, 20, 48, 0.5);
    z-index: 100;
  }
  /* Grows to fill everything above the panel; the panel's own max-block-size leaves it at least
     --space-3 tall even when the panel is as tall as the page allows. The V3 pages also load the
     design system's global .scrim and .sheet (fixed to the whole page), so both rules here state
     their position outright rather than inherit that layout. */
  .scrim {
    position: relative;
    inset: auto;
    z-index: auto;
    flex: 1 0 var(--space-3);
    inline-size: 100%;
    background: transparent;
    border: 0;
    padding: 0;
  }
  /* Inward: the band touches the page's edges, where an outward ring would be clipped. */
  .scrim:focus-visible {
    outline: 2px solid var(--focus-ring, var(--still-blue));
    outline-offset: -4px;
  }
  .sheet {
    font-size: calc(16px * var(--text-scale, 1));
    line-height: 1.4;
    position: relative;
    inset: auto;
    z-index: auto;
    flex: 0 1 auto;
    min-block-size: 0;
    margin-inline: auto;
    inline-size: min(100%, var(--sheet-max-inline-size, 480px));
    /* vh fallback for older WebKit (iOS 15.0–15.3) that drops the dvh declaration below. */
    max-block-size: calc(100vh - env(safe-area-inset-top) - var(--space-3));
    max-block-size: calc(100dvh - env(safe-area-inset-top) - var(--space-3));
    /* A lighter panel than the page in dark mode, as on the owner's canvas. */
    --sheet-surface: var(--surface);
    background: var(--sheet-surface);
    color: var(--ink);
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.18);
    /* The owner's canvas (22 Oct 2026): 10 px above the grip, 20 px at the sides, 28 px below the
       last control plus the home-indicator inset. */
    padding: 10px 20px calc(28px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .auth-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-inline-size: 0;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) .sheet {
      --sheet-surface: var(--surface-raised);
    }
  }
  :global([data-theme="dark"]) .sheet {
    --sheet-surface: var(--surface-raised);
  }
  .grip {
    align-self: center;
    inline-size: 36px;
    block-size: 5px;
    border-radius: 999px;
    background: var(--border-strong);
  }
  .sheet h2 {
    text-wrap: wrap;
    margin: 0;
    font-size: calc(20px * var(--text-scale, 1));
    font-weight: 700;
    /* The design system's global .sheet h2 tightens its letters; the canvas title does not. */
    letter-spacing: normal;
  }
  .body {
    margin: 0;
    font-size: calc(15px * var(--text-scale, 1));
    color: var(--ink-secondary);
  }
  .agree {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: calc(15px * var(--text-scale, 1));
    line-height: 1.4;
    color: var(--ink);
  }
  .agree input {
    inline-size: 20px;
    block-size: 20px;
    margin: 2px 0 0;
    flex: none;
  }
  .field-label {
    color: var(--ink);
    font-size: calc(14px * var(--text-scale, 1));
    font-weight: 600;
  }
  .primary {
    background: var(--still-blue);
    color: var(--on-blue);
    border: none;
    border-radius: var(--radius-control);
    min-block-size: 44px;
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 600;
    line-height: normal;
    cursor: pointer;
  }
  .layer[data-host="apple"] .primary {
    min-block-size: 54px;
  }
  .email,
  .code {
    min-inline-size: 0;
    inline-size: 100%;
    min-block-size: 48px;
    border: 1px solid var(--input-border);
    border-radius: var(--radius-control);
    padding: 10px 14px;
    font: inherit;
    line-height: normal;
    background: var(--sheet-surface);
    color: var(--ink);
  }
  .email:focus-visible,
  .code:focus-visible {
    border-color: var(--still-blue);
  }
  .code {
    font-size: calc(20px * var(--text-scale, 1));
    letter-spacing: 0.3em;
    text-align: center;
  }
  .sent {
    color: var(--ink);
    font-size: calc(14px * var(--text-scale, 1));
    margin: 0;
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
  .hint {
    color: var(--ink-secondary);
    font-size: calc(14px * var(--text-scale, 1));
    margin: 0;
  }
  /* The secondary actions sit centred under the main button, as on the owner's canvas. */
  .link,
  .dismiss {
    background: transparent;
    border: none;
    /* --link, not --still-blue: on the dark raised panel Still Blue measures 4.4:1, under the
       4.5:1 text minimum; --link is the same blue in light mode and 5.3:1 in dark. */
    color: var(--link, var(--still-blue));
    font: inherit;
    line-height: normal;
    cursor: pointer;
    align-self: center;
    min-block-size: 44px;
    padding: 0 var(--space-2);
  }
  /* The code step's "Send a new code" and "Use a different email" are a size smaller. */
  .link.code-step {
    min-block-size: 36px;
    font-size: calc(15px * var(--text-scale, 1));
  }
  :global(.toggle:disabled) {
    opacity: 0.6;
  }
  button:disabled {
    opacity: 0.5;
  }
</style>
