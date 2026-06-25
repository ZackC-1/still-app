<script lang="ts">
  import { SERVICE_IDS } from "@still/shared-types";
  import type { UiController } from "./controller.svelte.js";
  import Toggle from "./components/Toggle.svelte";
  import SettingsRow from "./components/SettingsRow.svelte";
  import ServiceCard from "./components/ServiceCard.svelte";
  import PaywallSheet from "./components/PaywallSheet.svelte";
  import { STRINGS } from "./strings.js";
  import { PRIVACY_POLICY_URL } from "./config.js";

  interface Props {
    controller: UiController;
    onGet?: () => void;
    onRestore?: () => void;
    /** Apple host only: run native Sign in with Apple. When set, the signed-out state shows the
     * Apple button instead of the email magic-link field (the Chromium extension keeps email). */
    onSignInWithApple?: () => void;
  }
  let { controller: c, onGet, onRestore, onSignInWithApple }: Props = $props();

  let email = $state("");
</script>

<div class="still-ui app">
  <!-- Global on/off -->
  <section class="global card" class:off={!c.settings.globalOn}>
    <SettingsRow
      label={c.settings.globalOn ? STRINGS.global.on : STRINGS.global.off}
      secondary={STRINGS.global.secondary}
    >
      {#snippet control()}
        <Toggle checked={c.settings.globalOn} label="Still on/off" onchange={() => c.toggleGlobal()} />
      {/snippet}
    </SettingsRow>
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
    <section class="card">
      <SettingsRow label={c.currentPaused ? STRINGS.pause.pausedNote : c.host.currentHost}>
        {#snippet control()}
          <button class="link" onclick={() => c.togglePause()}>
            {c.currentPaused ? STRINGS.pause.resume : STRINGS.pause.pause}
          </button>
        {/snippet}
      </SettingsRow>
    </section>
  {/if}

  <!-- Account management (App Store 5.1.1): privacy policy link + in-app account deletion. Shown in
       every signed-in state. Delete is gated on a wired deleteAccount dep (canDeleteAccount). -->
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
      {#if onSignInWithApple}
        <button
          class="primary"
          disabled={c.authFlow === "sending"}
          onclick={onSignInWithApple}
        >
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
    {:else if c.popupState === "not-entitled"}
      {#if c.host.canPurchase}
        <SettingsRow label={STRINGS.paywall.title} secondary={STRINGS.paywall.body}>
          {#snippet control()}
            <button class="primary" onclick={() => c.openPaywall()}>{STRINGS.paywall.cta}</button>
          {/snippet}
        </SettingsRow>
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
    {/if}
  </section>

  {#if c.paywallOpen && c.host.canPurchase}
    <PaywallSheet
      canPurchase={c.host.canPurchase}
      purchaseFlow={c.purchaseFlow}
      purchaseError={c.purchaseError}
      onGet={() => {
        // Stay open through the purchase; the host reports the outcome and dismisses only on success.
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
  }
  .card {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
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
  .sync {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
  }
  .muted {
    color: var(--ink-secondary);
    margin: 0;
  }
  .error {
    color: #c2261e;
    margin: 0;
  }
  .email {
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    padding: var(--space-3);
    font: inherit;
    background: var(--surface);
    color: var(--ink);
  }
  .primary {
    background: var(--still-blue);
    color: var(--on-blue);
    border: none;
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--still-blue);
    font: inherit;
    cursor: pointer;
    padding: 0;
    align-self: flex-start;
  }
  .link:disabled {
    color: var(--ink-secondary);
    cursor: default;
  }
  .account {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-block-start: var(--space-2);
    padding-block-start: var(--space-2);
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
  }
  .danger-solid {
    background: #c2261e;
    color: #fff;
    border: none;
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    align-self: flex-start;
  }
</style>
