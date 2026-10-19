<script lang="ts">
  import SiteAccessCard from "./SiteAccessCard.svelte";
  import { untrack } from "svelte";
  import type { ServiceId } from "@still/shared-types";
  import {
    createProOfferLatch,
    proAccessChecking,
    proKnownMissing,
    proPurchased,
    proRowsDormant,
    rowsFor,
  } from "./presentation.js";
  import PopupProCard from "./PopupProCard.svelte";
  import { DESKTOP_LAYOUT_ONLY_PRO } from "../../entitlement/access-policy.js";
  import type { MobilePopupProps } from "./mobile-presentation.js";
  import { serviceIconSrc } from "./service-icons.js";
  import PopupInvitation from "./PopupInvitation.svelte";
  import { invitationVisible } from "./invitation-presentation.js";
  import Toggle from "./Toggle.svelte";
  import FeatureRow from "./FeatureRow.svelte";
  import Glyph from "./Glyph.svelte";
  import StillProTag from "./StillProTag.svelte";
  import SyncSummary from "./SyncSummary.svelte";
  import "./design/styles.css";

  let {
    settings,
    access,
    host,
    channelReady = false,
    onSeePro,
    appHandoff,
    proOfferReady = true,
    setup,
    onGlobalChange,
    onServiceChange,
    onFeatureChange,
    onSignIn,
    onSettings,
    privacyUrl,
    commandsDisabled = false,
    accountActions,
    account,
    sectionMemory,
    services = ["instagram", "facebook", "youtube", "tiktok"],
    labels = {},
    features,
    invitation,
    siteAccess,
  }: MobilePopupProps = $props();
  let open = $state<ServiceId | null>(
    untrack(() => sectionMemory?.read() ?? null),
  );
  const titles = {
    youtube: "YouTube Blocker",
    instagram: "Instagram Blocker",
    facebook: "Facebook Blocker",
    tiktok: "TikTok Blocker",
  };
  const serviceLabels = {
    youtube: "Still on YouTube",
    instagram: "Still on Instagram",
    facebook: "Still on Facebook",
    tiktok: "TikTok website",
  };
  const statusGlyph = {
    pending: "spinner",
    success: "check",
    failed: "alert",
    caution: "clock",
  } as const;
  const setupCopy = {
    safari: [
      "Still can't block on these websites yet.",
      "In Safari, tap the extensions button, choose Still, then Always Allow on Every Website.",
      "Show me how",
    ],
    firefox: [
      "Still needs permission for these websites.",
      "Firefox asks once. Allow it so Still can remove short-form video on supported sites.",
      "Allow",
    ],
  } as const;
  // A sync or setting change re-confirms access; it never takes the offer away (ISS-0032).
  const offerAccess = createProOfferLatch();
  let shownAccess = $derived(offerAccess(access, account?.address ?? null));
  let knownMissing = $derived(proKnownMissing(shownAccess));
  let dormant = $derived(proRowsDormant(access));
  // ISS-0073: the real snapshot, so only verified purchased ownership shows the tag.
  let stillPro = $derived(proPurchased(access));
  let appActionReady = $derived(
    host === "safari" && Boolean(onSeePro) && knownMissing,
  );
  let browserActionReady = $derived(
    host === "firefox" && Boolean(onSeePro) && knownMissing,
  );
  let invitationReady = $derived(
    invitation?.identity.surface ===
      (host === "safari" ? "safari" : "firefox-android") &&
      (host !== "firefox" || channelReady) &&
      !(host === "safari" && invitation?.kind === "rating") &&
      !setup &&
      !["pending", "failed", "caution"].includes(account?.status?.tone ?? ""),
  );
  // Get Still Pro and the feature locks open the full offer (Firefox's Settings page or the Still
  // app); the popup never starts a payment itself (ISS-0032).
  function openPro() {
    if (appActionReady || browserActionReady) onSeePro?.();
  }
  // Safari actions hand off to the Still app unless the host says otherwise.
  let handoff = $derived(appHandoff ?? host === "safari");
  // A normal settings refresh does not change Pro access. Keep its offer mounted while syncing;
  // setup and sync failures still take priority, and the destination checks sales readiness.
  let popupClear = $derived(
    !setup &&
      !["failed", "caution"].includes(account?.status?.tone ?? ""),
  );
  let proCardShown = $derived(
    (appActionReady || browserActionReady) && proOfferReady && popupClear,
  );
  // While Still is still finding out, the card's place says so (no button), where a card may follow.
  let proCheckingShown = $derived(
    Boolean(onSeePro) && proOfferReady && proAccessChecking(shownAccess) && popupClear,
  );
  let syncInvitationShown = $derived(
    !account && invitationReady && invitation?.kind === "sync" && invitationVisible(invitation),
  );
  function toggleSection(service: ServiceId) {
    open = open === service ? null : service;
    sectionMemory?.write(open);
  }
</script>

<div
  class="still-ui app"
  data-density="compact"
  class:invitation-scroll={invitationReady && invitationVisible(invitation)}
>
  <section class="hero compact" class:off={!settings.globalOn}>
    <div class="hero-text">
      <h1>
        {settings.globalOn ? "Still is active" : "Still is off"}
      </h1>
    </div>
    <Toggle
      checked={settings.globalOn}
      disabled={commandsDisabled}
      onChange={(next) => {
        if (!commandsDisabled) onGlobalChange(next);
      }}
      label="Still"
      onBlue={settings.globalOn}
    />
  </section>
  {#if siteAccess}<SiteAccessCard {...siteAccess} />{/if}
  {#if setup}
    <section class="card card-stack">
      <div class="status-line" data-tone="caution">
        <span class="glyph"><Glyph name="clock" size={16} /></span>
        <div class="status-body">
          <span>{setupCopy[host][0]}</span>
          <span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >{setupCopy[host][1]}</span
          >
        </div>
      </div>
      <button
        type="button"
        class="secondary block"
        aria-disabled={!setup.onAction || undefined}
        onclick={() => setup?.onAction?.()}>{setupCopy[host][2]}</button
      >
    </section>
  {/if}
  <div
    class="service-group site-scroll services"
    data-paused={!settings.globalOn || undefined}
  >
    {#each services as service, index (service)}
      {#if index > 0}<div class="divider"></div>{/if}
      <!-- Phone surfaces never show a Still Pro switch that cannot act in a phone layout
           (owner decision): end-of-video suggestions, live chat and desktop sidebar ads. The
           saved choice is kept; only the row is not drawn. Free rows are never in this list. -->
      {@const rows = rowsFor(service).filter(
        (row) =>
          !(DESKTOP_LAYOUT_ONLY_PRO as readonly string[]).includes(row.id) &&
          (!features || features.includes(row.id)),
      )}
      <div class="site-section" data-paused={!settings.globalOn || undefined}>
        <div class="service-row">
          <span class="icon"
            ><img
              src={serviceIconSrc[service]}
              alt=""
              style="display:block;inline-size:100%;block-size:100%;"
            /></span
          >
          {#if rows.length > 0}
            <button
              type="button"
              class="expander"
              aria-expanded={open === service}
              aria-controls={`site-${service}-panel`}
              onclick={() => toggleSection(service)}
            >
              <span class="text"
                ><span class="name" id={`site-${service}-h`}
                  >{titles[service]}</span
                ></span
              ><Glyph name="chevron" className="chevron" />
            </button>
          {:else}<div class="expander" style="cursor:default;">
              <span class="text"
                ><span class="name" id={`site-${service}-h`}
                  >{titles[service]}</span
                ></span
              >
            </div>{/if}
          <Toggle
            checked={settings.services[service]}
            onChange={(next) => {
              if (!commandsDisabled && settings.globalOn)
                onServiceChange(service, next);
            }}
            disabled={commandsDisabled || !settings.globalOn}
            label={serviceLabels[service]}
          />
        </div>
        {#if rows.length > 0}
          <div
            id={`site-${service}-panel`}
            class="service-options"
            class:open={open === service}
            role="group"
            aria-labelledby={`site-${service}-h`}
          >
            <div class="inner">
              <div class="list">
                {#each rows as row (row.id)}
                  <FeatureRow
                    id={row.id}
                    label={labels[row.id] ?? row.label}
                    state={shownAccess.states[row.id]}
                    dormant={dormant && row.tier === "pro"}
                    checked={settings.sites[row.id]}
                    inactive={commandsDisabled ||
                      !settings.globalOn ||
                      !settings.services[service]}
                    unsupportedText={`Not available in ${host === "safari" ? "Safari" : "this browser"}. Your choice is saved.`}
                    onChange={(next) => {
                      if (
                        !commandsDisabled &&
                        settings.globalOn &&
                        settings.services[service]
                      )
                        onFeatureChange(row.id, next);
                    }}
                    host={host === "safari" ? "safari" : "browser"}
                    onLock={appActionReady || browserActionReady
                      ? openPro
                      : undefined}
                  />
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
  <PopupInvitation presentation={invitationReady && (invitation?.kind !== "sync" || !account) ? invitation : undefined} canonicalSync />
  {#if !syncInvitationShown}
  <section class="card card-stack">
    <div class="sync-row">
      <div class="sync-row-text">
        <!-- The Still Pro tag sits on the heading row, right-aligned (owner, 19 Oct). -->
        <div class="offer-head">
          <h2 class="sync-row-title">Settings sync</h2>
          {#if stillPro}<StillProTag />{/if}
        </div>
        {#if account?.address}<p class="muted sync-row-sub account-line">
            <span class="account-address">{account.address}</span>
          </p>{:else if !account}<p class="muted sync-row-sub">
            Free. Keep your settings the same across every supported device and browser.
          </p>{/if}
      </div>
      {#if !account && onSignIn}<div
          class:popup-action={handoff}
        ><button
          type="button"
          class="primary inline"
          class:with-glyph={handoff}
          aria-describedby={handoff ? "popup-signin-handoff" : undefined}
          onclick={onSignIn}
          >Sign in{#if handoff}<Glyph name="external" size={13} />{/if}</button
        >
        {#if handoff}<p class="handoff" id="popup-signin-handoff">
          <Glyph name="external" size={13} />Opens the Still app
        </p>{/if}
        </div>{/if}
    </div>
    {#if account?.status}
      <div
        class="status-line"
        data-tone={account.status.tone}
        role={account.status.tone === "failed" ? "alert" : "status"}
      >
        {#if account.status.tone !== "info"}<span class="glyph"
            ><Glyph name={statusGlyph[account.status.tone]} /></span
          >{/if}
        <div class="status-body">
          <SyncSummary
            text={account.status.text}
            tone={account.status.tone}
            lastSyncedAt={account.lastSyncedAt}
          />{#if account.status.retry}<button
              type="button"
              class="link status-action"
              onclick={account.status.retry}>Try again</button
            >{/if}
        </div>
      </div>
    {/if}
    {#if accountActions}{@render accountActions()}{/if}
  </section>
  {/if}
  {#if proCardShown}<PopupProCard
      onOpen={openPro}
      appHandoff={handoff}
    />{:else if proCheckingShown}<PopupProCard checking />{/if}
  <footer class="popup-footer">
    <button
      type="button"
      class="open-options"
      aria-label={host === "safari"
        ? "Settings. Opens Still settings."
        : "Settings. Find Still in Firefox."}
      onclick={onSettings}>Settings</button
    ><a class="link" href={privacyUrl}>Privacy policy</a>
  </footer>
</div>

<style>
  .app.invitation-scroll {
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }
  .app[data-density="compact"].invitation-scroll .site-scroll {
    min-block-size: calc(
      var(--tap-target) * var(--text-scale, 1) + 2 *
        var(--service-card-padding-block, var(--space-3))
    );
  }
</style>
