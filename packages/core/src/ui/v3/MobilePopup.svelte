<script lang="ts">
  import { untrack } from "svelte";
  import { FEATURE_REGISTRY, type ServiceId } from "@still/shared-types";
  import { proRowsDormant, rowsFor } from "./presentation.js";
  import type { MobilePopupProps } from "./mobile-presentation.js";
  import { serviceIconSrc } from "./service-icons.js";
  import PopupInvitation from "./PopupInvitation.svelte";
  import { invitationVisible } from "./invitation-presentation.js";
  import Toggle from "./Toggle.svelte";
  import FeatureRow from "./FeatureRow.svelte";
  import Glyph from "./Glyph.svelte";
  import "./design/styles.css";

  let {
    settings,
    access,
    host,
    channelReady = false,
    onSeePro,
    setup,
    onGlobalChange,
    onServiceChange,
    onFeatureChange,
    onSignIn,
    onSettings,
    privacyUrl,
    commandsDisabled = false,
    accountActions,
    onPurchase,
    account,
    sectionMemory,
    services = ["youtube", "instagram", "facebook", "tiktok"],
    labels = {},
    features,
    invitation,
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
  let dormant = $derived(proRowsDormant(access));
  let offer = $derived(
    host === "firefox" && channelReady && Boolean(onPurchase) && knownMissing,
  );
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
  function openPro() {
    if (appActionReady || browserActionReady) onSeePro?.();
  }
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
      {@const rows = rowsFor(service).filter(
        (row) =>
          row.id !== "facebook.sponsored" &&
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
                    state={access.states[row.id]}
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
                      onLock={appActionReady || browserActionReady ? openPro : undefined}
                  />
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
  {#if offer}<button type="button" class="secondary block" onclick={onPurchase}
      >Purchase Still Pro</button
    >{/if}
  {#if host === "safari" && knownMissing}
    <button
      type="button"
      class="secondary block"
      aria-label="See Still Pro in the Still app"
      aria-disabled={!appActionReady || undefined}
      onclick={openPro}>See Still Pro</button
    >
  {/if}
  <PopupInvitation presentation={invitationReady ? invitation : undefined} />
  <section class="card card-stack">
    <div class="sync-row">
      <div class="sync-row-text">
        <h2 class="sync-row-title">Settings sync</h2>
        <p class="muted sync-row-sub">
          {account
            ? account.address
            : "Free. Keep your settings updated across every supported surface."}
        </p>
      </div>
      {#if !account && onSignIn}<button
          type="button"
          class="primary inline"
          onclick={onSignIn}>Sign in</button
        >{/if}
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
          <span>{account.status.text}</span>{#if account.status.retry}<button
              type="button"
              class="link status-action"
              onclick={account.status.retry}>Try again</button
            >{/if}
        </div>
      </div>
    {/if}
    {#if accountActions}{@render accountActions()}{/if}
  </section>
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
