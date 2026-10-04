<script lang="ts">
  import { FEATURE_REGISTRY } from "@still/shared-types";
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
  import "./design/styles.css";
  let {
    settings,
    access,
    onGlobalChange,
    onServiceChange,
    onFeatureChange,
    sectionMemory,
    services,
    features,
    labels,
    sync,
    pro,
    restore,
    link,
    sharing,
    setup,
    help,
  }: ExtensionSettingsProps = $props();
  let deleteTarget = $state<{ address: string; handler: () => void } | null>(
    null,
  );
  let deleteTargetCurrent = $derived(
    deleteTarget !== null &&
      deleteTarget.address === sync.account?.address &&
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
    knownMissing &&
      pro.ownership === "none" &&
      !restoreHeld &&
      pro.channel === "ready" &&
      Boolean(pro.offer?.price.trim()) &&
      Boolean(sync.account?.confirmed ? pro.onBuy : pro.onSignIn) &&
      pro.state !== "pending" &&
      pro.state !== "failed" &&
      pro.state !== "success",
  );
  function requestPro() {
    if (!proActionReady) return;
    if (sync.account?.confirmed) pro.onBuy?.();
    else pro.onSignIn?.();
  }
  function confirmDelete() {
    const target = deleteTarget;
    deleteTarget = null;
    if (
      target &&
      target.address === sync.account?.address &&
      target.handler === sync.account?.onDeleteAccount
    )
      target.handler();
  }
  function openDelete() {
    const account = sync.account;
    if (account?.onDeleteAccount) {
      deleteTarget = {
        address: account.address,
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
      onChange={onGlobalChange}
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
    {sectionMemory}
    {services}
    {features}
    {labels}
    onProAction={proActionReady ? requestPro : undefined}
  />
  <SyncCard
    owned={pro.ownership === "owned"}
    onSignIn={sync.onSignIn}
    account={sync.account
      ? {
          ...sync.account,
          onDeleteAccount: sync.account.onDeleteAccount
            ? openDelete
            : undefined,
        }
      : undefined}
  />
  {#if pro.ownership !== "owned" && (pro.ownership !== "none" || knownMissing || accessHeld || (pro.state && pro.state !== "idle"))}
    <ProOfferCard
      {...pro}
      confirmedAccount={sync.account?.confirmed ?? false}
      {knownMissing}
      {accessHeld}
      {accessChecking}
      {accessVerify}
      {restoreHeld}
    />
  {/if}
  {#if restore}<RestoreStatusCard {...restore} />{/if}
  {#if link}<AccountLinkCard {...link} />{/if}
  <SharingCard {...sharing} />
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
    onConfirm={deleteTargetCurrent ? confirmDelete : undefined}
    onCancel={() => {
      deleteTarget = null;
    }}
  />
</div>
