<script lang="ts">
  import SiteAccessCard from "./SiteAccessCard.svelte";
  import { FEATURE_REGISTRY, PAID_TIER_ENABLED } from "@still/shared-types";
  import type { ExtensionSettingsProps } from "./extension-settings-presentation.js";
  import Toggle from "./Toggle.svelte";
  import Glyph from "./Glyph.svelte";
  import SettingsSiteList from "./SettingsSiteList.svelte";
  import {
    createProOfferLatch,
    proAccessChecking,
    proKnownMissing,
    stillProTag,
  } from "./presentation.js";
  import PopupProCard from "./PopupProCard.svelte";
  import SyncCard from "./SyncCard.svelte";
  import ProOfferCard from "./ProOfferCard.svelte";
  import RestoreStatusCard from "./RestoreStatusCard.svelte";
  import AccountLinkCard from "./AccountLinkCard.svelte";
  import SharingCard from "./SharingCard.svelte";
  import ConfirmationDialog from "./ConfirmationDialog.svelte";
  import { SHARED_DATA_COPY } from "./withdrawal-copy.js";
  import { SUPPORT_EMAIL } from "../config.js";
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
    phone = false,
    proReturnGuidance,
    platformKnown = true,
    sync,
    pro,
    proHandoff,
    restore,
    onRestore,
    link,
    sharing,
    privacyActions,
    setup,
    siteAccess,
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
  // Purchase entries read the real snapshot: nothing here asks for money while Still is unsure.
  let knownMissing = $derived(proKnownMissing(access));
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
  // The rows, and Safari's app hand-off (which takes no money here), draw from the latched access:
  // a sync or setting change re-confirms access and never takes the lock chips or the hand-off
  // card away (ISS-0032). The Still Pro card above keeps its own held "checking" state meanwhile.
  const offerAccess = createProOfferLatch();
  let shownAccess = $derived(offerAccess(access, sync.account?.identity ?? sync.account?.address ?? null));
  // Safari (no `pro` producer): the Still app owns Still Pro, so the settings page shows the same
  // compact card as the Safari popup, and it and the lock chips open the app (ISS-0032).
  let handoffReady = $derived(
    !pro && Boolean(proHandoff) && proKnownMissing(shownAccess),
  );
  let handoffChecking = $derived(
    !pro && Boolean(proHandoff) && proAccessChecking(shownAccess),
  );
  function openHandoff() {
    if (handoffReady) proHandoff?.();
  }
  let restoreHeld = $derived(
    restore?.state === "checking" ||
      restore?.state === "verify" ||
      restore?.state === "failed",
  );
  // The Still Pro card waits only while a Restore is checking or asks to verify. A failed Restore
  // changed nothing, so the card keeps what it showed, Get Still Pro included (ISS-0090).
  let proRestoreHeld = $derived(
    restore?.state === "checking" || restore?.state === "verify",
  );
  let proActionReady = $derived(
    pro !== undefined &&
      knownMissing &&
      pro.ownership === "none" &&
      !proRestoreHeld &&
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
    card.scrollIntoView?.({ block: "start" });
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
  {#if siteAccess}<SiteAccessCard {...siteAccess} />{/if}
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
    access={shownAccess}
    {onServiceChange}
    {onFeatureChange}
    {commandsDisabled}
    {sectionMemory}
    {services}
    {features}
    {labels}
    onProAction={proActionReady
      ? revealPro
      : handoffReady
        ? openHandoff
        : undefined}
    host={proHandoff && !pro ? "safari" : "browser"}
  />
  <!-- Purchased (ISS-0032): the sync card keeps its own heading and the account's sync status,
    beside the Still Pro card's "Purchased" (no merged "Still Pro and sync" card). -->
  <SyncCard
    stillPro={stillProTag(access, sync.account)}
    onSignIn={sync.onSignIn}
    accountActions={sync.accountActions}
    account={sync.account
      ? {
          ...sync.account,
          // Delete account moved to the Help card (owner, 19 Oct); the card never shows it.
          onDeleteAccount: undefined,
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
  <!-- Owned: no card (owner, 19 Oct); the sync card's Still Pro tag is the signal. -->
  {#if pro && pro.ownership !== "owned" && (pro.ownership !== "none" || knownMissing || accessHeld || (pro.state && pro.state !== "idle"))}
    <div bind:this={proSection} style="display:contents;">
      <ProOfferCard
        {...pro}
        {phone}
        {features}
        {platformKnown}
        confirmedAccount={sync.account?.confirmed ?? false}
        {knownMissing}
        {accessHeld}
        {accessChecking}
        {accessVerify}
        restoreHeld={proRestoreHeld}
      />
      {#if proReturnGuidance}
        <p class="caption muted">{proReturnGuidance}</p>
      {/if}
    </div>
  {/if}
  {#if handoffReady}
    <PopupProCard onOpen={openHandoff} appHandoff />
  {:else if handoffChecking}
    <PopupProCard checking />
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
  <!-- Help (owner, 12 Oct): the three links only, no heading, divider or note. Delete account
    lives here as a plain link since 19 Oct (owner: no need to highlight it), not in the sync card. -->
  <section class="card card-stack help" aria-label="Help">
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
    <p class="muted sync-row-sub support-address">{SUPPORT_EMAIL}</p>
    <button
      type="button"
      class="link"
      disabled={!help.onPrivacy}
      onclick={help.onPrivacy}>Privacy policy</button
    >
    {#if sync.account?.onDeleteAccount}<button
        type="button"
        class="link"
        onclick={openDelete}>Delete account</button
      >{/if}
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
