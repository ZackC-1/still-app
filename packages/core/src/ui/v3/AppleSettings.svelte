<script lang="ts">
  import { FEATURE_REGISTRY, PAID_TIER_ENABLED } from "@still/shared-types";
  import { DESKTOP_LAYOUT_ONLY_PRO } from "../../entitlement/access-policy.js";
  import { onDestroy } from "svelte";
  import type { AppleSettingsProps } from "./apple-settings-presentation.js";
  import Toggle from "./Toggle.svelte";
  import SettingsSiteList from "./SettingsSiteList.svelte";
  import SyncCard from "./SyncCard.svelte";
  import { stillProTag } from "./presentation.js";
  import { SUPPORT_EMAIL } from "../config.js";
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
  <!-- Owned: no card (owner, 19 Oct); the sync card's Still Pro tag is the signal. -->
  {#if pro && pro.ownership !== "owned" && (pro.ownership !== "verify" || (!restore && pro.onRestore))}
    <!-- Checking and verify stay separate so the card shows the matching presentation;
      accessHeld covers only rights not known missing for any other reason. -->
    <div class="pro-slot" bind:this={proSection} style="display:contents;">
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
  <!-- The setup card leads the screen when the extension is off (owner, 19 Oct). -->
  {#if setup}
    <section class="card card-stack">
      <!-- The same heading as the sync and Still Pro cards (owner, 21 Oct). -->
      <h2 class="card-title">{setup.title}</h2>
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
  <!-- Purchased (ISS-0032): the sync card keeps its own heading and sync status, beside the
    Still Pro card's "Purchased" (no merged "Still Pro and sync" card). -->
  <SyncCard
    stillPro={stillProTag(access, sync.account)}
    onSignIn={sync.onSignIn}
    invitation={showInvitation && !linkInvitation?.signedIn
      ? { onAccept: linkInvitation?.onLink, onDismiss: linkInvitation?.onDismiss }
      : undefined}
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
  {#if showInvitation && linkInvitation?.signedIn}
    <!-- ISS-0076: signed in, one line offers the link itself (Link runs that explicit link).
         ISS-0071's signed-out line lives inside the sync card above (owner, 19 Oct). -->
    {@const invitation = { title: "Link Still Pro to your account.", action: "Link" }}
    <section class="card card-stack" aria-label={invitation.title}>
      <div class="sync-row-text">
        <h2 class="sync-row-title">{invitation.title}</h2>
      </div>
      <div class="inline-actions link-invite-actions">
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
  <!-- The same order on the Mac as on the iPhone (owner, 19 Oct): sync first, then Still Pro. -->
  {@render proCard()}
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
  <!-- Help (owner, 12 Oct): the links only, no heading, divider or note. Delete account lives
    here as a plain link since 19 Oct (owner: no need to highlight it), not in the sync card.
    "Safari setup" (ISS-0075, owner 19 Oct) opens the app's own "Turn on Still in Safari" sheet.
    Two columns since 21 Oct (owner): Setup guide, Safari setup and Delete account on the left;
    Privacy policy, then Contact support with its address, on the right. Delete account comes last
    in the markup so it stays last in Tab order; the data attributes place each cell. -->
  <section class="card card-stack help" aria-label="Help">
    <button
      type="button"
      class="link"
      data-help-column="left"
      data-help-row="1"
      disabled={!help.onGuide}
      onclick={help.onGuide}>Setup guide</button
    >
    <button
      type="button"
      class="link"
      data-help-column="left"
      data-help-row="2"
      disabled={!help.onSafariSetup}
      onclick={help.onSafariSetup}>Safari setup</button
    >
    <button
      type="button"
      class="link"
      data-help-column="right"
      data-help-row="1"
      disabled={!help.onPrivacy}
      onclick={help.onPrivacy}>Privacy policy</button
    >
    <div class="help-contact" data-help-column="right" data-help-row="2">
      <button
        type="button"
        class="link"
        disabled={!help.onSupport}
        onclick={help.onSupport}>Contact support</button
      >
      <p class="muted sync-row-sub support-address">{SUPPORT_EMAIL}</p>
    </div>
    {#if validDeleteAccount(sync.account)}<button
        type="button"
        class="link"
        data-help-column="left"
        data-help-row="3"
        onclick={openDelete}>Delete account</button
      >{/if}
  </section>
  <!-- Share usage data sits below Help (owner, 21 Oct), the same order as Chrome and Firefox. -->
  {#if sharing}<SharingCard
      {...sharing}
    />{:else if privacyActions}{@render privacyActions()}{/if}
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
    --service-card-padding-block: calc(var(--space-3) * 0.875);
    --sync-gap: calc(var(--space-3) * 0.875);
    --sync-padding: calc(var(--space-4) * 0.875) var(--space-4);
    padding-block: max(calc(var(--space-4) * 0.875), env(safe-area-inset-top)) max(calc(var(--space-4) * 0.875), env(safe-area-inset-bottom));
  }
  .mac-settings :global(.hero.compact) {
    --hero-padding: calc(var(--space-3) * 0.875) var(--space-3);
  }
  /* Owner canvas (P-AppSync, 22 Oct): Sign in and Not now share one row at the app's 54px button
     height, and Not now's outline is the strong border. Its 1px border comes out of its padding so
     it adds no height. */
  .app :global(.split-actions > .secondary.block) {
    border-color: var(--border-strong);
    padding-block: calc(var(--space-4) - 1px);
  }
  /* Owner canvas (P-Invite, 22 Oct): the signed-in link offer's Link is a 44px, 15px button with
     16px before Not now. */
  .link-invite-actions {
    gap: var(--space-2) var(--space-4);
  }
  .link-invite-actions > .primary.inline {
    min-block-size: var(--tap-target);
    padding: 10px 20px;
    font-size: calc(15px * var(--text-scale, 1));
  }
  /* Owner canvas (P-AppPro, P-Restore, 22 Oct): the Still Pro and restore cards' status lines are
     body-sized (14px), with the glyph centred on the first line; detail lines stay 12.5px. */
  .pro-slot :global(.status-line),
  .app :global(.restore-card .status-line) {
    font-size: calc(14px * var(--text-scale, 1));
  }
  .pro-slot :global(.status-line .glyph),
  .app :global(.restore-card .status-line .glyph) {
    margin-block-start: 2px;
  }
</style>
