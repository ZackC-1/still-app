<script lang="ts">
  import { PAID_TIER_ENABLED, SERVICE_IDS } from "@still/shared-types";
  import type { UiController } from "./controller.svelte.js";
  import Toggle from "./components/Toggle.svelte";
  import ServiceCard from "./components/ServiceCard.svelte";
  import PaywallSheet from "./components/PaywallSheet.svelte";
  import SignInSheet from "./components/SignInSheet.svelte";
  import Logo from "./components/Logo.svelte";
  import { STRINGS } from "./strings.js";
  import { PRIVACY_POLICY_URL } from "./config.js";
  import type { SurfaceGuidance } from "./surface-guidance.js";

  interface Props {
    controller: UiController;
    /** Intentional dense treatment for browser popup panels; never scale the whole interface. */
    compact?: boolean;
    onGet?: () => void;
    onRestore?: () => void;
    /** Browser- or native-surface-specific directions for finding Still after setup. */
    surfaceGuidance?: SurfaceGuidance;
    /** Deprecated Apple host hook. Kept as a no-op prop so older host wiring cannot surface SIWA. */
    onSignInWithApple?: () => void;
  }
  let {
    controller: c,
    compact = false,
    onGet,
    onRestore,
    surfaceGuidance,
  }: Props = $props();
</script>

<div class="still-ui app" data-density={compact ? "compact" : "comfortable"}>
  <header class="appbar">
    <Logo />
  </header>

  <!-- Global on/off — the hero card -->
  <section class="hero" class:off={!c.settings.globalOn}>
    <div class="hero-text">
      <h1>{c.settings.globalOn ? STRINGS.global.on : STRINGS.global.off}</h1>
      <p>
        <!-- With every service included there is one line for everyone: "on enabled sites" already
             hedges per-service state. The two paid-era alternatives below it were written for a
             free tier that removed YouTube Shorts only, where the hero had to say what the rest
             cost and had to stop claiming removal when the one included row was itself off. They
             return with the switch. -->
        {c.settings.globalOn
          ? !PAID_TIER_ENABLED || c.entitled
            ? STRINGS.global.onSecondary
            : c.settings.services.youtube
              ? STRINGS.global.onFree
              : STRINGS.global.onFreeYoutubeOff
          : STRINGS.global.offSecondary}
      </p>
    </div>
    <Toggle
      checked={c.settings.globalOn}
      label="Still on/off"
      variant={c.settings.globalOn ? "on-blue" : "default"}
      onchange={() => c.toggleGlobal()}
    />
  </section>

  <!-- Per-service cards. Pro-gated rows render locked for un-entitled users: tapping the lock is
       the Pro discovery path (paywall / sign-in first), not a toggle that silently does nothing. -->
  <div class="services" aria-disabled={!c.settings.globalOn}>
    {#each SERVICE_IDS as service (service)}
      <ServiceCard
        {service}
        on={c.settings.globalOn && c.settings.services[service]}
        onchange={() => c.toggleService(service)}
        locked={c.isLocked(service)}
        disabled={!c.settings.globalOn}
        onLockedTap={() => c.lockedTap()}
      />
    {/each}
  </div>

  {#if surfaceGuidance}
    <section class="guidance card" aria-labelledby="surface-guidance-title">
      <h2 id="surface-guidance-title">{surfaceGuidance.title}</h2>
      <p>{surfaceGuidance.body}</p>
    </section>
  {/if}

  <!-- Per-site pause UI removed 2026-07-06 (founder call: popup must fit one panel; feature may
       return). The controller/cache pause mutators went with it (R1) — only the dormant `pauses`
       settings field and engine.isPaused remain as the seam for its return. -->

  <!-- Account management (App Store 5.1.1): privacy policy link + in-app account deletion. -->
  {#snippet accountManagement()}
    <div class="account">
      <a
        class="link"
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        {STRINGS.account.privacyPolicy}
      </a>
      {#if c.canDeleteAccount}
        {#if c.deleteFlow === "confirming"}
          <div
            class="confirm"
            role="group"
            aria-label={STRINGS.account.deleteConfirmTitle}
          >
            <p class="danger-note">{STRINGS.account.deleteConfirmBody}</p>
            <button
              class="danger-solid"
              onclick={() => c.confirmDeleteAccount()}
            >
              {STRINGS.account.deleteConfirm}
            </button>
            <button class="link" onclick={() => c.cancelDeleteAccount()}
              >{STRINGS.account.deleteCancel}</button
            >
          </div>
        {:else if c.deleteFlow === "deleting"}
          <button class="link" disabled>{STRINGS.account.deleting}</button>
        {:else}
          <button class="link danger" onclick={() => c.requestDeleteAccount()}
            >{STRINGS.account.delete}</button
          >
          {#if c.deleteFlow === "error"}<p class="error">
              {c.deleteError ?? STRINGS.account.deleteError}
            </p>{/if}
        {/if}
      {/if}
    </div>
  {/snippet}

  <!-- Sync / account section: renders the popup state matrix. The PAID_TIER_ENABLED checks in this
       section hide the buy and restore calls to action while the paid tier is dormant, leaving
       sign-in as the only thing this card offers. Where the alternative branch was written for a
       different audience, the check wraps that whole branch, so hiding a purchase affordance shows
       nothing in its place rather than falling through to a line meant for somebody else. The
       signed-out check just below joins its condition instead, because both sides of that one read
       correctly for a free user: with no purchase to offer, sign-in becomes the primary button.
       The branches themselves are preserved, not deleted. -->
  <section class="sync card" data-state={c.popupState}>
    {#if !PAID_TIER_ENABLED}
      <!-- Naming the section is what keeps the invitation calm: someone reading it can see that
           this card is about settings following them between devices, and about nothing else. -->
      <h2 class="sync-title">{STRINGS.sync.sectionTitle}</h2>
    {/if}
    {#if c.popupState === "signed-out"}
      {#if c.canSignIn}
        {#if PAID_TIER_ENABLED && c.host.canPurchase}
          <button class="primary block" onclick={() => c.startUpgrade()}>
            {STRINGS.paywall.upgradeCta}
          </button>
          <button class="secondary block" onclick={() => c.openSignIn()}>
            {STRINGS.auth.signInCta}
          </button>
        {:else}
          <p class="muted">{STRINGS.sync.signedOut}</p>
          <button class="primary block" onclick={() => c.openSignIn()}>
            {STRINGS.auth.signInCta}
          </button>
        {/if}
      {:else if PAID_TIER_ENABLED}
        <!-- No auth path on this host (the browser extensions, until U10): a sign-in CTA here
             would silently do nothing, so show the quiet explanatory note instead. -->
        <p class="muted">{STRINGS.paywall.nonApple}</p>
      {:else}
        <!-- The Safari extension popup, which has no sign-in path of its own and, under App Store
             Review Guideline 4.4, carries no invitation to create an account either. It states the
             plain fact; the host app is where signing in is offered. -->
        <p class="muted">{STRINGS.sync.deviceOnly}</p>
      {/if}
      <a
        class="link center"
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        {STRINGS.account.privacyPolicy}
      </a>
    {:else if c.popupState === "pro-no-account"}
      <!-- Receipt-entitled with no session (purchase-first, R3/R9): Pro is ACTIVE — never a buy
           CTA here (startUpgrade would no-op against it). Sign-in stays visible as the path to
           the other surfaces, and the settings-row Restore (R4) lives here for returners. -->
      <p class="synced">{STRINGS.proNoAccount.active}</p>
      <p class="muted">{STRINGS.proNoAccount.hint}</p>
      {#if c.canSignIn}
        <button class="secondary block" onclick={() => c.openSignIn()}>
          {STRINGS.auth.signInCta}
        </button>
      {/if}
      {#if PAID_TIER_ENABLED}
        <!-- Restore has nothing to report while the paid tier is dormant: the native action is
             refused and its answer only ever renders inside the paywall sheet, so the control
             would look tappable and do nothing at all. The device still proves its own purchase
             through the receipt read, which runs on its own and is untouched. -->
        <button
          class="link"
          onclick={() => {
            if (onRestore && c.beginRestore()) onRestore();
          }}
        >
          {STRINGS.paywall.restoreSignedOut}
        </button>
      {/if}
      <a
        class="link center"
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        {STRINGS.account.privacyPolicy}
      </a>
    {:else if c.popupState === "not-entitled"}
      {#if PAID_TIER_ENABLED}
        {#if c.host.canPurchase}
          <div class="syncrow">
            <div class="syncrow-text">
              <span class="syncrow-title">{STRINGS.paywall.title}</span>
              <span class="syncrow-sub">{STRINGS.paywall.body}</span>
            </div>
            <button class="primary block" onclick={() => c.startUpgrade()}
              >{STRINGS.paywall.upgradeCta}</button
            >
          </div>
        {:else}
          <p class="muted">{STRINGS.paywall.nonApple}</p>
        {/if}
      {/if}
      <button class="link" onclick={() => c.signOut()}
        >{STRINGS.auth.signOut}</button
      >
      {@render accountManagement()}
    {:else if c.popupState === "pro-device-only"}
      <!-- Signed in with receipt-only Pro: honest copy — the ACCOUNT isn't entitled (attach
           ineligible, e.g. family-shared, or not yet landed), so never claim sync. Device Pro
           already unlocks the rows above. -->
      <p class="synced">{STRINGS.proNoAccount.active}</p>
      <button class="link" onclick={() => c.signOut()}
        >{STRINGS.auth.signOut}</button
      >
      {@render accountManagement()}
    {:else if c.popupState === "entitlement-pending"}
      <p class="muted">{STRINGS.sync.pending}</p>
    {:else if c.popupState === "entitled-syncing"}
      <p class="synced">{STRINGS.sync.syncing}</p>
      <button class="link" onclick={() => c.signOut()}
        >{STRINGS.auth.signOut}</button
      >
      {@render accountManagement()}
    {:else if c.popupState === "cloud-unreachable"}
      <p class="muted">{STRINGS.sync.unreachable}</p>
      <button class="link" onclick={() => c.signOut()}
        >{STRINGS.auth.signOut}</button
      >
    {/if}
  </section>

  {#if c.signInOpen && (c.popupState === "signed-out" || c.popupState === "pro-no-account")}
    <SignInSheet controller={c} onDismiss={() => c.dismissSignIn()} />
  {/if}

  <!-- The sheet also opens on hosts without a purchase path (locked-row taps in the extensions):
       it renders its explanatory state there instead of a buy CTA (R19). During the payoff
       (U3/R6) the sheet stays mounted showing the success payoff while the service rows above —
       already reactive to c.entitled — render live-and-on behind it.
       The whole sheet is kept and left unreachable while the paid tier is dormant behind
       PAID_TIER_ENABLED. This is the last gate: any other route that sets paywallOpen, such as a
       purchase intent left over from an older install, still renders nothing. -->
  {#if PAID_TIER_ENABLED && c.paywallOpen}
    <PaywallSheet
      canPurchase={c.host.canPurchase}
      price={c.paywallPrice}
      purchaseFlow={c.purchaseFlow}
      purchaseError={c.purchaseError}
      checkoutFlow={c.checkoutFlow}
      justUnlocked={c.justUnlocked}
      successScreen={c.successScreen}
      signedOut={c.userId === null}
      onCreateAccount={() => c.createAccountFromSuccess()}
      onGet={() => {
        // Web-purchasable hosts (the injected checkout seam, U4/U6) hand off to a checkout tab;
        // Apple hosts keep the native in-place purchase through the host's onGet closure.
        if (c.canWebCheckout) void c.startWebCheckout();
        else if (onGet && c.beginPurchase()) onGet();
      }}
      onRestore={() => {
        if (onRestore && c.beginRestore()) onRestore();
      }}
      onStartOver={() => c.abandonCheckout()}
      onReSignIn={() => c.reSignInFromCheckout()}
      onDismiss={() => c.dismissPaywall()}
    />
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    gap: var(--app-gap, var(--space-3));
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 432px;
    padding: var(--app-padding, var(--space-4));
    padding-block-start: calc(
      var(--app-padding, var(--space-4)) + env(safe-area-inset-top)
    );
    padding-block-end: calc(
      var(--app-padding, var(--space-4)) + env(safe-area-inset-bottom)
    );
    /* Center in hosts wider than the content cap (the 480pt macOS window, the options tab).
       Popups size themselves to the content, so this is a no-op there. */
    margin-inline: auto;
    background: var(--surface);
  }
  .appbar {
    padding: var(
      --appbar-padding,
      var(--space-1) var(--space-1) var(--space-2)
    );
  }

  /* Hero global card */
  .hero {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    background: var(--still-blue);
    color: var(--on-blue);
    border-radius: var(--radius-sheet);
    padding: var(--hero-padding, var(--space-6));
  }
  .hero.off {
    background: var(--surface-raised);
    color: var(--ink);
  }
  .hero-text {
    flex: 1;
    min-inline-size: 0;
  }
  .hero h1 {
    margin: 0 0 4px;
    font-size: var(--hero-title-size, 25px);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .hero p {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.35;
    color: var(--on-blue-secondary);
  }
  .hero.off p {
    color: var(--ink-secondary);
  }

  .services {
    display: flex;
    flex-direction: column;
    gap: var(--services-gap, var(--space-2));
  }
  .services[aria-disabled="true"] {
    opacity: 0.5;
    pointer-events: none;
  }

  .card {
    background: var(--surface-raised);
    border-radius: var(--radius-card);
  }
  .sync-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--ink-secondary);
  }
  .sync {
    display: flex;
    flex-direction: column;
    gap: var(--sync-gap, var(--space-3));
    padding: var(--sync-padding, var(--space-4));
  }
  .guidance {
    padding: var(--sync-padding, var(--space-4));
  }
  .guidance h2 {
    margin: 0 0 var(--space-1);
    font-size: 15px;
    font-weight: 600;
  }
  .guidance p {
    margin: 0;
    color: var(--ink-secondary);
    font-size: 13.5px;
    line-height: 1.4;
  }
  .syncrow {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }
  .syncrow-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-inline-size: 0;
  }
  .syncrow-title {
    font-size: 16px;
    font-weight: 600;
  }
  .syncrow-sub {
    font-size: 13.5px;
    color: var(--ink-secondary);
  }
  .muted {
    color: var(--ink-secondary);
    margin: 0;
  }
  .synced {
    color: var(--ink);
    margin: 0;
    font-weight: 500;
  }
  .error {
    color: #c2261e;
    margin: 0;
  }

  .primary {
    background: var(--still-blue);
    color: var(--on-blue);
    border: none;
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .primary.block {
    inline-size: 100%;
    min-block-size: 44px;
    padding: var(--block-button-padding, var(--space-4));
    font-size: 16px;
  }
  .primary:hover {
    background: var(--still-blue-pressed);
  }
  .primary:active {
    transform: translateY(1px);
  }
  .secondary {
    background: transparent;
    color: var(--still-blue);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .secondary.block {
    inline-size: 100%;
    min-block-size: 44px;
    padding: var(--block-button-padding, var(--space-4));
    font-size: 16px;
  }
  .secondary:hover {
    background: var(--surface);
    border-color: var(--border-strong);
  }

  .link {
    background: transparent;
    border: none;
    color: var(--still-blue);
    font: inherit;
    cursor: pointer;
    padding: 0;
    align-self: flex-start;
    text-decoration: none;
  }
  .link.center {
    align-self: center;
  }
  .link:hover {
    color: var(--still-blue-pressed);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link:disabled {
    color: var(--ink-secondary);
    cursor: default;
  }
  .account {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-block-start: var(--space-1);
    padding-block-start: var(--space-3);
    border-block-start: 1px solid var(--border);
  }
  .link.danger {
    color: #c2261e;
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .danger-note {
    color: var(--ink-secondary);
    margin: 0;
    font-size: 14px;
  }
  .danger-solid {
    background: #c2261e;
    color: #fff;
    border: none;
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    align-self: flex-start;
  }
  .danger-solid:hover {
    background: #a91f19;
  }

  .app[data-density="compact"] {
    --app-gap: var(--space-2);
    --app-padding: var(--space-2);
    --appbar-padding: 0 0 var(--space-1);
    --hero-padding: var(--space-3);
    --hero-title-size: 21px;
    --service-card-padding-block: var(--space-2);
    --service-card-padding-inline: var(--space-3);
    --service-icon-size: 36px;
    --service-name-size: 16px;
    --service-status-size: 13px;
    --services-gap: var(--space-1);
    --sync-gap: var(--space-1);
    --sync-padding: var(--space-2);
    --block-button-padding: var(--space-2) var(--space-3);
    --logo-mark-size: 24px;
    --logo-word-size: 18px;
  }

  @media (max-height: 700px) {
    .app:not([data-density="compact"]) {
      --app-gap: var(--space-2);
      --app-padding: var(--space-3);
      --appbar-padding: 0 0 var(--space-1);
      --hero-padding: var(--space-4);
      --hero-title-size: 22px;
      --service-card-padding-block: var(--space-2);
      --service-card-padding-inline: var(--space-3);
      --service-icon-size: 36px;
      --service-name-size: 16px;
      --service-status-size: 13px;
      --sync-gap: var(--space-2);
      --sync-padding: var(--space-3);
    }
  }
</style>
