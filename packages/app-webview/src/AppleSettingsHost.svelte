<script lang="ts">
  // D04 Apple settings host: prop plumbing only. Every rule lives in @still/core's tested
  // apple-settings-host module and the existing committed popup view binding. The entry reaches
  // this file only through a dynamic import that configured builds fold away, so AppleSettings and
  // its global stylesheet exist only in bundles that can select this screen. The leaf is imported
  // by file path (as the Chromium popup imports DesktopPopup), through this package's dependency
  // link so the app-webview `rootDir` check treats core as a dependency, not as local source.
  import AppleSettings from "../node_modules/@still/core/src/ui/v3/AppleSettings.svelte";
  import SettingsSwitch from "../node_modules/@still/core/src/ui/v3/Toggle.svelte";
  import {
    STRINGS,
    SignInSheet,
    createPopupViewBinding,
    appleSettingsSync,
    appleSettingsRestore,
    watchAppleSetup,
    type AppleSettingsProps,
    type CommittedPopupBinding,
    type CommittedPopupToggle,
    type UiController,
  } from "@still/core/ui";
  import type { NativeBridge } from "@still/core/native";

  interface Props {
    controller: UiController;
    binding: CommittedPopupBinding;
    platform: AppleSettingsProps["platform"];
    /** Setup card from the composition-time native observation (macOS "disabled" only). */
    initialSetup: AppleSettingsProps["setup"];
    /** Re-read on return to the foreground (NativeBridge.observeSafariSetup). */
    observeSetup: NativeBridge["observeSafariSetup"];
    help: AppleSettingsProps["help"];
    /** The shared cache's first native read (SettingsCache.whenHydrated). */
    settingsRead: Promise<unknown>;
    onCommittedToggle?: (toggle: CommittedPopupToggle) => void;
  }
  let {
    controller: c,
    binding,
    platform,
    initialSetup,
    observeSetup,
    help,
    settingsRead,
    onCommittedToggle,
  }: Props = $props();

  const view = createPopupViewBinding(
    () => binding,
    (toggle) => onCommittedToggle?.(toggle),
  );
  let sync = $derived(appleSettingsSync(c));
  let restore = $derived(appleSettingsRestore(c));
  let setup = $state.raw<AppleSettingsProps["setup"]>(undefined);
  $effect.pre(() => {
    setup = initialSetup;
  });
  $effect(() =>
    watchAppleSetup(observeSetup, (next) => {
      setup = next;
    }),
  );
  // Until the first native read settles, a hold is "checking", not "unavailable".
  let reading = $state(true);
  $effect(() => {
    let live = true;
    const settled = () => {
      if (live) reading = false;
    };
    settingsRead.then(settled, settled);
    return () => {
      live = false;
    };
  });
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
          <span class="row-title" id="usage-sharing-title"
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
      disabled={view.recovering}
      onclick={view.recoverSettings}>Try again</button
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
