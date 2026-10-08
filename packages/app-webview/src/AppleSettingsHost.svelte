<script lang="ts">
  // D04 Apple settings host: prop plumbing only. Every rule lives in @still/core's tested
  // apple-settings-host module and the existing committed popup view binding. The entry reaches
  // this file only through a dynamic import that default builds fold away, so AppleSettings and
  // its global stylesheet exist only in bundles that opt in. Its dedicated @still/core export
  // keeps the dependency outside this package's rootDir: src. Keep this leaf out of @still/core/ui.
  import { untrack } from "svelte";
  import PurchaseView from "@still/core/ui/v3/PurchaseView.svelte";
  import { FEATURE_REGISTRY, PAID_TIER_ENABLED } from "@still/shared-types";
  import {
    createAppleProHost,
    type AppleProHostDeps,
  } from "@still/core/ui/v3/apple-pro-host";
  import AppleSettings from "@still/core/ui/v3/AppleSettings.svelte";
  import SettingsSwitch from "@still/core/ui/v3/Toggle.svelte";
  import {
    STRINGS,
    SignInSheet,
    createPopupViewBinding,
    createAppleSettingsSync,
    appleSettingsRestore,
    createAppleSettingsRestore,
    watchAppleSetup,
    type AppleRestoreBridge,
    type AppleSetupOpener,
    type AppleSettingsAuthority,
    type AppleSettingsProps,
    type CommittedPopupToggle,
    type UiController,
  } from "@still/core/ui";
  import type { NativeBridge } from "@still/core/native";
  import {
    appleRatingHold,
    reportRatingHold,
  } from "@still/core/invitations/rating-hold";

  interface Props {
    controller: UiController;
    /** Committed binding, access and recovery over the entry's one cache; stopped on unmount. */
    authority: AppleSettingsAuthority;
    /** Native setup observation (NativeBridge.observeSafariSetup), bounded in core. */
    observeSetup: NativeBridge["observeSafariSetup"];
    help: AppleSettingsProps["help"];
    /** Native restore and receipt reads for the free-period Restore link; absent, no link. */
    restoreBridge?: AppleRestoreBridge;
    /** Opens the setup card's fixed destination from a tap; absent, its button stays disabled. */
    openDestination?: AppleSetupOpener;
    proServices?: Pick<
      AppleProHostDeps,
      | "bridge"
      | "verifyLocalPurchase"
      | "ownershipRevision"
      | "readLinkEligibility"
      | "linkPurchase"
    >;
    onCommittedToggle?: (toggle: CommittedPopupToggle) => void;
  }
  let {
    controller: c,
    authority,
    observeSetup,
    help,
    restoreBridge,
    openDestination,
    onCommittedToggle,
    proServices,
  }: Props = $props();

  let proRevision = $state(0);
  const proHost = untrack(() =>
    proServices
      ? createAppleProHost({
          ...proServices,
          readAccess: () => authority.entitlement.refreshAccess(),
          verifyLocalPurchase: async () => {
            // The installer reads its signed binding back first. Refresh the same settings
            // authority afterward so rows and the purchase screen observe that committed cache.
            await proServices.verifyLocalPurchase();
            await authority.entitlement.refreshAccess();
            return authority.entitlement.refreshAccess();
          },
          account: () =>
            c.userId && c.accountEmail
              ? {
                  id: c.userId,
                  email: c.accountEmail,
                  revision: c.accountRevision,
                  confirmed: c.accountConfirmed,
                }
              : null,
          signIn: () => c.openSignIn(),
          chooseOtherAccount: async () => {
            await c.signOut();
          },
          publish: () => {
            proRevision = untrack(() => proRevision) + 1;
          },
        })
      : undefined,
  );
  $effect(() => {
    if (!proHost) return;
    const entitlement = authority.entitlement;
    proHost.observeAccess(entitlement.currentAccessSnapshot());
    return entitlement.subscribeAccess((snapshot) =>
      proHost.observeAccess(snapshot),
    );
  });
  let proState = $derived.by(() => {
    void proRevision;
    return proHost?.settings();
  });
  let purchaseOpen = $derived.by(() => {
    void proRevision;
    return proHost?.open ?? false;
  });
  let purchaseProps = $derived.by(() => {
    void proRevision;
    return proHost?.props(
      FEATURE_REGISTRY.filter(
        (row) =>
          row.tier === "pro" &&
          view.state !== null &&
          view.state.access.states[row.id] !== "unsupported",
      ).map((row) => ({
        site: {
          youtube: "YouTube",
          instagram: "Instagram",
          facebook: "Facebook",
        }[row.service],
        label: row.name,
      })),
    );
  });
  let canLink = $derived.by(() => {
    void proRevision;
    return proHost?.canLink ?? false;
  });
  $effect(() => {
    void c.userId;
    void c.accountEmail;
    void c.accountConfirmed;
    void accountRevision;
    proHost?.accountChanged();
  });
  $effect(() => {
    if (!proHost) return;
    const route = () => void proHost.route();
    const refresh = () => {
      if (document.visibilityState === "visible") void proHost.refresh();
    };
    window.addEventListener("still:route", route);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    route();
    void proHost.refresh();
    return () => {
      window.removeEventListener("still:route", route);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      proHost.stop();
    };
  });
  const view = createPopupViewBinding(
    () => authority.binding,
    (toggle) => onCommittedToggle?.(toggle),
  );
  $effect(() => {
    const current = authority;
    return () => current.stop();
  });
  const syncFor = createAppleSettingsSync();
  // The controller's revision is plain; its session/sync signals expose the current epoch.
  // Derived equality prevents routine sync polling from issuing another account verification.
  let accountRevision = $derived.by(() => {
    void c.userId;
    void c.accountEmail;
    void c.authFlow;
    void c.reconciling;
    void c.cloudReachable;
    void c.pendingUpload;
    void c.lastSyncedAt;
    return c.accountRevision;
  });
  let sync = $derived.by(() => {
    void accountRevision;
    return syncFor(c);
  });
  $effect(() => {
    if (!PAID_TIER_ENABLED) return;
    void c.userId;
    void accountRevision;
    void c.refreshAccountConfirmation();
  });
  $effect(() => {
    if (!PAID_TIER_ENABLED) return;
    const current = c;
    const refresh = () => void current.refreshAccountConfirmation();
    const foreground = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", foreground);
    };
  });
  // Free-period Restore (owner decision 17): its own status, or a controller-driven one.
  let restoreStatus = $state.raw<AppleSettingsProps["restore"]>(undefined);
  function nativeRestore(): AppleRestoreBridge {
    if (!restoreBridge) throw new Error("No native restore");
    return restoreBridge;
  }
  const freeRestore = createAppleSettingsRestore({
    bridge: {
      restoreCheck: () => nativeRestore().restoreCheck(),
      receiptStatus: () => nativeRestore().receiptStatus(),
    },
    refreshAccess: () => authority.entitlement.refreshAccess(),
    publish: (next) => (restoreStatus = next),
  });
  $effect(() => () => freeRestore.stop());
  let restore = $derived(
    proState?.restore ?? restoreStatus ?? appleSettingsRestore(c),
  );
  // Platform starts as the narrower iOS inventory and follows any later successful observation.
  let platform = $state<AppleSettingsProps["platform"]>("ios");
  let setup = $state.raw<AppleSettingsProps["setup"]>(undefined);
  $effect(() =>
    watchAppleSetup(
      observeSetup,
      (next) => {
        setup = next.setup;
        if (next.platform) platform = next.platform;
      },
      undefined,
      undefined,
      openDestination,
    ),
  );
  // Until the first native read settles, a hold is "checking", not "unavailable".
  let reading = $state(true);
  let recovering = $state(false);
  $effect(() => {
    let live = true;
    void authority.settled.then(() => {
      if (live) reading = false;
    });
    return () => {
      live = false;
    };
  });
  // Tell the app what this screen is in the middle of, so Apple's rating sheet waits (U13-P3).
  // One closed word per change; the app holds until the first report arrives.
  let ratingHold = $derived(
    appleRatingHold({
      authFlow: c.authFlow,
      signInOpen: c.signInOpen,
      usageNoticeVisible: c.usageNoticeVisible,
      deleteFlow: c.deleteFlow,
      purchaseFlow:
        proState?.pro?.state === "pending" ? "purchasing" : c.purchaseFlow,
      checkoutFlow: c.checkoutFlow,
      paywallOpen:
        purchaseOpen ||
        (proState?.link !== undefined && proState.link.state !== "linked") ||
        c.paywallOpen,
      successScreen:
        purchaseOpen && proState?.pro?.state === "success"
          ? "synced"
          : c.successScreen,
      signedIn: c.userId !== null,
      cloudReachable: c.cloudReachable,
      restoreShown: restore !== undefined,
      settingsHeld:
        !(view.settings && view.state && view.commands) ||
        view.settingsUnavailable,
    }),
  );
  $effect(() => reportRatingHold(ratingHold));
  function retry(): void {
    if (recovering) return;
    recovering = true;
    void authority.recover().finally(() => {
      recovering = false;
    });
  }
</script>

<!-- The existing Apple usage-sharing control and copy, driven by the native analytics consent
     through the controller. It is not the combined email-plus-usage choice. -->
{#snippet usageActions()}
  {#if c.usageNoticeVisible}
    <section class="card card-stack" aria-live="polite">
      <p class="muted">{STRINGS.usage.notice}</p>
      <div class="inline-actions">
        <button
          type="button"
          class="link"
          onclick={() => c.toggleUsageSharing()}
          >{STRINGS.usage.noticeTurnOff}</button
        >
        <button
          type="button"
          class="secondary"
          onclick={() => c.dismissUsageNotice()}
          >{STRINGS.usage.noticeOk}</button
        >
      </div>
    </section>
  {/if}
  {#if c.usageSharing !== null}
    <section class="card card-stack">
      <div class="sync-row">
        <div class="sync-row-text">
          <span
            class="row-title"
            id="usage-sharing-title"
            style="font-size:calc(15px * var(--text-scale, 1));font-weight:600;"
            >{STRINGS.usage.title}</span
          ><span class="muted sync-row-sub" id="usage-sharing-body"
            >{STRINGS.usage.body}</span
          >
        </div>
        <SettingsSwitch
          checked={c.usageSharing}
          labelledBy="usage-sharing-title"
          describedBy="usage-sharing-body"
          onChange={() => c.toggleUsageSharing()}
        />
      </div>
    </section>
  {/if}
{/snippet}

{#snippet settingsRecovery()}
  {#if view.settingsUnavailable && !reading}
    <p class="muted" role="status">Settings are unavailable.</p>
    <button
      type="button"
      class="secondary block"
      disabled={recovering}
      onclick={retry}>Try again</button
    >
  {/if}
{/snippet}

{#if purchaseOpen && purchaseProps}
  <PurchaseView {...purchaseProps} />
  {#if canLink}<div class="still-ui app">
      <button
        type="button"
        class="secondary block"
        onclick={() => {
          proHost?.close();
          proHost?.requestLink();
        }}>Link Still Pro to an account</button
      >
    </div>{/if}
{:else if view.settings && view.state && view.commands}
  <AppleSettings
    settings={view.settings}
    access={view.state.access}
    {platform}
    onGlobalChange={view.commands.global}
    onServiceChange={view.commands.service}
    onFeatureChange={view.commands.feature}
    {sync}
    pro={proState?.pro}
    link={proState?.link}
    {restore}
    onRestore={restoreBridge ? freeRestore.start : undefined}
    {setup}
    privacyActions={usageActions}
    {help}
  />
  {#if proState?.pro?.verificationRequired}
    <div class="still-ui app">
      <button
        type="button"
        class="secondary block"
        onclick={() => proHost?.show()}>Verify purchase</button
      >
    </div>
  {/if}
  {#if canLink}<div class="still-ui app">
      <button type="button" class="link" onclick={() => proHost?.requestLink()}
        >Link Still Pro to an account</button
      >
    </div>{/if}
  {#if view.settingsUnavailable && !reading}
    <div class="still-ui app" data-host="apple">
      {@render settingsRecovery()}
    </div>
  {/if}
{:else}
  <!-- Held: no accepted committed choices yet. Never startup defaults or a saved Off. -->
  <div class="still-ui app" data-host="apple" data-settings-held="">
    {#if view.settingsUnavailable && !reading}
      {@render settingsRecovery()}
    {:else}
      <p class="muted" role="status">{STRINGS.sync.checking}</p>
    {/if}
    {@render usageActions()}
  </div>
{/if}

{#if c.signInOpen && (c.popupState === "signed-out" || c.popupState === "pro-no-account")}
  <SignInSheet controller={c} onDismiss={() => c.dismissSignIn()} />
{/if}
