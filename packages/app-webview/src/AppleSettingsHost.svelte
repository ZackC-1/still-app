<script lang="ts">
  // D04 Apple settings host: prop plumbing only. Every rule lives in @still/core's tested
  // apple-settings-host module and the existing committed popup view binding. The entry reaches
  // this file only through a dynamic import that default builds fold away, so AppleSettings and
  // its global stylesheet exist only in bundles that opt in. The leaf is imported by file path
  // (as the Chromium popup imports DesktopPopup), through this package's dependency link so the
  // app-webview `rootDir` check treats core as a dependency, not as local source.
  import AppleSettings from "../node_modules/@still/core/src/ui/v3/AppleSettings.svelte";
  import SettingsSwitch from "../node_modules/@still/core/src/ui/v3/Toggle.svelte";
  import {
    STRINGS,
    SignInSheet,
    createPopupViewBinding,
    createAppleSettingsSync,
    appleSettingsRestore,
    createAppleSettingsRestore,
    watchAppleSetup,
    type AppleRestoreBridge,
    type AppleSettingsAuthority,
    type AppleSettingsProps,
    type CommittedPopupToggle,
    type UiController,
  } from "@still/core/ui";
  import type { NativeBridge } from "@still/core/native";

  interface Props {
    controller: UiController;
    /** Committed binding, access and recovery over the entry's one cache; stopped on unmount. */
    authority: AppleSettingsAuthority;
    /** Native setup observation (NativeBridge.observeSafariSetup), bounded in core. */
    observeSetup: NativeBridge["observeSafariSetup"];
    help: AppleSettingsProps["help"];
    /** Native restore and receipt reads for the free-period Restore link; absent, no link. */
    restoreBridge?: AppleRestoreBridge;
    onCommittedToggle?: (toggle: CommittedPopupToggle) => void;
  }
  let {
    controller: c,
    authority,
    observeSetup,
    help,
    restoreBridge,
    onCommittedToggle,
  }: Props = $props();

  const view = createPopupViewBinding(
    () => authority.binding,
    (toggle) => onCommittedToggle?.(toggle),
  );
  $effect(() => {
    const current = authority;
    return () => current.stop();
  });
  const syncFor = createAppleSettingsSync();
  let sync = $derived(syncFor(c));
  // Free-period Restore (owner decision 17): its own status, or a controller-driven one.
  let restoreStatus = $state.raw<AppleSettingsProps["restore"]>(undefined);
  function nativeRestore(): AppleRestoreBridge {
    if (!restoreBridge) throw new Error("No native restore");
    return restoreBridge;
  }
  const freeRestore = createAppleSettingsRestore({
    bridge: {
      restore: () => nativeRestore().restore(),
      receiptStatus: () => nativeRestore().receiptStatus(),
    },
    refreshAccess: () => authority.entitlement.refreshAccess(),
    publish: (next) => (restoreStatus = next),
  });
  $effect(() => () => freeRestore.stop());
  let restore = $derived(restoreStatus ?? appleSettingsRestore(c));
  // Platform starts as the narrower iOS inventory and follows any later successful observation.
  let platform = $state<AppleSettingsProps["platform"]>("ios");
  let setup = $state.raw<AppleSettingsProps["setup"]>(undefined);
  $effect(() =>
    watchAppleSetup(observeSetup, (next) => {
      setup = next.setup;
      if (next.platform) platform = next.platform;
    }),
  );
  // Until the first native read settles, a hold is "checking", not "unavailable".
  let reading = $state(true);
  let recovering = $state(false);
  $effect(() => {
    let live = true;
    void authority.settled.then(() => {
      if (live) reading = false;
    });
    return () => {
      live = false;
    };
  });
  function retry(): void {
    if (recovering) return;
    recovering = true;
    void authority.recover().finally(() => {
      recovering = false;
    });
  }
</script>

<!-- The existing Apple usage-sharing control and copy, driven by the native analytics consent
     through the controller. It is not the combined email-plus-usage choice. -->
{#snippet usageActions()}
  {#if c.usageNoticeVisible}
    <section class="card card-stack" aria-live="polite">
      <p class="muted">{STRINGS.usage.notice}</p>
      <div class="inline-actions">
        <button
          type="button"
          class="link"
          onclick={() => c.toggleUsageSharing()}
          >{STRINGS.usage.noticeTurnOff}</button
        >
        <button
          type="button"
          class="secondary"
          onclick={() => c.dismissUsageNotice()}>{STRINGS.usage.noticeOk}</button
        >
      </div>
    </section>
  {/if}
  {#if c.usageSharing !== null}
    <section class="card card-stack">
      <div class="sync-row">
        <div class="sync-row-text">
          <span
            class="row-title"
            id="usage-sharing-title"
            style="font-size:calc(15px * var(--text-scale, 1));font-weight:600;"
            >{STRINGS.usage.title}</span
          ><span class="muted sync-row-sub" id="usage-sharing-body"
            >{STRINGS.usage.body}</span
          >
        </div>
        <SettingsSwitch
          checked={c.usageSharing}
          labelledBy="usage-sharing-title"
          describedBy="usage-sharing-body"
          onChange={() => c.toggleUsageSharing()}
        />
      </div>
    </section>
  {/if}
{/snippet}

{#snippet settingsRecovery()}
  {#if view.settingsUnavailable && !reading}
    <p class="muted" role="status">Settings are unavailable.</p>
    <button
      type="button"
      class="secondary block"
      disabled={recovering}
      onclick={retry}>Try again</button
    >
  {/if}
{/snippet}

{#if view.settings && view.state && view.commands}
  <AppleSettings
    settings={view.settings}
    access={view.state.access}
    {platform}
    onGlobalChange={view.commands.global}
    onServiceChange={view.commands.service}
    onFeatureChange={view.commands.feature}
    {sync}
    {restore}
    onRestore={restoreBridge ? freeRestore.start : undefined}
    {setup}
    privacyActions={usageActions}
    {help}
  />
  {#if view.settingsUnavailable && !reading}
    <div class="still-ui app" data-host="apple">{@render settingsRecovery()}</div>
  {/if}
{:else}
  <!-- Held: no accepted committed choices yet. Never startup defaults or a saved Off. -->
  <div class="still-ui app" data-host="apple" data-settings-held="">
    {#if view.settingsUnavailable && !reading}
      {@render settingsRecovery()}
    {:else}
      <p class="muted" role="status">{STRINGS.sync.checking}</p>
    {/if}
    {@render usageActions()}
  </div>
{/if}

{#if c.signInOpen && (c.popupState === "signed-out" || c.popupState === "pro-no-account")}
  <SignInSheet controller={c} onDismiss={() => c.dismissSignIn()} />
{/if}
