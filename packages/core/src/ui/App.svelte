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
    onGet?: () => void;
    onRestore?: () => void;
    /** Apple host only: run native Sign in with Apple. When set, the sign-in sheet shows the Apple
     * button instead of the email magic-link field (the Chromium extension keeps email). */
    onSignInWithApple?: () => void;
  }
  let { controller: c, onGet, onRestore, onSignInWithApple }: Props = $props();
</script>

<div class="still-ui app">
  <header class="appbar">
    <Logo />
  </header>

  <!-- Global on/off — the hero card -->
  <section class="hero" class:off={!c.settings.globalOn}>
    <div class="hero-text">
      <h1>{c.settings.globalOn ? STRINGS.global.on : STRINGS.global.off}</h1>
      <p>{STRINGS.global.secondary}</p>
    </div>
    <Toggle
      checked={c.settings.globalOn}
      label="Still on/off"
      variant={c.settings.globalOn ? "on-blue" : "default"}
      onchange={() => c.toggleGlobal()}
    />
  </section>

  <!-- Per-service cards -->
  <div class="services" aria-disabled={!c.settings.globalOn}>
    {#each SERVICE_IDS as service (service)}
      <ServiceCard
        {service}
        on={c.settings.globalOn && c.settings.services[service]}
        onchange={() => c.toggleService(service)}
      />
    {/each}
  </div>

  <!-- Per-site pause (only where there's an active host: popup, not options page) -->
  {#if c.host.currentHost}
    <section class="pause card">
      <span class="pause-label">{c.currentPaused ? STRINGS.pause.pausedNote : c.host.currentHost}</span>
      <button class="link" onclick={() => c.togglePause()}>
        {c.currentPaused ? STRINGS.pause.resume : STRINGS.pause.pause}
      </button>
    </section>
  {/if}

  <!-- Account management (App Store 5.1.1): privacy policy link + in-app account deletion. -->
  {#snippet accountManagement()}
    <div class="account">
      <a class="link" href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
        {STRINGS.account.privacyPolicy}
      </a>
      {#if c.canDeleteAccount}
        {#if c.deleteFlow === "confirming"}
          <div class="confirm" role="group" aria-label={STRINGS.account.deleteConfirmTitle}>
            <p class="danger-note">{STRINGS.account.deleteConfirmBody}</p>
            <button class="danger-solid" onclick={() => c.confirmDeleteAccount()}>
              {STRINGS.account.deleteConfirm}
            </button>
            <button class="link" onclick={() => c.cancelDeleteAccount()}>{STRINGS.account.deleteCancel}</button>
          </div>
        {:else if c.deleteFlow === "deleting"}
          <button class="link" disabled>{STRINGS.account.deleting}</button>
        {:else}
          <button class="link danger" onclick={() => c.requestDeleteAccount()}>{STRINGS.account.delete}</button>
          {#if c.deleteFlow === "error"}<p class="error">{c.deleteError ?? STRINGS.account.deleteError}</p>{/if}
        {/if}
      {/if}
    </div>
  {/snippet}

  <!-- Sync / account section: renders the popup state matrix -->
  <section class="sync card" data-state={c.popupState}>
    {#if c.popupState === "signed-out"}
      <p class="muted">{STRINGS.auth.prompt}</p>
      <button class="primary block" onclick={() => c.openSignIn()}>
        {onSignInWithApple ? STRINGS.auth.apple : STRINGS.auth.signInCta}
      </button>
      <a class="link center" href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
        {STRINGS.account.privacyPolicy}
      </a>
    {:else if c.popupState === "not-entitled"}
      {#if c.host.canPurchase}
        <div class="syncrow">
          <div class="syncrow-text">
            <span class="syncrow-title">{STRINGS.paywall.title}</span>
            <span class="syncrow-sub">{STRINGS.paywall.body}</span>
          </div>
          <button class="primary" onclick={() => c.openPaywall()}>{STRINGS.paywall.cta}</button>
        </div>
      {:else}
        <p class="muted">{STRINGS.paywall.nonApple}</p>
      {/if}
      <button class="link" onclick={() => c.signOut()}>{STRINGS.auth.signOut}</button>
      {@render accountManagement()}
    {:else if c.popupState === "entitlement-pending"}
      <p class="muted">{STRINGS.sync.pending}</p>
    {:else if c.popupState === "entitled-syncing"}
      <p class="synced">{STRINGS.sync.syncing}</p>
      <button class="link" onclick={() => c.signOut()}>{STRINGS.auth.signOut}</button>
      {@render accountManagement()}
    {:else if c.popupState === "cloud-unreachable"}
      <p class="muted">{STRINGS.sync.unreachable}</p>
      <button class="link" onclick={() => c.signOut()}>{STRINGS.auth.signOut}</button>
    {/if}
  </section>

  {#if c.signInOpen}
    <SignInSheet controller={c} {onSignInWithApple} onDismiss={() => c.dismissSignIn()} />
  {/if}

  {#if c.paywallOpen && c.host.canPurchase}
    <PaywallSheet
      canPurchase={c.host.canPurchase}
      price={c.paywallPrice}
      purchaseFlow={c.purchaseFlow}
      purchaseError={c.purchaseError}
      onGet={() => {
        if (c.beginPurchase()) onGet?.();
      }}
      onRestore={() => {
        if (c.beginRestore()) onRestore?.();
      }}
      onDismiss={() => c.dismissPaywall()}
    />
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    min-inline-size: 320px;
    max-inline-size: 400px;
    background: var(--surface);
  }
  .appbar {
    padding: var(--space-1) var(--space-1) var(--space-2);
  }

  /* Hero global card */
  .hero {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    background: var(--still-blue);
    color: #fff;
    border-radius: var(--radius-sheet);
    padding: var(--space-6);
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
    font-size: 25px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .hero p {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.82);
  }
  .hero.off p {
    color: var(--ink-secondary);
  }

  .services {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .services[aria-disabled="true"] {
    opacity: 0.5;
    pointer-events: none;
  }

  .card {
    background: var(--surface-raised);
    border-radius: var(--radius-card);
  }
  .pause {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
  }
  .pause-label {
    font-size: 15px;
    color: var(--ink-secondary);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sync {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }
  .syncrow {
    display: flex;
    align-items: center;
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
    padding: var(--space-4);
    font-size: 16px;
  }
  .primary:hover {
    background: var(--still-blue-pressed);
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
</style>
