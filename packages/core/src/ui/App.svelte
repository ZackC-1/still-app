<script lang="ts">
  import {
    PAID_TIER_ENABLED,
    SERVICE_IDS,
    type ServiceId,
  } from "@still/shared-types";
  import type { UiController } from "./controller.svelte.js";
  import Toggle from "./components/Toggle.svelte";
  import ServiceCard from "./components/ServiceCard.svelte";
  import PaywallSheet from "./components/PaywallSheet.svelte";
  import SignInSheet from "./components/SignInSheet.svelte";
  import Logo from "./components/Logo.svelte";
  import { STRINGS } from "./strings.js";
  import { PRIVACY_POLICY_URL, SETUP_GUIDE_URL } from "./config.js";
  import type { SurfaceGuidance } from "./surface-guidance.js";
  import type { CommittedPopupBinding, CommittedPopupToggle } from "./index.js";
  import { createPopupViewBinding } from "./v3/popup-view-binding.svelte.js";
  import {
    createLegacyPopupViewBinding,
    type LegacyPopupAuthority,
  } from "./v3/legacy-popup-view-binding.svelte.js";
  import type { Component } from "svelte";
  import type { DesktopPopupProps } from "./v3/presentation.js";
  import type { ExtensionSettingsProps } from "./v3/extension-settings-presentation.js";

  interface Props {
    controller: UiController;
    /** Optional actual committed settings authority; absent preserves every legacy host. */
    committedPopupBinding?: CommittedPopupBinding;
    legacyPopupAuthority?: LegacyPopupAuthority;
    onCommittedPopupToggle?: (toggle: CommittedPopupToggle) => void;
    /** Actual desktop browser host opts in with its existing options-page operation. */
    popupPresentation?: {
      browser: "Chrome" | "Firefox";
      onSettings: () => void;
      onSeePro?: () => void;
      loadDesktop: () => Promise<{ default: Component<DesktopPopupProps> }>;
      sectionMemory?: DesktopPopupProps["sectionMemory"];
    };
    /** Actual Chromium options host owns the loader and help operations. */
    settingsPresentation?: {
      browser: "Chrome" | "Firefox";
      loadSettings: () => Promise<{
        default: Component<ExtensionSettingsProps>;
      }>;
      help: ExtensionSettingsProps["help"];
      sectionMemory?: ExtensionSettingsProps["sectionMemory"];
      /** The rows to draw (a phone surface omits switches that cannot act there); omitted: all. */
      features?: ExtensionSettingsProps["features"];
      /** A confirmed phone platform only (see ExtensionSettingsProps["phone"]). */
      phone?: ExtensionSettingsProps["phone"];
    };
    /** Intentional dense treatment for browser popup panels; never scale the whole interface. */
    compact?: boolean;
    onGet?: () => void;
    onRestore?: () => void;
    /** Enables access to the online setup guide on settings surfaces. */
    surfaceGuidance?: SurfaceGuidance;
    /** Deprecated Apple host hook. Kept as a no-op prop so older host wiring cannot surface SIWA. */
    onSignInWithApple?: () => void;
  }
  let {
    controller: c,
    committedPopupBinding,
    legacyPopupAuthority,
    onCommittedPopupToggle,
    popupPresentation,
    settingsPresentation,
    compact = false,
    onGet,
    onRestore,
    surfaceGuidance,
  }: Props = $props();
  const popupView = createPopupViewBinding(
    () => committedPopupBinding,
    reportCommitted,
  );
  const legacyView = createLegacyPopupViewBinding(
    () => legacyPopupAuthority,
    () => c,
    reportCommitted,
  );
  let popupState = $derived(popupView.state);
  let choices = $derived(
    committedPopupBinding
      ? (popupView.settings ?? null)
      : legacyPopupAuthority
        ? legacyView.settings
        : c.settings,
  );
  let held = $derived(legacyPopupAuthority ? legacyView.held : popupView.held);
  let settingsUnavailable = $derived(
    legacyPopupAuthority
      ? legacyView.settingsUnavailable
      : popupView.settingsUnavailable,
  );
  let settingsRecovery = $derived(
    legacyPopupAuthority ? legacyView.recovering : popupView.recovering,
  );
  function recoverSettings(): void {
    if (legacyPopupAuthority) {
      legacyView.recoverSettings();
      return;
    }
    // An ownership pause clears only through this account's own settings read, never a local
    // reread, so Try again also asks sync to read the account again (it shares any read in flight).
    const reason = committedPopupBinding?.current().reason;
    if (
      c.userId &&
      (reason === "ownership-hold" || reason === "ownership-unconfirmed")
    )
      runSyncRetry();
    popupView.recoverSettings();
  }
  let desktopPresentation = $derived(
    committedPopupBinding ? popupPresentation : undefined,
  );
  let DesktopPopup = $state<Component<DesktopPopupProps> | null>(null);
  $effect(() => {
    const loadDesktop = desktopPresentation?.loadDesktop;
    if (!loadDesktop || DesktopPopup) return;
    let active = true;
    // The reference CSS contains global tokens. Load it only in this explicit host,
    // keeping the original stylesheet on Safari, options and default App routes.
    void loadDesktop()
      .then((module) => {
        if (active) DesktopPopup = module.default;
      })
      .catch(() => {
        /* Account/privacy operations remain available without fabricated controls. */
      });
    return () => {
      active = false;
    };
  });
  let settingsHost = $derived(
    committedPopupBinding ? settingsPresentation : undefined,
  );
  let loadedSettings = $state.raw<{
    host: NonNullable<Props["settingsPresentation"]>;
    controller: UiController;
    binding: CommittedPopupBinding;
    component: Component<ExtensionSettingsProps>;
  } | null>(null);
  $effect(() => {
    const host = settingsHost;
    const controller = c;
    const binding = committedPopupBinding;
    loadedSettings = null;
    if (!host || !binding) return;
    let active = true;
    void host
      .loadSettings()
      .then((module) => {
        if (
          active &&
          host === settingsHost &&
          controller === c &&
          binding === committedPopupBinding &&
          binding.current().reason !== "stopped"
        )
          loadedSettings = {
            host,
            controller,
            binding,
            component: module.default,
          };
      })
      .catch(() => {
        /* Actual account, privacy and help remain usable; never invent saved choices. */
      });
    return () => {
      active = false;
    };
  });
  let SettingsPresentation = $derived(
    loadedSettings?.host === settingsHost &&
      loadedSettings?.controller === c &&
      loadedSettings?.binding === committedPopupBinding
      ? loadedSettings.component
      : null,
  );
  let modern = $derived(popupView.settings);
  let syncRetryLifetime = 0;
  $effect.pre(() => {
    // Track controller attachments even on legacy hosts without a binding.
    void c;
    syncRetryLifetime += 1;
    return () => {
      syncRetryLifetime += 1;
    };
  });
  function runSyncRetry(): void {
    const controller = c;
    const revision = controller.accountRevision;
    const lifetime = syncRetryLifetime;
    void controller.retrySync?.().catch(() => {
      if (
        syncRetryLifetime === lifetime &&
        c === controller &&
        controller.accountRevision === revision
      )
        controller.cloudReachable = false;
    });
  }
  let desktopAccount = $derived.by((): DesktopPopupProps["account"] => {
    if (!c.userId) return undefined;
    return {
      address: c.accountEmail ?? undefined,
      status: !c.cloudReachable
        ? {
            tone: "failed",
            text: STRINGS.sync.failed,
            retry: c.retrySync ? runSyncRetry : undefined,
          }
        : c.pendingUpload
          ? { tone: "pending", text: STRINGS.sync.syncing }
          : c.lastSyncedAt !== null
            ? { tone: "success", text: STRINGS.sync.synced }
            : { tone: "pending", text: STRINGS.sync.checking },
    };
  });
  let desktopCommands = $derived(popupView.commands);
  let settingsReady = $derived(
    Boolean(
      settingsHost &&
      popupView.settings &&
      popupState &&
      desktopCommands &&
      SettingsPresentation,
    ),
  );
  // The controller epoch is not reactive; re-read it with account/status notifications.
  // Equal epoch values keep the operation callbacks stable through routine polling.
  let optionsAccountRevision = $derived.by(() => {
    void c.userId;
    void c.accountEmail;
    void c.cloudReachable;
    void c.pendingUpload;
    void c.lastSyncedAt;
    return c.accountRevision;
  });
  // Account operations belong to the current attachment, independently of sync polling.
  let optionsOperations = $derived.by(() => {
    const controller = c;
    const identity = controller.userId;
    const revision = optionsAccountRevision;
    const address = controller.accountEmail;
    const lifetime = syncRetryLifetime;
    const host = settingsHost;
    const binding = committedPopupBinding;
    const view = loadedSettings;
    const current = () =>
      view !== null &&
      view === loadedSettings &&
      c === controller &&
      controller.userId === identity &&
      controller.accountRevision === revision &&
      controller.accountEmail === address &&
      syncRetryLifetime === lifetime &&
      settingsHost === host &&
      committedPopupBinding === binding &&
      binding?.current().reason !== "stopped";
    return {
      onSignIn:
        !identity && controller.canSignIn
          ? () => {
              if (current()) controller.openSignIn();
            }
          : undefined,
      onRetry: controller.retrySync
        ? () => {
            if (current()) runSyncRetry();
          }
        : undefined,
      onSignOut: () => {
        if (current()) void controller.signOut();
      },
      onDeleteAccount:
        controller.canDeleteAccount && controller.deleteFlow !== "deleting"
          ? () => {
              if (
                current() &&
                controller.canDeleteAccount &&
                controller.deleteFlow !== "deleting"
              )
                void controller.confirmDeleteAccount();
            }
          : undefined,
      // "Delete shared data on all devices": only while the build offers it (controller.sharedData
      // is null otherwise) and no request is on its way.
      onDeleteSharedData:
        identity && !controller.sharedDataSending
          ? () => {
              if (current() && !controller.sharedDataSending)
                void controller.confirmDeleteSharedData();
            }
          : undefined,
      onRetrySharedData:
        identity && !controller.sharedDataSending
          ? () => {
              if (current() && !controller.sharedDataSending)
                void controller.retryDeleteSharedData();
            }
          : undefined,
    };
  });
  // The account-wide deletion's state, read for each signed-in account the settings page shows.
  $effect(() => {
    if (!settingsHost) return;
    void c.userId;
    void c.loadSharedData();
  });
  $effect(() => {
    if (!settingsHost || !PAID_TIER_ENABLED) return;
    void c.userId;
    void optionsAccountRevision;
    void c.refreshAccountConfirmation();
  });
  $effect(() => {
    if (!settingsHost || !PAID_TIER_ENABLED) return;
    const current = c;
    const refresh = () => void current.refreshAccountConfirmation();
    const foreground = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", foreground);
    };
  });
  let optionsSync = $derived.by((): ExtensionSettingsProps["sync"] => {
    const controller = c;
    const operations = optionsOperations;
    const identity = controller.userId;
    if (!identity) return { onSignIn: operations.onSignIn };
    return {
      account: {
        address: controller.accountEmail ?? undefined,
        identity,
        revision: optionsAccountRevision,
        confirmed: controller.accountConfirmed,
        status: !controller.cloudReachable
          ? {
              tone: "failed",
              text: STRINGS.sync.failed,
              actionLabel: controller.retrySync
                ? STRINGS.sync.tryAgain
                : undefined,
              onAction: operations.onRetry,
            }
          : controller.pendingUpload
            ? { tone: "pending", text: STRINGS.sync.syncing }
            : controller.lastSyncedAt !== null
              ? { tone: "success", text: STRINGS.sync.synced }
              : { tone: "pending", text: STRINGS.sync.checking },
        onSignOut: operations.onSignOut,
        onDeleteAccount: operations.onDeleteAccount,
        sharedData:
          controller.sharedData && controller.sharedData.account === identity
            ? {
                withdrawal: controller.sharedData.withdrawal,
                stoppedElsewhere: controller.sharedData.stoppedElsewhere,
                onDelete: operations.onDeleteSharedData,
                onRetry: operations.onRetrySharedData,
              }
            : undefined,
      },
    };
  });
  const coreBenefit = {
    youtube: "youtube.shorts",
    instagram: "instagram.reels",
    facebook: "facebook.reels",
    tiktok: "tiktok.all",
  } as const;
  function serviceAvailable(service: ServiceId): boolean {
    if (!committedPopupBinding) return true;
    const access = popupState?.access.states[coreBenefit[service]];
    return (
      access === "free" || access === "protected" || access === "purchased"
    );
  }
  function reportCommitted(toggle: CommittedPopupToggle): void {
    try {
      onCommittedPopupToggle?.(toggle);
    } catch {
      /* Telemetry never changes the saved outcome. */
    }
  }
  function toggleGlobal(): void {
    if (legacyPopupAuthority) {
      legacyView.toggle();
      return;
    }
    const binding = committedPopupBinding;
    if (!binding) {
      c.toggleGlobal();
      return;
    }
    const state = binding.current();
    if (!state.settings || state.commandAvailability !== "ready") return;
    const enabled = !state.settings.globalOn;
    popupView.runPopupCommand(binding, () => binding.setGlobalOn(enabled), {
      enabled,
    });
  }
  function toggleService(service: ServiceId): void {
    if (legacyPopupAuthority) {
      legacyView.toggle(service);
      return;
    }
    const binding = committedPopupBinding;
    if (!binding) {
      c.toggleService(service);
      return;
    }
    const state = binding.current();
    const access = state.access.states[coreBenefit[service]];
    if (
      !state.settings ||
      !state.settings.globalOn ||
      state.commandAvailability !== "ready" ||
      (access !== "free" && access !== "protected" && access !== "purchased")
    )
      return;
    const enabled = !state.settings.services[service];
    popupView.runPopupCommand(
      binding,
      () => binding.setService(service, enabled),
      {
        service,
        enabled,
      },
    );
  }
</script>

<div
  class="still-ui"
  class:app={!settingsReady &&
    (!desktopPresentation || !modern || !DesktopPopup)}
  class:v3-popup-host={Boolean(desktopPresentation)}
  data-density={compact ? "compact" : "comfortable"}
  data-settings-receipt={legacyPopupAuthority
    ? (legacyView.state?.status ?? "loading")
    : undefined}
>
  {#if settingsHost && modern && popupState && desktopCommands && SettingsPresentation}
    <SettingsPresentation
      settings={modern}
      access={popupState.access}
      commandsDisabled={held}
      onGlobalChange={desktopCommands.global}
      onServiceChange={desktopCommands.service}
      onFeatureChange={desktopCommands.feature}
      sectionMemory={settingsHost.sectionMemory}
      features={settingsHost.features}
      phone={settingsHost.phone}
      sync={{ ...optionsSync, accountActions: optionsAccountActions }}
      privacyActions={usageActions}
      help={settingsHost.help}
    />
  {:else if desktopPresentation && modern && popupState && desktopCommands && DesktopPopup}
    <DesktopPopup
      settings={modern}
      access={popupState.access}
      {...{ browser: desktopPresentation.browser }}
      commandsDisabled={held}
      onGlobalChange={desktopCommands.global}
      onServiceChange={desktopCommands.service}
      onFeatureChange={desktopCommands.feature}
      onSignIn={!c.userId && c.canSignIn ? () => c.openSignIn() : undefined}
      onSettings={desktopPresentation.onSettings}
      onSeePro={desktopPresentation.onSeePro}
      sectionMemory={desktopPresentation.sectionMemory}
      privacyUrl={PRIVACY_POLICY_URL}
      account={desktopAccount}
      accountActions={c.userId || settingsUnavailable
        ? desktopAccountActions
        : undefined}
    />
  {:else}
    {#if !desktopPresentation && !settingsHost}
      <header class="appbar">
        <Logo />
      </header>
    {/if}

    {#if choices && !desktopPresentation && !settingsHost}
      <!-- Global on/off — the hero card -->
      <section class="hero" class:off={!choices.globalOn}>
        <div class="hero-text">
          <h1>{choices.globalOn ? STRINGS.global.on : STRINGS.global.off}</h1>
          <p>
            <!-- With every service included there is one line for everyone: "on enabled sites" already
             hedges per-service state. The two paid-era alternatives below it were written for a
             free tier that removed YouTube Shorts only, where the hero had to say what the rest
             cost and had to stop claiming removal when the one included row was itself off. They
             return with the switch. -->
            {choices.globalOn
              ? committedPopupBinding || !PAID_TIER_ENABLED || c.entitled
                ? STRINGS.global.onSecondary
                : choices.services.youtube
                  ? STRINGS.global.onFree
                  : STRINGS.global.onFreeYoutubeOff
              : STRINGS.global.offSecondary}
          </p>
        </div>
        <Toggle
          checked={choices.globalOn}
          label="Still on/off"
          variant={choices.globalOn ? "on-blue" : "default"}
          disabled={held}
          onchange={toggleGlobal}
        />
      </section>

      <!-- Per-service cards. Pro-gated rows render locked for un-entitled users: tapping the lock is
       the Pro discovery path (paywall / sign-in first), not a toggle that silently does nothing. -->
      <div class="services" aria-disabled={!choices.globalOn || held}>
        {#each SERVICE_IDS as service (service)}
          <ServiceCard
            {service}
            on={choices.globalOn && choices.services[service]}
            onchange={() => toggleService(service)}
            locked={!committedPopupBinding && c.isLocked(service)}
            disabled={!choices.globalOn || held || !serviceAvailable(service)}
            onLockedTap={() => c.lockedTap()}
          />
        {/each}
      </div>
    {:else if (!desktopPresentation && !settingsHost && !settingsUnavailable) || popupView.reading}
      <p class="muted" role="status">{STRINGS.sync.checking}</p>
    {/if}
  {/if}

  {#if !settingsReady && (!desktopPresentation || !modern || !popupState || !desktopCommands || !DesktopPopup)}
    {@render settingsRecoveryAction()}
  {/if}

  {#if surfaceGuidance && !settingsHost}
    <a
      class="link setup-guide"
      href={SETUP_GUIDE_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      How to set up Still
    </a>
  {/if}

  <!-- Usage sharing. The one-time notice appears where sharing starts on (Chrome and the Apple
       apps) and carries its own off switch, so the compact popup needs no extra row. In the popup it
       floats over the bottom edge until answered, because the browser refuses a popup taller than
       600px and the popup already uses that height. Roomier surfaces show it inline and keep a
       permanent settings row; Firefox, where sharing starts off, uses that row to ask. -->
  {#snippet usageActions()}
    {#if c.usageNoticeVisible}
      <section class="usage-notice card" aria-live="polite">
        <p class="muted">{STRINGS.usage.notice}</p>
        <div class="usage-notice-actions">
          <button class="link" onclick={() => c.toggleUsageSharing()}
            >{STRINGS.usage.noticeTurnOff}</button
          >
          <button class="secondary" onclick={() => c.dismissUsageNotice()}
            >{STRINGS.usage.noticeOk}</button
          >
        </div>
      </section>
    {/if}
    {#if c.usageSharing !== null && !compact}
      <section class="usage card">
        <div class="usage-text">
          <span class="usage-title">{STRINGS.usage.title}</span>
          <span class="usage-sub">{STRINGS.usage.body}</span>
        </div>
        <Toggle
          checked={c.usageSharing}
          label={STRINGS.usage.title}
          onchange={() => c.toggleUsageSharing()}
        />
      </section>
    {/if}
  {/snippet}
  {#if !settingsReady}{@render usageActions()}{/if}

  <!-- Per-site pause UI removed 2026-07-06 (founder call: popup must fit one panel; feature may
       return). The controller/cache pause mutators went with it (R1) — only the dormant `pauses`
       settings field and engine.isPaused remain as the seam for its return. -->

  <!-- Account management (App Store 5.1.1): privacy policy link + in-app account deletion. -->
  {#snippet accountManagement(includePrivacy = true)}
    <div class="account">
      {#if compact}
        <button class="link" onclick={() => c.signOut()}
          >{STRINGS.auth.signOut}</button
        >
      {/if}
      {#if includePrivacy}<a
          class="link"
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {STRINGS.account.privacyPolicy}
        </a>{/if}
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
  {#snippet settingsRecoveryAction()}
    {#if settingsUnavailable}
      <p class="muted" role="status">Settings are unavailable.</p>
      <button
        class="secondary block"
        disabled={Boolean(settingsRecovery)}
        onclick={recoverSettings}>Try again</button
      >
    {/if}
  {/snippet}
  {#snippet desktopAccountActions()}
    {#if c.userId}
      {@render accountManagement(false)}
      {#if c.lastSyncedAt !== null}
        <p class="sync-time">
          {STRINGS.sync.lastSynced}
          <time datetime={new Date(c.lastSyncedAt).toISOString()}
            >{new Date(c.lastSyncedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}</time
          >
        </p>
      {/if}
    {/if}
    {@render settingsRecoveryAction()}
  {/snippet}

  {#snippet optionsAccountActions()}
    {#if c.userId && c.lastSyncedAt !== null}
      <p class="sync-time">
        {STRINGS.sync.lastSynced}
        <time datetime={new Date(c.lastSyncedAt).toISOString()}
          >{new Date(c.lastSyncedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}</time
        >
      </p>
    {/if}
    {#if c.userId && c.deleteFlow === "deleting"}<p role="status">
        {STRINGS.account.deleting}
      </p>{/if}
    {#if c.userId && c.deleteFlow === "error"}<p class="error" role="alert">
        {c.deleteError ?? STRINGS.account.deleteError}
      </p>{/if}
    {@render settingsRecoveryAction()}
  {/snippet}

  <!-- Sync / account section: renders the popup state matrix. The PAID_TIER_ENABLED checks in this
       section hide the buy and restore calls to action while the paid tier is dormant, leaving
       sign-in as the only thing this card offers. Where the alternative branch was written for a
       different audience, the check wraps that whole branch, so hiding a purchase affordance shows
       nothing in its place rather than falling through to a line meant for somebody else. The
       signed-out check just below joins its condition instead, because both sides of that one read
       correctly for a free user: with no purchase to offer, sign-in becomes the primary button.
       The branches themselves are preserved, not deleted. -->
  {#if !settingsReady && (!desktopPresentation || !modern || !DesktopPopup)}
    <section class="sync card" data-state={c.popupState}>
      {#if !PAID_TIER_ENABLED}
        <!-- Naming the section is what keeps the invitation calm: someone reading it can see that
           this card is about settings following them between devices, and about nothing else. -->
        <h2 class="sync-title">{STRINGS.sync.sectionTitle}</h2>
      {/if}
      {#if c.userId && c.accountEmail}
        <p class="account-email">{c.accountEmail}</p>
      {/if}
      {#if c.accountManagedByApp}
        {#if !c.userId || !compact}
          <p class="muted">
            {c.userId ? STRINGS.sync.appManaged : STRINGS.sync.deviceOnly}
          </p>
        {/if}
        {#if c.userId}
          {#if !compact || (c.cloudReachable && !c.pendingUpload)}
            <p class="muted">
              {c.extensionMatchesApp === true
                ? STRINGS.sync.extensionCurrent
                : STRINGS.sync.extensionChecking}
            </p>
          {/if}
          {#if !c.cloudReachable || c.pendingUpload}
            <p class="muted">{STRINGS.sync.extensionPending}</p>
          {/if}
        {/if}
        {#if !desktopPresentation && !settingsHost}<a
            class="link"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noopener noreferrer">{STRINGS.account.privacyPolicy}</a
          >{/if}
      {:else if c.popupState === "signed-out"}
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
        {#if !desktopPresentation && !settingsHost}<a
            class="link center"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {STRINGS.account.privacyPolicy}
          </a>{/if}
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
        {#if !desktopPresentation && !settingsHost}<a
            class="link center"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {STRINGS.account.privacyPolicy}
          </a>{/if}
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
        {#if !compact}
          <button class="link" onclick={() => c.signOut()}
            >{STRINGS.auth.signOut}</button
          >
        {/if}
        {@render accountManagement(!desktopPresentation && !settingsHost)}
      {:else if c.popupState === "pro-device-only"}
        <!-- Signed in with receipt-only Pro: honest copy — the ACCOUNT isn't entitled (attach
           ineligible, e.g. family-shared, or not yet landed), so never claim sync. Device Pro
           already unlocks the rows above. -->
        <p class="synced">{STRINGS.proNoAccount.active}</p>
        {#if !compact}
          <button class="link" onclick={() => c.signOut()}
            >{STRINGS.auth.signOut}</button
          >
        {/if}
        {@render accountManagement(!desktopPresentation && !settingsHost)}
      {:else if c.popupState === "entitlement-pending"}
        <p class="muted">{STRINGS.sync.pending}</p>
      {:else if c.popupState === "entitled-syncing"}
        <p class="synced">
          {c.pendingUpload
            ? STRINGS.sync.syncing
            : c.lastSyncedAt !== null
              ? STRINGS.sync.synced
              : STRINGS.sync.checking}
        </p>
        {#if !compact}
          <button class="link" onclick={() => c.signOut()}
            >{STRINGS.auth.signOut}</button
          >
        {/if}
        {@render accountManagement(!desktopPresentation && !settingsHost)}
      {:else if c.popupState === "cloud-unreachable"}
        <p class="muted">{STRINGS.sync.unreachable}</p>
        {#if c.retrySync}
          <button class="link" onclick={runSyncRetry}
            >{STRINGS.sync.retry}</button
          >
        {/if}
        {#if desktopPresentation}{@render accountManagement(false)}{:else}
          <button class="link" onclick={() => c.signOut()}
            >{STRINGS.auth.signOut}</button
          >
        {/if}
      {/if}
      {#if c.userId && c.lastSyncedAt !== null}
        <p class="sync-time">
          {c.accountManagedByApp
            ? STRINGS.sync.appLastSynced
            : STRINGS.sync.lastSynced}
          <time datetime={new Date(c.lastSyncedAt).toISOString()}
            >{new Date(c.lastSyncedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}</time
          >
        </p>
      {/if}
    </section>
  {/if}
  {#if settingsHost && !settingsReady}
    <section class="sync card">
      <h2 class="sync-title">Help</h2>
      <button
        type="button"
        class="link"
        disabled={!settingsHost.help.onGuide}
        onclick={settingsHost.help.onGuide}>Setup guide</button
      >
      <button
        type="button"
        class="link"
        disabled={!settingsHost.help.onSupport}
        onclick={settingsHost.help.onSupport}>Contact support</button
      >
      <button
        type="button"
        class="link"
        disabled={!settingsHost.help.onPrivacy}
        onclick={settingsHost.help.onPrivacy}>Privacy policy</button
      >
    </section>
  {/if}
  {#if desktopPresentation && (!modern || !DesktopPopup)}
    <footer class="popup-footer">
      <button
        type="button"
        class="open-options"
        aria-label={`Settings. Find Still in ${desktopPresentation.browser}.`}
        onclick={desktopPresentation.onSettings}>Settings</button
      >
      <a class="link" href={PRIVACY_POLICY_URL}>Privacy policy</a>
    </footer>
  {/if}

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
  .account-email {
    margin: 0;
    overflow-wrap: anywhere;
    font-weight: 500;
  }
  .sync-time {
    margin: 0;
    font-size: 12px;
    color: var(--ink-secondary);
  }

  .app {
    display: flex;
    flex-direction: column;
    gap: var(--app-gap, var(--space-3));
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: var(--content-max-inline-size, 432px);
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
    padding-inline: var(--service-card-padding-inline, var(--space-4));
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
  .setup-guide {
    font-size: 14px;
  }
  .usage {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--sync-padding, var(--space-4));
  }
  .usage-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-inline-size: 0;
  }
  .usage-title {
    font-size: 15px;
    font-weight: 600;
  }
  .usage-sub {
    font-size: 13px;
    color: var(--ink-secondary);
  }
  .app[data-density="compact"] .usage-notice,
  .v3-popup-host[data-density="compact"] .usage-notice {
    position: fixed;
    inset-inline: var(--space-3);
    bottom: var(--space-3);
    z-index: 10;
    border: 1px solid var(--ink-secondary);
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
  }
  .usage-notice {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    padding: var(--space-3);
    font-size: 13px;
  }
  .usage-notice-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--space-3);
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
    /* Leave room for the configured sign-in card within the desktop popup's 600px height. */
    --app-gap: var(--space-1);
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
    --sync-padding: var(--space-1);
    --block-button-padding: var(--space-2) var(--space-3);
    --logo-mark-size: 24px;
    --logo-word-size: 18px;
  }

  .app[data-density="compact"] .account {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-2) var(--space-3);
    padding-block-start: var(--space-1);
    margin-block-start: 0;
    font-size: 14px;
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
