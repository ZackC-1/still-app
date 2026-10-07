<script lang="ts">
  import { FEATURE_REGISTRY, PAID_TIER_ENABLED } from "@still/shared-types";
  import type { ExtensionSettingsProps } from "./extension-settings-presentation.js";
  import Toggle from "./Toggle.svelte";
  import Glyph from "./Glyph.svelte";
  import SettingsSiteList from "./SettingsSiteList.svelte";
  import SyncCard from "./SyncCard.svelte";
  import ProOfferCard from "./ProOfferCard.svelte";
  import RestoreStatusCard from "./RestoreStatusCard.svelte";
  import AccountLinkCard from "./AccountLinkCard.svelte";
  import SharingCard from "./SharingCard.svelte";
  import ConfirmationDialog from "./ConfirmationDialog.svelte";
  import { SHARED_DATA_COPY } from "./withdrawal-copy.js";
  import "./design/styles.css";
  let {
    settings,
    access,
    onGlobalChange,
    onServiceChange,
    onFeatureChange,
    commandsDisabled = false,
    sectionMemory,
    services,
    features,
    labels,
    sync,
    pro,
    restore,
    onRestore,
    link,
    sharing,
    privacyActions,
    setup,
    help,
  }: ExtensionSettingsProps = $props();
  let deleteTarget = $state<{
    address?: string;
    identity?: string;
    revision?: number;
    handler: () => void;
  } | null>(null);
  let deleteTargetCurrent = $derived(
    deleteTarget !== null &&
      deleteTarget.address === sync.account?.address &&
      deleteTarget.identity === sync.account?.identity &&
      deleteTarget.revision === sync.account?.revision &&
      deleteTarget.handler === sync.account?.onDeleteAccount,
  );
  $effect(() => {
    if (deleteTarget && !deleteTargetCurrent) deleteTarget = null;
  });
  let knownMissing = $derived(
    FEATURE_REGISTRY.some(
      (row) => row.tier === "pro" && access.states[row.id] === "locked",
    ) &&
      !FEATURE_REGISTRY.some(
        (row) =>
          row.tier === "pro" &&
          [
            "checking",
            "verification_required",
            "purchased",
            "protected",
          ].includes(access.states[row.id]),
      ),
  );
  let accessHeld = $derived(
    FEATURE_REGISTRY.some(
      (row) =>
        row.tier === "pro" &&
        ["checking", "verification_required"].includes(access.states[row.id]),
    ),
  );
  let accessChecking = $derived(
    FEATURE_REGISTRY.some(
      (row) => row.tier === "pro" && access.states[row.id] === "checking",
    ),
  );
  let accessVerify = $derived(
    FEATURE_REGISTRY.some(
      (row) =>
        row.tier === "pro" && access.states[row.id] === "verification_required",
    ),
  );
  let restoreHeld = $derived(
    restore?.state === "checking" ||
      restore?.state === "verify" ||
      restore?.state === "failed",
  );
  let proActionReady = $derived(
    pro !== undefined &&
      knownMissing &&
      pro.ownership === "none" &&
      !restoreHeld &&
      pro.state !== "pending" &&
      pro.state !== "failed" &&
      pro.state !== "success",
  );
  // Free period only (owner decisions 62 and 73): the compiled paid flag is off and no paid
  // producer is supplied. Inert while a Restore is held, as the Apple app's link is.
  let freeRestoreShown = $derived(
    !PAID_TIER_ENABLED && !pro && Boolean(onRestore),
  );
  let freeRestoreReady = $derived(freeRestoreShown && !restoreHeld);
  function requestFreeRestore() {
    if (freeRestoreReady) onRestore?.();
  }
  let proSection: HTMLDivElement | undefined = $state();
  function revealPro() {
    if (!proActionReady) return;
    const card = proSection?.querySelector<HTMLElement>(
      '[aria-label="Still Pro"]',
    );
    if (!card) return;
    card.setAttribute("tabindex", "-1");
    card.scrollIntoView?.({ block: "center" });
    card.focus({ preventScroll: true });
  }
  $effect(() => () => {
    deleteTarget = null;
  });
  let deleteConfirmation = $derived.by(() => {
    const target = deleteTarget;
    return target && deleteTargetCurrent
      ? () => confirmDelete(target)
      : undefined;
  });
  function confirmDelete(target: NonNullable<typeof deleteTarget>) {
    if (target !== deleteTarget) return;
    deleteTarget = null;
    if (
      target &&
      target.address === sync.account?.address &&
      target.identity === sync.account?.identity &&
      target.revision === sync.account?.revision &&
      target.handler === sync.account?.onDeleteAccount
    )
      target.handler();
  }
  // "Delete shared data on all devices": confirmed first, and only for the account it was asked for
  // (the same guard as Delete account: a sign-out or another account closes the confirmation).
  let sharedTarget = $state<{
    identity?: string;
    revision?: number;
    handler: () => void;
  } | null>(null);
  let sharedTargetCurrent = $derived(
    sharedTarget !== null &&
      sharedTarget.identity === sync.account?.identity &&
      sharedTarget.revision === sync.account?.revision &&
      sharedTarget.handler === sync.account?.sharedData?.onDelete,
  );
  $effect(() => {
    if (sharedTarget && !sharedTargetCurrent) sharedTarget = null;
  });
  $effect(() => () => {
    sharedTarget = null;
  });
  function openSharedDelete() {
    const account = sync.account;
    if (account?.sharedData?.onDelete) {
      deleteTarget = null;
      sharedTarget = {
        identity: account.identity,
        revision: account.revision,
        handler: account.sharedData.onDelete,
      };
    }
  }
  function confirmSharedDelete() {
    const target = sharedTarget;
    sharedTarget = null;
    if (
      target &&
      target.identity === sync.account?.identity &&
      target.revision === sync.account?.revision &&
      target.handler === sync.account?.sharedData?.onDelete
    )
      target.handler();
  }
  function openDelete() {
    const account = sync.account;
    if (account?.onDeleteAccount) {
      sharedTarget = null;
      deleteTarget = {
        address: account.address,
        identity: account.identity,
        revision: account.revision,
        handler: account.onDeleteAccount,
      };
    }
  }
</script>

<div class="still-ui app">
  <section class="hero compact" class:off={!settings.globalOn}>
    <div class="hero-text">
      <h1>{settings.globalOn ? "Still is active" : "Still is off"}</h1>
    </div>
    <Toggle
      checked={settings.globalOn}
      onChange={(next) => {
        if (!commandsDisabled) onGlobalChange(next);
      }}
      disabled={commandsDisabled}
      label="Still"
      onBlue={settings.globalOn}
    />
  </section>
  {#if setup}
    <section class="card card-stack">
      <h2 class="section-label">Setup</h2>
      <div class="status-line" data-tone="caution" role="status">
        <span class="glyph"><Glyph name="clock" size={16} /></span>
        <div class="status-body">
          <span>Still can't block on these websites yet.</span><span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >{setup.detail}</span
          >
        </div>
      </div>
      <button
        type="button"
        class="secondary block"
        disabled={!setup.onAction}
        onclick={setup.onAction}>Review permissions</button
      >
    </section>
  {/if}
  <SettingsSiteList
    {settings}
    {access}
    {onServiceChange}
    {onFeatureChange}
    {commandsDisabled}
    {sectionMemory}
    {services}
    {features}
    {labels}
    onProAction={proActionReady ? revealPro : undefined}
  />
  <SyncCard
    owned={pro?.ownership === "owned"}
    onSignIn={sync.onSignIn}
    accountActions={sync.accountActions}
    account={sync.account
      ? {
          ...sync.account,
          onDeleteAccount: sync.account.onDeleteAccount
            ? openDelete
            : undefined,
          sharedData: sync.account.sharedData
            ? {
                ...sync.account.sharedData,
                onDelete: sync.account.sharedData.onDelete
                  ? openSharedDelete
                  : undefined,
              }
            : undefined,
        }
      : undefined}
  />
  {#if pro && pro.ownership !== "owned" && (pro.ownership !== "none" || knownMissing || accessHeld || (pro.state && pro.state !== "idle"))}
    <div bind:this={proSection} style="display:contents;">
      <ProOfferCard
        {...pro}
        confirmedAccount={sync.account?.confirmed ?? false}
        {knownMissing}
        {accessHeld}
        {accessChecking}
        {accessVerify}
        {restoreHeld}
      />
    </div>
  {/if}
  {#if freeRestoreShown}
    <!-- Free period: the Still Pro card's slot holds only its plain Restore link, so past
      purchasers can check their account; no offer, Buy or price. -->
    <section class="card card-stack">
      <button
        type="button"
        class="link"
        disabled={!freeRestoreReady}
        onclick={requestFreeRestore}>Restore purchase</button
      >
    </section>
  {/if}
  {#if restore}<RestoreStatusCard {...restore} />{/if}
  {#if link}<AccountLinkCard {...link} />{/if}
  {#if sharing}<SharingCard
      {...sharing}
    />{:else if privacyActions}{@render privacyActions()}{/if}
  <section class="card card-stack">
    <h2 class="section-label">Help</h2>
    <div class="account">
      <button
        type="button"
        class="link"
        disabled={!help.onGuide}
        onclick={help.onGuide}>Setup guide</button
      >
      <button
        type="button"
        class="link"
        disabled={!help.onSupport}
        onclick={help.onSupport}>Contact support</button
      >
      <button
        type="button"
        class="link"
        disabled={!help.onPrivacy}
        onclick={help.onPrivacy}>Privacy policy</button
      >
    </div>
    <p class="caption">
      Contact support opens your email app. Nothing about your browsing or
      account is attached.
    </p>
  </section>
  <ConfirmationDialog
    open={deleteTargetCurrent}
    title="Delete your account?"
    body="This deletes your account and the settings synced to it. Settings on this device stay. A Still Pro purchase made in the Still app keeps working on that device."
    confirmLabel="Delete account"
    onConfirm={deleteConfirmation}
    onCancel={() => {
      deleteTarget = null;
    }}
  />
  <ConfirmationDialog
    open={sharedTargetCurrent}
    title={SHARED_DATA_COPY.confirmTitle}
    body={SHARED_DATA_COPY.confirmBody}
    confirmLabel={SHARED_DATA_COPY.confirm}
    cancelLabel={SHARED_DATA_COPY.cancel}
    onConfirm={sharedTargetCurrent ? confirmSharedDelete : undefined}
    onCancel={() => {
      sharedTarget = null;
    }}
  />
</div>
