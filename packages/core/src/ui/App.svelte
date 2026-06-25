<script lang="ts">
  import { SERVICE_IDS } from "@still/shared-types";
  import type { UiController } from "./controller.svelte.js";
  import Toggle from "./components/Toggle.svelte";
  import SettingsRow from "./components/SettingsRow.svelte";
  import ServiceCard from "./components/ServiceCard.svelte";
  import PaywallSheet from "./components/PaywallSheet.svelte";
  import { STRINGS } from "./strings.js";

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
    {:else if c.popupState === "entitlement-pending"}
      <p class="muted">{STRINGS.sync.pending}</p>
    {:else if c.popupState === "entitled-syncing"}
      <p class="synced">{STRINGS.sync.syncing}</p>
      <button class="link" onclick={() => c.signOut()}>{STRINGS.auth.signOut}</button>
    {:else if c.popupState === "cloud-unreachable"}
      <p class="muted">{STRINGS.sync.unreachable}</p>
    {/if}
  </section>

  {#if c.paywallOpen && c.host.canPurchase}
    <PaywallSheet
      canPurchase={c.host.canPurchase}
      onGet={() => {
        onGet?.();
        c.dismissPaywall();
      }}
      onRestore={() => onRestore?.()}
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
</style>
