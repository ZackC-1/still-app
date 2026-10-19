<script lang="ts">
  import { FEATURE_REGISTRY, PAID_TIER_ENABLED } from "@still/shared-types";
  import { DESKTOP_LAYOUT_ONLY_PRO } from "../../entitlement/access-policy.js";
  import { onDestroy } from "svelte";
  import type { AppleSettingsProps } from "./apple-settings-presentation.js";
  import Toggle from "./Toggle.svelte";
  import SettingsSiteList from "./SettingsSiteList.svelte";
  import SyncCard from "./SyncCard.svelte";
  import { proPurchased } from "./presentation.js";
  import NativeProOfferCard from "./NativeProOfferCard.svelte";
  import RestoreStatusCard from "./RestoreStatusCard.svelte";
  import AccountLinkCard from "./AccountLinkCard.svelte";
  import SharingCard from "./SharingCard.svelte";
  import ConfirmationDialog from "./ConfirmationDialog.svelte";
  import "./design/styles.css";
  let {
    settings,
    commandsDisabled = false,
    access,
    platform,
    phone = false,
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
    onRestore,
    link,
    linkInvitation,
    sharing,
    privacyActions,
    setup,
    help,
  }: AppleSettingsProps = $props();
  // Owner decision 26: the App Store check is against the person's Apple Account.
  const appleNothingCopy = {
    text: "No Still Pro purchase was found for this Apple Account.",
    detail:
      "Bought it with another Apple Account? Sign in with that one and try again.",
  };
  let confirming = $state(false);
  type DeleteTarget = Pick<
    NonNullable<AppleSettingsProps["sync"]["account"]>,
    "address" | "identity" | "revision" | "onDeleteAccount"
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
        // iPhone/iPad never show a Still Pro switch that cannot act in a phone layout (owner
        // decision); the saved choice is kept. Free rows are never in this list.
        (platform === "mac" || !(DESKTOP_LAYOUT_ONLY_PRO as readonly string[]).includes(row.id)) &&
        (!features || features.includes(row.id)),
    ).map((row) => row.id),
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
  let accessHeld = $derived(accessChecking || accessVerify);
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
      !pro.verificationRequired &&
      knownMissing &&
      pro.ownership === "none" &&
      !restoreHeld &&
      pro.channel === "ready" &&
      // Same trimmed-price rule as the native card: a blank price is no offer.
      Boolean(pro.offer?.price.trim()) &&
      Boolean(pro.onBuy) &&
      (!pro.state || pro.state === "idle"),
  );
  let showInvitation = $derived(
    Boolean(linkInvitation?.eligibleLaterVisit) &&
      pro?.ownership === "owned" &&
      !accessHeld &&
      !setup &&
      !link &&
      // A concluded Restore may sit beside it (ISS-0071: restored holders are invited to sign in).
      (!restore || restore.state === "restored") &&
      !confirming &&
      // Also right after a completed purchase (ISS-0071: one bought without an account).
      (!pro?.state || pro.state === "idle" || pro.state === "success") &&
      sharing?.state !== "unasked" &&
      (!sharing?.withdrawal || sharing.withdrawal === "none") &&
      sync.account?.status?.tone !== "failed",
  );
  let proSection: HTMLDivElement | undefined = $state();
  function revealPro() {
    if (!proActionReady) return;
    if (platform === "mac") {
      pro?.onBuy?.();
      return;
    }
    const card = proSection?.querySelector<HTMLElement>(
      '[aria-label="Still Pro"]',
    );
    if (!card) return;
    card.setAttribute("tabindex", "-1");
    card.scrollIntoView?.({ block: "center" });
    card.focus({ preventScroll: true });
  }
  // Free period only: the compiled paid flag is off and no paid producer is supplied. With paid on
  // and no producer there is nothing to show, never this link. Inert while a Restore is held, as
  // the native card's Restore link is.
  let freeRestoreShown = $derived(
    !PAID_TIER_ENABLED && !pro && Boolean(onRestore),
  );
  let freeRestoreReady = $derived(freeRestoreShown && !restoreHeld);
  function requestFreeRestore() {
    if (mounted && freeRestoreReady) onRestore?.();
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

{#snippet proCard()}
  {#if pro && (pro.ownership !== "verify" || (!restore && pro.onRestore))}
    <!-- Checking and verify stay separate so the card shows the matching presentation;
      accessHeld covers only rights not known missing for any other reason. -->
    <div bind:this={proSection} style="display:contents;">
      <NativeProOfferCard
        {...pro}
        {phone}
        {accessChecking}
        {accessVerify}
        accessHeld={pro.ownership === "none" && !knownMissing && !accessHeld}
        {restoreHeld}
      />
    </div>
  {/if}
{/snippet}

<div class="still-ui app" class:mac-settings={platform === "mac"} data-host="apple">
  <section class="hero compact" class:off={!settings.globalOn}>
    <div class="hero-text">
      <h1>{settings.globalOn ? "Still is active" : "Still is off"}</h1>
    </div>
    <Toggle
      disabled={commandsDisabled}
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
    {commandsDisabled}
    {settings}
    {access}
    {onServiceChange}
    {onFeatureChange}
    {sectionMemory}
    {services}
    {labels}
    features={supportedRows}
    onProAction={proActionReady ? revealPro : undefined}
  />
  {#if platform === "mac"}{@render proCard()}{/if}
  <!-- Purchased (ISS-0032): the sync card keeps its own heading and sync status, beside the
    Still Pro card's "Purchased" (no merged "Still Pro and sync" card). -->
  <SyncCard
    stillPro={proPurchased(access)}
    onSignIn={sync.onSignIn}
    account={sync.account
      ? {
          // The shared card renders these only; the native epoch stays in this fence.
          address: sync.account.address,
          confirmed: sync.account.confirmed,
          status: sync.account.status,
          lastSyncedAt: sync.account.lastSyncedAt,
          onSignOut: sync.account.onSignOut,
        }
      : undefined}
  />
  {#if showInvitation}
    <!-- ISS-0071: one line for accountless holders; Sign in runs the existing explicit link.
         ISS-0076: signed in, the same line offers the link itself (Link runs that explicit link). -->
    {@const invitation = linkInvitation?.signedIn
      ? { title: "Link Still Pro to your account.", action: "Link" }
      : { title: "Sign in to keep Still Pro with your account.", action: "Sign in" }}
    <section class="card card-stack" aria-label={invitation.title}>
      <div class="sync-row-text">
        <h2 class="sync-row-title">{invitation.title}</h2>
      </div>
      <div class="inline-actions">
        <button
          type="button"
          class="primary inline"
          disabled={!linkInvitation?.onLink}
          onclick={linkInvitation?.onLink}>{invitation.action}</button
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
  {#if platform !== "mac"}{@render proCard()}{/if}
  {#if freeRestoreShown}
    <!-- Free period (owner decision 17): the Still Pro card's slot holds only its plain Restore
      link, so past purchasers can restore; no offer, Buy or price. -->
    <section class="card card-stack">
      <button
        type="button"
        class="link"
        disabled={!freeRestoreReady}
        onclick={requestFreeRestore}>Restore purchase</button
      >
    </section>
  {/if}
  {#if restore}<RestoreStatusCard
      {...restore}
      nothingCopy={appleNothingCopy}
      onAction={pro?.state !== "pending" && restore?.onAction
        ? requestRestoreAction
        : undefined}
    />{/if}
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
    <button
      type="button"
      class="link"
      disabled={!help.onPrivacy}
      onclick={help.onPrivacy}>Privacy policy</button
    >
    {#if validDeleteAccount(sync.account)}<button
        type="button"
        class="link"
        onclick={openDelete}>Delete account</button
      >{/if}
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

<style>
  /* Mac app only: reduce vertical whitespace by 12.5%; keep text and targets their full size. */
  .mac-settings {
    --app-gap: calc(var(--space-3) * 0.875);
    --services-gap: calc(var(--space-2) * 0.875);
    --service-card-padding-block: calc(var(--space-3) * 0.875);
    --sync-gap: calc(var(--space-3) * 0.875);
    --sync-padding: calc(var(--space-4) * 0.875) var(--space-4);
    padding-block: max(calc(var(--space-4) * 0.875), env(safe-area-inset-top)) max(calc(var(--space-4) * 0.875), env(safe-area-inset-bottom));
  }
  .mac-settings :global(.hero.compact) {
    --hero-padding: calc(var(--space-3) * 0.875) var(--space-3);
  }
</style>
