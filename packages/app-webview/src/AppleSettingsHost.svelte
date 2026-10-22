<script lang="ts">
  // D04 Apple settings host: prop plumbing only. Every rule lives in @still/core's tested
  // apple-settings-host module and the existing committed popup view binding. The entry reaches
  // this file only through a dynamic import that default builds fold away, so AppleSettings and
  // its global stylesheet exist only in bundles that opt in. Its dedicated @still/core export
  // keeps the dependency outside this package's rootDir: src. Keep this leaf out of @still/core/ui.
  import { tick, untrack } from "svelte";
  import PurchaseView from "@still/core/ui/v3/PurchaseView.svelte";
  import { FEATURE_REGISTRY, PAID_TIER_ENABLED } from "@still/shared-types";
  import {
    APPLE_PURCHASE_SIGN_IN_COPY,
    createAppleProHost,
    type AppleProHostDeps,
  } from "@still/core/ui/v3/apple-pro-host";
  import {
    createAppleAppRoutes,
    createAppleSyncRoute,
    revealAppleSyncCardWhenRendered,
  } from "@still/core/ui/v3/apple-sync-route";
  import AppleSettings from "@still/core/ui/v3/AppleSettings.svelte";
  import SettingsSwitch from "@still/core/ui/v3/Toggle.svelte";
  import { USAGE_SWITCH_COPY } from "@still/core/ui/v3/usage-copy";
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
      | "analytics"
      | "bridge"
      | "refreshAccountAccess"
      | "verifyLocalPurchase"
      | "ownershipRevision"
      | "readLinkEligibility"
      | "readAccountHeldPro"
      | "linkPurchase"
    >;
    onCommittedToggle?: (toggle: CommittedPopupToggle) => void;
    /** The app's pending fixed routes (still://pro and still://sync), read by one router. */
    appRoutes?: Pick<NativeBridge, "pendingAppRoute" | "acknowledgeAppRoute">;
    /** Settles once this launch's saved-session resume has finished (signed in or not). */
    accountSettled?: () => Promise<unknown>;
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
    appRoutes,
    accountSettled,
  }: Props = $props();

  // Finish any older observation, then read the cache after the native commit. This is the same
  // sequencing local purchase installation uses; refreshAccess coalesces an existing read.
  async function readCommittedAccess() {
    await authority.entitlement.refreshAccess();
    return authority.entitlement.refreshAccess();
  }
  let proRevision = $state(0);
  const proHost = untrack(() =>
    proServices
      ? createAppleProHost({
          ...proServices,
          readAccess: () => authority.entitlement.refreshAccess(),
          ...(proServices.refreshAccountAccess ? {
            refreshAccountAccess: async () => {
              await proServices.refreshAccountAccess!();
              return readCommittedAccess();
            },
          } : {}),
          verifyLocalPurchase: async () => {
            // The installer reads its signed binding back first. Refresh the same settings
            // authority afterward so rows and the purchase screen observe that committed cache.
            await proServices.verifyLocalPurchase();
            return readCommittedAccess();
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
          canSignIn: () => c.canSignIn,
          signedIn: () => c.userId !== null,
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
  // ISS-0071: Get Still Pro opened sign-in. The sheet adds one line and "Buy without an account".
  let purchaseSignIn = $derived.by(() => {
    void proRevision;
    return proHost?.signInForPurchase ?? false;
  });
  // Closed without signing in (Cancel, the scrim, Escape or any other close): nothing is bought.
  $effect(() => {
    if (!c.signInOpen && c.userId === null) untrack(() => proHost?.signInDismissed());
  });
  function buyWithoutAccount() {
    proHost?.buyWithoutAccount();
    c.dismissSignIn();
  }
  // Accountless holders: signed out, "Sign in to keep Still Pro with your account."; signed in,
  // "Link Still Pro to your account" (ISS-0076). Both run the existing explicit link, which ends in
  // the "Link Still Pro to this account?" confirmation. Not now hides the card until the app is
  // next opened.
  let linkInviteDismissed = $state(false);
  let linkOffer = $derived(canLink && (c.userId !== null || c.canSignIn));
  $effect(() => {
    void c.userId;
    void c.accountEmail;
    void c.accountConfirmed;
    void accountRevision;
    proHost?.accountChanged();
  });
  $effect(() => {
    if (!proHost) return;
    // With appRoutes, the one app router below reads routes for both handlers.
    const route = () => {
      if (!appRoutes) void proHost.route();
    };
    const accountAccess = () => void readCommittedAccess().catch(() => {});
    const refresh = () => {
      if (document.visibilityState === "visible") void proHost.refresh();
    };
    window.addEventListener("still:route", route);
    window.addEventListener("still:accountAccess", accountAccess);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    route();
    void untrack(() => proHost.refresh());
    return () => {
      window.removeEventListener("still:route", route);
      window.removeEventListener("still:accountAccess", accountAccess);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      proHost.stop();
    };
  });
  // The app's fixed routes, read once per notification: still://pro opens the Still Pro screen;
  // still://sync (the Safari popup's Sign in) shows Settings with the sync card, and sign-in when
  // signed out, after the launch's account resume has settled.
  $effect(() => {
    if (!appRoutes) return;
    const routes = createAppleAppRoutes({
      bridge: appRoutes,
      ...(proHost ? { pro: proHost } : {}),
      sync: createAppleSyncRoute({
        bridge: appRoutes,
        showSettings: () => proHost?.close(),
        ...(accountSettled ? { accountSettled } : {}),
        canSignIn: () =>
          c.canSignIn &&
          (c.popupState === "signed-out" || c.popupState === "pro-no-account"),
        openSignIn: () => c.openSignIn(),
        closeSignIn: () => c.dismissSignIn(),
        reveal: (focus) =>
          void tick().then(() =>
            revealAppleSyncCardWhenRendered(document, focus),
          ),
      }),
    });
    const route = () => void routes.route();
    window.addEventListener("still:route", route);
    untrack(route);
    return () => {
      window.removeEventListener("still:route", route);
      routes.stop();
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
  let accountRevision = $derived(c.accountRevision);
  let sync = $derived.by(() => {
    void accountRevision;
    void proRevision;
    const current = syncFor(c);
    // ISS-0105: the heading tag reads "Still Pro User" only for the account's own Still Pro.
    return current.account
      ? { ...current, account: { ...current.account, holdsPro: proHost?.accountHoldsPro === true } }
      : current;
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
  // Whether a setup read has confirmed the platform. A read that times out or observes nothing
  // leaves it false, so a Mac is never treated as a phone.
  let platformKnown = $state(false);
  let setup = $state.raw<AppleSettingsProps["setup"]>(undefined);
  $effect(() =>
    watchAppleSetup(
      observeSetup,
      (next) => {
        setup = next.setup;
        if (next.platform) {
          platform = next.platform;
          platformKnown = true;
        }
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
      // ISS-0104: the "linked to another account" card states a fact and asks nothing, like
      // the linked status; neither holds the rating prompt.
      paywallOpen:
        purchaseOpen ||
        (proState?.link !== undefined &&
          proState.link.state !== "linked" &&
          proState.link.state !== "elsewhere") ||
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
  let settingsScreen: HTMLDivElement | undefined = $state();
  let purchaseScreen: HTMLDivElement | undefined = $state();
  let purchaseReturnFocus: HTMLElement | undefined;
  let purchaseReturnScroll = 0;
  $effect(() => {
    if (!purchaseOpen || platform !== "mac") return;
    let live = true;
    void tick().then(() => {
      if (!live) return;
      purchaseScreen?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    });
    return () => { live = false; };
  });
  // Capture before hiding Settings: real browsers clear focus when its ancestor becomes hidden.
  function openPurchase() {
    const active = document.activeElement;
    purchaseReturnFocus = active instanceof HTMLElement && settingsScreen?.contains(active)
      ? active : undefined;
    purchaseReturnScroll = document.scrollingElement?.scrollTop ?? 0;
    proState?.pro?.onBuy?.();
  }
  let settingsPro = $derived(platform === "mac" && proState?.pro ? {
    ...proState.pro,
    onBuy: proState.pro.onBuy ? openPurchase : undefined,
  } : proState?.pro);
  async function closePurchase() {
    proHost?.close();
    await tick();
    if (purchaseReturnFocus?.isConnected) purchaseReturnFocus.focus({ preventScroll: true });
    if (document.scrollingElement) document.scrollingElement.scrollTop = purchaseReturnScroll;
  }
  function retry(): void {
    if (recovering) return;
    recovering = true;
    void authority.recover().finally(() => {
      recovering = false;
    });
  }
</script>

<!-- The existing Apple usage-sharing switch, driven by the native analytics consent through the
     controller: the one usage-data control, with no one-time notice (owner, 12 Oct 2026; ADR 0004
     "V3 consent"). It is not the combined email-plus-usage choice. -->
{#snippet usageActions()}
  {#if c.usageSharing !== null}
    <section class="card card-stack">
      <div class="sync-row">
        <div class="sync-row-text">
          <span
            class="row-title"
            id="usage-sharing-title"
            style="font-size:calc(15px * var(--text-scale, 1));font-weight:600;"
            >{USAGE_SWITCH_COPY.title}</span
          ><span class="muted sync-row-sub" id="usage-sharing-body"
            >{USAGE_SWITCH_COPY.body}</span
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
  <div bind:this={purchaseScreen}>
    <PurchaseView {...purchaseProps} onBack={platform === "mac" ? closePurchase : purchaseProps.onBack} phone={platformKnown && platform === "ios"} />
  </div>
  {#if canLink && c.userId !== null}<div class="still-ui app">
      <button
        type="button"
        class="secondary block"
        onclick={() => {
          proHost?.close();
          proHost?.requestLink();
        }}>Link Still Pro to your account</button
      >
    </div>{/if}
{/if}
<!-- Retain section, focus and settings bindings while inspecting the offer. -->
<div bind:this={settingsScreen} hidden={purchaseOpen}>
{#if !purchaseOpen || platform === "mac"}
{#if view.settings && view.state && view.commands}
  <AppleSettings
    commandsDisabled={view.held}
    settings={view.settings}
    access={view.state.access}
    {platform}
    phone={platformKnown && platform === "ios"}
    onGlobalChange={view.commands.global}
    onServiceChange={view.commands.service}
    onFeatureChange={view.commands.feature}
    {sync}
    pro={settingsPro}
    link={proState?.link}
    linkInvitation={linkOffer && !linkInviteDismissed
      ? {
          eligibleLaterVisit: true,
          signedIn: c.userId !== null,
          onLink: () => void proHost?.requestLink(),
          onDismiss: () => (linkInviteDismissed = true),
        }
      : undefined}
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
      <p class="muted" role="status">{STRINGS.sync.loading}</p>
    {/if}
    {@render usageActions()}
  </div>
{/if}

{/if}
</div>

{#if c.signInOpen && (c.popupState === "signed-out" || c.popupState === "pro-no-account")}
  <SignInSheet
    controller={c}
    host="apple"
    onDismiss={() => c.dismissSignIn()}
    title={purchaseSignIn ? APPLE_PURCHASE_SIGN_IN_COPY.title : undefined}
    prompt={purchaseSignIn ? APPLE_PURCHASE_SIGN_IN_COPY.prompt : undefined}
    note={purchaseSignIn ? APPLE_PURCHASE_SIGN_IN_COPY.note : undefined}
    skip={purchaseSignIn
      ? { label: APPLE_PURCHASE_SIGN_IN_COPY.skip, onSkip: buyWithoutAccount }
      : undefined}
  />
{/if}
