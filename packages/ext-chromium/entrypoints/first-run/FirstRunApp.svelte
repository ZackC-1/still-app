<script lang="ts">
  import { onDestroy } from "svelte";
  import type { UiController } from "@still/core/ui";
  import type {
    CommittedPopupBinding,
    LegacyPopupAuthority,
  } from "@still/core/ui";
  import { DEFAULT_SETTINGS } from "@still/shared-types";
  import FirstRun from "@still/core/ui/v3/FirstRun.svelte";
  import Toggle from "@still/core/ui/v3/Toggle.svelte";
  import { USAGE_SWITCH_COPY } from "@still/core/ui/v3/usage-copy";
  import SignInSheet from "@still/core/ui/components/SignInSheet.svelte";
  import {
    firstRunHostProps,
    type FirstRunBrowser,
    type FirstRunHostObservations,
    type FirstRunSiteAccess,
  } from "@still/core/ui/v3/first-run-host";
  import {
    observePinned,
    observeSiteAccess,
    type PinApi,
    type SiteAccessApi,
  } from "./first-run-ports.js";

  // D14 host. Blocking never waits on this page: the background initialises settings on install
  // whether or not this tab is ever looked at, and nothing here is a precondition for anything.
  let {
    controller: c,
    browser,
    binding,
    legacy,
    permissions,
    origins,
    action,
    toolbar = true,
    onOpenSettings,
    onOpenPrivacy,
  }: {
    controller: UiController;
    browser: FirstRunBrowser;
    /** The committed settings view (modern atomic builds); otherwise the legacy read is used. */
    binding?: CommittedPopupBinding;
    /** The legacy saved-choices read (builds without modern atomic settings). */
    legacy?: LegacyPopupAuthority;
    permissions?: SiteAccessApi;
    origins: readonly string[];
    /** The browser's action API for the pinned report (Chrome, desktop Firefox); absent where
     * there is no toolbar (Firefox for Android). */
    action?: PinApi;
    /** False in Firefox for Android (the browser's own platform answer): no toolbar, no pin step. */
    toolbar?: boolean;
    onOpenSettings?: () => void;
    onOpenPrivacy?: () => void;
  } = $props();

  let siteAccess = $state<FirstRunSiteAccess>("unknown");
  let pinned = $state<boolean | null>(null);
  let choices = $state<FirstRunHostObservations["choices"]>(null);

  // The browser ports are fixed for the page's life: observe once, stop when the page goes.
  let requestSiteAccess = $state<(() => void) | undefined>();
  function observe(): () => void {
    const access = permissions
      ? observeSiteAccess(permissions, origins, (next) => (siteAccess = next))
      : undefined;
    requestSiteAccess = access?.request;
    const stopPinned = observePinned(
      toolbar ? action : undefined,
      (next) => (pinned = next),
    );
    const stopChoices = binding
      ? binding.subscribe((state) => {
          choices = state.settings
            ? {
                globalOn: state.settings.globalOn,
                services: { ...state.settings.services },
              }
            : null;
        })
      : legacy?.subscribeLegacyRead(readLegacy);
    if (!binding && legacy) readLegacy();
    return () => {
      access?.stop();
      stopPinned();
      stopChoices?.();
      binding?.stop();
    };
  }
  // Legacy builds: only an actual read counts. An explicit "nothing saved" reads as the defaults
  // blocking applies (the legacy popup view's own rule); loading and unreadable stay unknown.
  function readLegacy(): void {
    const read = legacy?.legacyReadState();
    const saved =
      read?.status === "ready"
        ? read.settings
        : read?.status === "absent"
          ? DEFAULT_SETTINGS
          : null;
    choices = saved
      ? { globalOn: saved.globalOn, services: { ...saved.services } }
      : null;
  }
  onDestroy(observe());

  let props = $derived(
    firstRunHostProps({
      browser,
      siteAccess,
      requestSiteAccess,
      choices,
      pinned,
      toolbar,
      account: c.userId ? { userId: c.userId, email: c.accountEmail } : null,
      onSignIn: c.canSignIn ? () => c.openSignIn() : undefined,
      onOpenSettings,
      onOpenPrivacy,
    }),
  );
</script>

<!-- The existing usage-sharing switch, the one usage-data control on this page (owner, 12 Oct
     2026; ADR 0004 "V3 consent"): it shows sharing on from install on Chrome and is the off path;
     on Firefox the same data-collection permission prompt sits behind it. There is no one-time
     notice. There is no combined email-and-usage choice to ask yet, so FirstRun receives no
     `consent` and renders this in that place instead (the D03 settings precedent). -->
{#snippet usageActions()}
  {#if c.usageSharing !== null}
    <section class="card card-stack">
      <div class="sync-row">
        <div class="sync-row-text">
          <span
            class="row-title"
            id="usage-t"
            style="font-size:calc(15px * var(--text-scale, 1));font-weight:600;"
            >{USAGE_SWITCH_COPY.title}</span
          ><span class="muted sync-row-sub" id="usage-s">{USAGE_SWITCH_COPY.body}</span>
        </div>
        <Toggle
          checked={c.usageSharing}
          labelledBy="usage-t"
          describedBy="usage-s"
          onChange={() => c.toggleUsageSharing()}
        />
      </div>
    </section>
  {/if}
{/snippet}

<FirstRun {...props} privacyActions={usageActions} />

{#if c.signInOpen && (c.popupState === "signed-out" || c.popupState === "pro-no-account")}
  <SignInSheet controller={c} onDismiss={() => c.dismissSignIn()} />
{/if}
