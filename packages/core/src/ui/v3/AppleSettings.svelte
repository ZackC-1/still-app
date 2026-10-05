<script lang="ts">
  import { FEATURE_REGISTRY } from "@still/shared-types";
  import { onDestroy } from "svelte";
  import type { AppleSettingsProps } from "./apple-settings-presentation.js";
  import Toggle from "./Toggle.svelte";
  import SettingsSiteList from "./SettingsSiteList.svelte";
  import SyncCard from "./SyncCard.svelte";
  import NativeProOfferCard from "./NativeProOfferCard.svelte";
  import RestoreStatusCard from "./RestoreStatusCard.svelte";
  import AccountLinkCard from "./AccountLinkCard.svelte";
  import SharingCard from "./SharingCard.svelte";
  import ConfirmationDialog from "./ConfirmationDialog.svelte";
  import "./design/styles.css";
  let {
    settings,
    access,
    platform,
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
    linkInvitation,
    sharing,
    privacyActions,
    setup,
    help,
  }: AppleSettingsProps = $props();
  let confirming = $state(false);
  type DeleteTarget = Pick<
    NonNullable<AppleSettingsProps["sync"]["account"]>,
    "address" | "confirmed" | "identity" | "revision" | "onDeleteAccount"
  >;
  let deleteTarget = $state.raw<DeleteTarget>();
  let deleteConfirmation = $state.raw<(() => void) | undefined>();
  let deleteOpening: object | undefined;
  let mounted = true;

  function validDeleteAccount(account: AppleSettingsProps["sync"]["account"]) {
    return Boolean(
      account &&
      typeof account.onDeleteAccount === "function" &&
      typeof account.identity === "string" &&
      account.identity.trim() &&
      ((typeof account.revision === "string" && account.revision.trim()) ||
        (typeof account.revision === "number" &&
          Number.isSafeInteger(account.revision) &&
          account.revision >= 0)),
    );
  }

  function currentDeleteTarget(target: DeleteTarget) {
    const account = sync.account;
    return Boolean(
      mounted &&
      validDeleteAccount(account) &&
      account &&
      account.address === target.address &&
      account.confirmed === target.confirmed &&
      account.identity === target.identity &&
      account.revision === target.revision &&
      account.onDeleteAccount === target.onDeleteAccount,
    );
  }
  function invalidateDeleteConsent() {
    deleteOpening = undefined;
    deleteTarget = undefined;
    deleteConfirmation = undefined;
  }
  function cancelDelete() {
    invalidateDeleteConsent();
    confirming = false;
  }
  function openDelete() {
    const account = sync.account;
    if (!mounted || !account || !validDeleteAccount(account)) return;
    const opening = {};
    deleteOpening = opening;
    deleteTarget = {
      address: account.address,
      confirmed: account.confirmed,
      identity: account.identity,
      revision: account.revision,
      onDeleteAccount: account.onDeleteAccount,
    };
    // Capture only the opening, never a handler that could survive invalidation.
    deleteConfirmation = () => {
      if (deleteOpening !== opening || !deleteTarget) return;
      if (!currentDeleteTarget(deleteTarget)) {
        invalidateDeleteConsent();
        return;
      }
      const remove = sync.account?.onDeleteAccount;
      cancelDelete();
      remove?.();
    };
    confirming = true;
  }
  $effect(() => {
    if (deleteTarget && !currentDeleteTarget(deleteTarget))
      invalidateDeleteConsent();
  });
  onDestroy(() => {
    mounted = false;
    cancelDelete();
  });
  let supportedRows = $derived(
    FEATURE_REGISTRY.filter(
      (row) =>
        (platform === "mac" || row.id !== "facebook.sponsored") &&
        (!features || features.includes(row.id)),
    ).map((row) => row.id),
  );
  let accessHeld = $derived(
    FEATURE_REGISTRY.some(
      (row) =>
        row.tier === "pro" &&
        ["checking", "verification_required"].includes(access.states[row.id]),
    ),
  );
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
      pro.channel === "ready" &&
      Boolean(pro.offer?.price) &&
      Boolean(pro.onBuy) &&
      (!pro.state || pro.state === "idle"),
  );
  let showInvitation = $derived(
    Boolean(linkInvitation?.eligibleLaterVisit) &&
      pro?.ownership === "owned" &&
      !accessHeld &&
      !setup &&
      !link &&
      !restore &&
      !confirming &&
      (!pro?.state || pro.state === "idle") &&
      sharing?.state !== "unasked" &&
      (!sharing?.withdrawal || sharing.withdrawal === "none") &&
      sync.account?.status?.tone !== "failed",
  );
  function requestPro() {
    if (proActionReady) pro?.onBuy?.();
  }
  function requestRestoreAction() {
    if (
      mounted &&
      pro?.state !== "pending" &&
      (restore?.state === "failed" || restore?.state === "verify")
    )
      restore.onAction?.();
  }
</script>

{#snippet syncCaption()}
  {#if !sync.account}<p class="caption">
      Optional. Blocking and Still Pro work without an account.
    </p>{/if}
{/snippet}

<div class="still-ui app" data-host="apple">
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
      <h2 class="section-label">{setup.title}</h2>
      <p class="muted" style="font-size:calc(14px * var(--text-scale, 1));">
        {setup.detail}
      </p>
      <ol
        style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:calc(14px * var(--text-scale, 1));line-height:1.4;color:var(--ink);"
      >
        {#each setup.steps as step, index (index)}<li>{step}</li>{/each}
      </ol>
      <button
        type="button"
        class="primary block"
        disabled={!setup.onAction}
        onclick={setup.onAction}>{setup.actionLabel}</button
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
    {labels}
    features={supportedRows}
    onProAction={proActionReady ? requestPro : undefined}
  />
  <SyncCard
    owned={pro?.ownership === "owned"}
    onSignIn={sync.onSignIn}
    accountActions={syncCaption}
    account={sync.account
      ? {
          // The shared card renders these only; the native epoch stays in this fence.
          address: sync.account.address,
          confirmed: sync.account.confirmed,
          status: sync.account.status,
          onSignOut: sync.account.onSignOut,
          onDeleteAccount: validDeleteAccount(sync.account)
            ? openDelete
            : undefined,
        }
      : undefined}
  />
  {#if showInvitation}
    <section class="card card-stack" aria-label="Link Still Pro to an account">
      <div class="sync-row-text">
        <h2 class="sync-row-title">Link Still Pro to an account</h2>
        <p class="muted sync-row-sub">
          So you can restore it in other browsers. Optional.
        </p>
      </div>
      <div class="inline-actions">
        <button
          type="button"
          class="primary inline"
          disabled={!linkInvitation?.onLink}
          onclick={linkInvitation?.onLink}>Link</button
        >
        <button
          type="button"
          class="link"
          disabled={!linkInvitation?.onDismiss}
          onclick={linkInvitation?.onDismiss}>Not now</button
        >
      </div>
    </section>
  {/if}
  {#if link}<AccountLinkCard {...link} />{/if}
  {#if pro && pro.ownership !== "owned" && (pro.ownership !== "verify" || (!restore && pro.onRestore))}
    <NativeProOfferCard
      {...pro}
      accessHeld={accessHeld || (pro.ownership === "none" && !knownMissing)}
      {restoreHeld}
    />
  {/if}
  {#if proActionReady}<p
      class="caption"
      style="margin-block-start:-4px;padding-inline:4px;"
    >
      No account needed. Payment is handled by Apple.
    </p>{/if}
  {#if restore}<RestoreStatusCard
      {...restore}
      onAction={pro?.state !== "pending" && restore?.onAction
        ? requestRestoreAction
        : undefined}
    />{/if}
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
  </section>
  <ConfirmationDialog
    open={confirming}
    title="Delete your account?"
    body="This deletes your account and the settings synced to it. Settings on this device stay. A Still Pro purchase made in the Still app keeps working on that device."
    confirmLabel="Delete account"
    onConfirm={deleteConfirmation}
    onCancel={cancelDelete}
  />
</div>
