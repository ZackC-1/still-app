<script lang="ts">
  import SiteAccessCard from "./SiteAccessCard.svelte";
  import { untrack } from "svelte";
  import type { ServiceId } from "@still/shared-types";
  import {
    createProOfferLatch,
    proAccessChecking,
    proKnownMissing,
    stillProTag,
    proRowsDormant,
    rowsFor,
    type DesktopPopupProps,
  } from "./presentation.js";
  import PopupProCard from "./PopupProCard.svelte";
  import { serviceIconSrc } from "./service-icons.js";
  import PopupInvitation from "./PopupInvitation.svelte";
  import {
    sameInvitationIdentity,
    invitationVisible,
    type InvitationIntentPort,
  } from "./invitation-presentation.js";
  import Toggle from "./Toggle.svelte";
  import FeatureRow from "./FeatureRow.svelte";
  import Glyph from "./Glyph.svelte";
  import SyncSummary from "./SyncSummary.svelte";
  import StillProTag from "./StillProTag.svelte";
  import "./design/styles.css";

  let {
    settings,
    access,
    browser,
    onGlobalChange,
    onServiceChange,
    onFeatureChange,
    onSignIn,
    onSettings,
    settingsLabel,
    privacyUrl,
    commandsDisabled = false,
    accountActions,
    onSeePro,
    appHandoff = false,
    proOfferReady = true,
    account,
    sectionMemory,
    services = ["instagram", "facebook", "youtube", "tiktok"],
    labels = {},
    features,
    heroTitle,
    invitation,
    invitationVariant,
    desktopSetup,
    siteAccess,
  }: DesktopPopupProps = $props();
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
  // A sync or setting change re-confirms access; it never takes the offer away (ISS-0032).
  const offerAccess = createProOfferLatch();
  let shownAccess = $derived(offerAccess(access, account?.address ?? null));
  let knownMissing = $derived(proKnownMissing(shownAccess));
  // Get Still Pro and the feature locks open the full offer (the host's Still Pro destination).
  let proDestinationReady = $derived(Boolean(onSeePro) && knownMissing);
  function openPro() {
    if (proDestinationReady) onSeePro?.();
  }
  // A normal settings refresh does not change Pro access. Keep its offer mounted while syncing;
  // setup and sync failures still take priority, and the destination checks sales readiness.
  let popupClear = $derived(
    !desktopSetup &&
      !["failed", "caution"].includes(account?.status?.tone ?? ""),
  );
  let proCardShown = $derived(proDestinationReady && proOfferReady && popupClear);
  // While Still is still finding out, the card's place says so (no button), where a card may follow.
  let proCheckingShown = $derived(
    Boolean(onSeePro) && proOfferReady && proAccessChecking(shownAccess) && popupClear,
  );
  let dormant = $derived(proRowsDormant(access));
  // ISS-0073: the real snapshot, so only verified purchased ownership shows the tag.
  let stillPro = $derived(stillProTag(access, account));
  /** Safari, signed out holding Still Pro: the tag sits in the right column above Sign in. */
  let tagAboveSignIn = $derived(Boolean(stillPro) && !account && Boolean(onSignIn) && appHandoff);
  let invitationReady = $derived(
    invitation?.identity.surface === browser.toLowerCase() &&
      !desktopSetup &&
      !["pending", "failed", "caution"].includes(account?.status?.tone ?? ""),
  );
  let setupRequested = $state.raw<
    {
      identity: InvitationIntentPort["identity"];
      request: InvitationIntentPort["request"];
    }[]
  >([]);
  function setupClaimed(port: InvitationIntentPort | undefined) {
    return Boolean(
      port &&
      setupRequested.some(
        (claim) =>
          claim.request === port.request &&
          sameInvitationIdentity(claim.identity, port.identity),
      ),
    );
  }
  function setupIntent(
    current: NonNullable<DesktopPopupProps["desktopSetup"]>,
  ) {
    const port = current.action;
    const request = port?.request;
    const identity = port ? { ...port.identity } : undefined;
    return () => {
      if (
        desktopSetup !== current ||
        current.action !== port ||
        setupClaimed(port) ||
        !port?.verified ||
        port.status !== "ready" ||
        port.request !== request ||
        !identity ||
        !sameInvitationIdentity(identity, port.identity) ||
        !identity.installation.trim() ||
        !identity.opening.trim() ||
        identity.surface !== browser.toLowerCase()
      )
        return;
      setupRequested = [...setupRequested, { identity, request: port.request }];
      request?.();
    };
  }
  function setupReady() {
    const port = desktopSetup?.action;
    return Boolean(
      port?.verified &&
      !setupClaimed(port) &&
      port.status === "ready" &&
      port.identity.installation.trim() &&
      port.identity.opening.trim() &&
      port.identity.surface === browser.toLowerCase(),
    );
  }
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
  class:app-handoff={appHandoff}
  class:d28-invitation={invitationVariant === "d28"}
  class:invitation-scroll={invitationReady && invitationVisible(invitation)}
  style="max-inline-size: 380px;"
>
  <section class="hero compact" class:off={!settings.globalOn}>
    <div class="hero-text">
      <h1>
        {heroTitle ?? (settings.globalOn ? "Still is active" : "Still is off")}
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
  {#if desktopSetup}
    {#key desktopSetup}
      <section class="card card-stack">
        <div class="status-line" data-tone="caution">
          <span class="glyph"><Glyph name="clock" size={16} /></span>
          <div class="status-body">
            <span>{desktopSetup.title}</span><span
              class="muted"
              style="font-size:calc(12.5px * var(--text-scale, 1));"
              >{desktopSetup.detail}</span
            >
          </div>
        </div>
        <button
          type="button"
          class="secondary block"
          aria-disabled={!setupReady() || undefined}
          onclick={setupIntent(desktopSetup)}>{desktopSetup.actionLabel}</button
        >
      </section>
    {/key}
  {/if}
  <div
    class="service-group site-scroll services"
    data-paused={!settings.globalOn || undefined}
  >
    {#each services as service, index (service)}
      {#if index > 0}<div class="divider"></div>{/if}
      {@const rows = rowsFor(service).filter(
        (row) => !features || features.includes(row.id),
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
                {#if open === service}
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
                      unsupportedText="Not available in this browser. Your choice is saved."
                      onChange={(next) => {
                        if (
                          !commandsDisabled &&
                          settings.globalOn &&
                          settings.services[service]
                        )
                          onFeatureChange(row.id, next);
                      }}
                      host={appHandoff ? "safari" : "browser"}
                      onLock={proDestinationReady ? openPro : undefined}
                    />
                  {/each}
                {/if}
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
    <div class="sync-row" class:pro-signed-out={tagAboveSignIn}>
      <div class="sync-row-text">
        <!-- The Still Pro tag sits on the heading row, right-aligned (owner, 19 Oct). In Safari,
          signed out, it moves to the right column, directly above Sign in and level with the
          heading, so the heading stays on one line (owner, 21 Oct; the pro-signed-out grid). -->
        <div class="offer-head">
          <h2 class="sync-row-title">Settings sync</h2>
          {#if stillPro && !tagAboveSignIn}<StillProTag kind={stillPro} />{/if}
        </div>
        {#if account?.address}<p class="muted sync-row-sub account-line">
            <span class="account-address">{account.address}</span>
          </p>{:else if !account}<p class="muted sync-row-sub">
            Sync settings across devices and browsers. Free.
          </p>{/if}
      </div>
      {#if !account && onSignIn}<div
          class:popup-action={appHandoff}
        >{#if tagAboveSignIn && stillPro}<StillProTag kind={stillPro} />{/if}<button
          type="button"
          class="primary inline"
          aria-describedby={appHandoff ? "popup-signin-handoff" : undefined}
          onclick={onSignIn}
          >Sign in</button
        >
        {#if appHandoff}<p class="handoff" id="popup-signin-handoff">
          Opens the Still app
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
      {appHandoff}
    />{:else if proCheckingShown}<PopupProCard checking />{/if}
  <footer class="popup-footer">
    <button
      type="button"
      class="open-options"
      aria-label={settingsLabel ?? `Settings. Find Still in ${browser}.`}
      onclick={onSettings}>Settings</button
    ><a class="link" href={privacyUrl}>Privacy policy</a>
  </footer>
</div>

<style>
  /* ISS-0098 (owner, 21 Oct, option B): the popup grows to fit an expanded site; the site list is
     never a scroll box of its own. Past the browser's popup height limit (about 600px) the whole
     popup scrolls: the document, never a box inside it. The Safari popup already scrolls its page
     the same way (SafariV3Popup). The phone popup (MobilePopup) is unchanged.
     Lead ruling, 22 Oct: at 1.5x text size and larger the browser's popup frame may scroll (Chrome
     caps popups at 600px), as the shipped popup with sign-in and Still Pro does; nothing inside the
     popup ever scrolls, and at 1x the option B growth holds. */
  .app[data-density="compact"] {
    max-block-size: none;
  }
  .app[data-density="compact"] .site-scroll {
    flex: none;
    max-block-size: none;
    overflow: visible;
  }
  /* The list's former scroll-padding, now for the document: a control scrolled into view (keyboard
     focus, larger text) is never left a fraction of a pixel under the popup's edge. */
  .site-scroll :global(:is(button, a, [role="switch"])) {
    scroll-margin-block: var(--space-1);
  }
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
  /* "Settings sync" uses the shared card heading (15px, semibold, ink), the same as the Still Pro
     and Share usage data headings on every surface (owner, 12 Oct); only its spacing stays. */
  .sync-row-title {
    margin: 0 0 4px;
  }
  .d28-invitation .sync-row-title {
    margin: 0;
  }
</style>
