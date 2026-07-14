<script lang="ts">
  import { SERVICE_IDS } from "@still/shared-types";
  import type { UiController } from "./controller.svelte.js";
  import Toggle from "./components/Toggle.svelte";
  import ServiceCard from "./components/ServiceCard.svelte";
  import PaywallSheet from "./components/PaywallSheet.svelte";
  import SignInSheet from "./components/SignInSheet.svelte";
  import Logo from "./components/Logo.svelte";
  import { STRINGS } from "./strings.js";
  import { PRIVACY_POLICY_URL } from "./config.js";

  interface Props {
    controller: UiController;
    /** Intentional dense treatment for browser popup panels; never scale the whole interface. */
    compact?: boolean;
    onGet?: () => void;
    onRestore?: () => void;
    /** Deprecated Apple host hook. Kept as a no-op prop so older host wiring cannot surface SIWA. */
    onSignInWithApple?: () => void;
  }
  let { controller: c, compact = false, onGet, onRestore }: Props = $props();
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
        <!-- The free line claims "Shorts are removed", which is only true while the YouTube row —
             the free tier's one service — is itself on; row-off gets the truthful sibling line.
             Pro needs no gate: "on enabled sites" already hedges per-service state. -->
        {c.settings.globalOn
          ? c.entitled
            ? STRINGS.global.onPro
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

  <!-- Sync / account section: renders the popup state matrix -->
  <section class="sync card" data-state={c.popupState}>
    {#if c.popupState === "signed-out"}
      {#if c.canSignIn}
        {#if c.host.canPurchase}
          <button class="primary block" onclick={() => c.startUpgrade()}>
            {STRINGS.paywall.upgradeCta}
          </button>
          <button class="secondary block" onclick={() => c.openSignIn()}>
            {STRINGS.auth.signInCta}
          </button>
        {:else}
          <button class="primary block" onclick={() => c.openSignIn()}>
            {STRINGS.auth.signInCta}
          </button>
        {/if}
      {:else}
        <!-- No auth path on this host (the browser extensions, until U10): a sign-in CTA here
             would silently do nothing, so show the quiet explanatory note instead. -->
        <p class="muted">{STRINGS.paywall.nonApple}</p>
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

  {#if c.signInOpen && c.popupState === "signed-out"}
    <SignInSheet controller={c} onDismiss={() => c.dismissSignIn()} />
  {/if}

  <!-- The sheet also opens on hosts without a purchase path (locked-row taps in the extensions):
       it renders its explanatory state there instead of a buy CTA (R19). During the payoff
       (U3/R6) the sheet stays mounted showing the success payoff while the service rows above —
       already reactive to c.entitled — render live-and-on behind it. -->
  {#if c.paywallOpen}
    <PaywallSheet
      canPurchase={c.host.canPurchase}
      price={c.paywallPrice}
      purchaseFlow={c.purchaseFlow}
      purchaseError={c.purchaseError}
      checkoutFlow={c.checkoutFlow}
      justUnlocked={c.justUnlocked}
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
  .sync {
    display: flex;
    flex-direction: column;
    gap: var(--sync-gap, var(--space-3));
    padding: var(--sync-padding, var(--space-4));
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
