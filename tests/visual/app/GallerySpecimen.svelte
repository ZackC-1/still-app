<script lang="ts">
  // Review-only composition of production components. Observations below are specimen inputs,
  // not authentication, purchases, consent deletion, rating grants or native/provider proof.
  import type { AccessState, FeatureId } from "@still/shared-types";
  import FeatureRow from "../../../packages/core/src/ui/v3/FeatureRow.svelte";
  import SharingCard from "../../../packages/core/src/ui/v3/SharingCard.svelte";
  import ProOfferCard from "../../../packages/core/src/ui/v3/ProOfferCard.svelte";
  import NativeProOfferCard from "../../../packages/core/src/ui/v3/NativeProOfferCard.svelte";
  import RestoreStatusCard from "../../../packages/core/src/ui/v3/RestoreStatusCard.svelte";
  import AccountLinkCard from "../../../packages/core/src/ui/v3/AccountLinkCard.svelte";
  import PopupInvitation from "../../../packages/core/src/ui/v3/PopupInvitation.svelte";
  import Toggle from "../../../packages/core/src/ui/v3/Toggle.svelte";
  import StatusLine from "../../../apps/owner-admin/src/StatusLine.svelte";
  import type { PopupInvitationPresentation } from "../../../packages/core/src/ui/v3/invitation-presentation.js";
  import "../../../packages/core/src/ui/v3/design/styles.css";
  import { SERVICE_IDS } from "@still/shared-types";
  import { rowsFor } from "../../../packages/core/src/ui/v3/presentation.js";
  import { noop } from "./fixtures.js";

  let {
    kind,
    withdrawal = "none",
    offerState = "idle",
    signedIn = false,
    channel = "ready",
    scale = 1,
    showControls = false,
  }: {
    kind:
      | "access"
      | "consent"
      | "withdrawal"
      | "offer"
      | "native-offer"
      | "checking"
      | "restore"
      | "link"
      | "invitations"
      | "focus"
      | "large-text"
      | "long-text";
    withdrawal?: "none" | "requested" | "verifying" | "deleted" | "failed";
    offerState?: "idle" | "pending" | "failed";
    signedIn?: boolean;
    channel?: "ready" | "unverified";
    scale?: number;
    showControls?: boolean;
  } = $props();

  const purposes = [
    {
      name: "Email",
      text: "[Approved purpose text: how your email is used with your usage data]",
    },
    {
      name: "Usage analytics",
      text: "[Provider]: which settings are used, so they can be improved.",
    },
    { name: "AI processing", text: "[Provider]: [approved purpose text]" },
  ];
  const offer = {
    price: "$9.99",
    priceNote: "One payment. Access forever. No subscription",
  };
  // Gallery16 declares every current extra supported. This is a static design specimen,
  // never an inferred production capability or a purchase observation.
  const siteNames = {
    youtube: "YouTube",
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
  };
  const proControls = SERVICE_IDS.flatMap((service) => rowsFor(service))
    .filter((row) => row.tier === "pro")
    .map((row) => ({ site: siteNames[row.service], label: row.label }));
  const restoreStates = [
    "checking",
    "restored",
    "nothing",
    "failed",
    "verify",
  ] as const;
  const rows: {
    id: FeatureId;
    label: string;
    state: AccessState;
    checked: boolean;
    inactive?: boolean;
    note?: string;
    host?: "browser" | "safari";
  }[] = [
    { id: "youtube.shorts", label: "Shorts", state: "free", checked: true },
    {
      id: "facebook.reels",
      label: "[Control that was free in an earlier release]",
      note: "Protected: usable, no tag.",
      state: "protected",
      checked: true,
    },
    {
      id: "youtube.related",
      label: "Related videos",
      state: "purchased",
      checked: true,
    },
    {
      id: "instagram.stories",
      label: "Stories and Highlights",
      state: "checking",
      checked: true,
    },
    {
      id: "instagram.suggested",
      label: "Suggested accounts",
      state: "verification_required",
      checked: false,
    },
    {
      id: "youtube.livechat",
      label: "Live chat",
      state: "locked",
      checked: false,
    },
    {
      id: "facebook.videos",
      label: "Live chat",
      state: "locked",
      checked: false,
      host: "safari",
    },
    {
      id: "instagram.explore",
      label: "Explore recommendations",
      state: "unsupported",
      checked: true,
      host: "safari",
    },
    {
      id: "youtube.endscreen",
      label: "End-of-video suggestions",
      state: "purchased",
      checked: true,
      inactive: true,
    },
  ];
  function invitation(kind: "sync" | "rating"): PopupInvitationPresentation {
    const identity = {
      installation: "specimen-installation",
      opening: `specimen-${kind}`,
      surface: "chrome" as const,
    };
    const port = {
      identity: { ...identity },
      verified: true,
      status: "ready" as const,
      request: noop,
    };
    return {
      kind,
      identity,
      verified: true,
      fresh: true,
      status: "ready",
      ordinaryOpening: true,
      rating: {
        allowance: { verified: true, fresh: true, global: true, surface: true },
        eligibility: {
          verified: true,
          ageDays: 7,
          distinctUseDays: 3,
          laterOpening: true,
        },
        display: {
          verified: true,
          fresh: true,
          status: "admitted",
          receiptId: "specimen-admission",
          identity: { ...identity },
        },
      },
      accept: port,
      dismiss: { ...port, identity: { ...identity } },
    };
  }
</script>

<div style={`--text-scale:${scale}`}>
  {#if kind === "access"}
    <div class="service-group" style="margin:12px">
      <div
        class="list"
        style="display:flex;flex-direction:column;padding:0 16px 4px"
      >
        {#each rows as row (row.id)}
          <FeatureRow
            {...row}
            inactive={row.inactive ?? false}
            unsupportedText={`Not available in ${row.host === "safari" ? "Safari" : "this browser"}. Your choice is saved.`}
            onChange={noop}
            onLock={noop}
          />
        {/each}
      </div>
    </div>
  {:else if kind === "consent"}
    <div style="padding:12px;display:grid;gap:12px">
      <SharingCard
        state="unasked"
        {purposes}
        purposesVerified
        onShare={noop}
        onDecline={noop}
      />
    </div>
  {:else if kind === "withdrawal"}
    <div style="padding:12px">
      <SharingCard state="off" {withdrawal} onChange={noop} onRetry={noop} />
    </div>
  {:else if kind === "offer" || kind === "checking"}
    <div style="padding:12px">
      <ProOfferCard
        controls={showControls ? proControls : []}
        ownership={kind === "checking" ? "checking" : "none"}
        {channel}
        {offer}
        knownMissing
        confirmedAccount={signedIn}
        state={offerState}
        onSignIn={noop}
        onBuy={noop}
        onRestore={noop}
        onRetry={noop}
      />
    </div>
  {:else if kind === "native-offer"}
    <div style="padding:12px">
      <NativeProOfferCard
        ownership="none"
        channel="ready"
        {offer}
        state="pending"
        onBuy={noop}
        onRestore={noop}
      />
    </div>
  {:else if kind === "restore"}
    <div style="padding:16px;display:grid;gap:14px">
      {#each restoreStates as state (state)}
        <RestoreStatusCard {state} onAction={noop} />
      {/each}
    </div>
  {:else if kind === "link"}
    <div style="padding:12px;display:grid;gap:12px">
      <AccountLinkCard
        state="confirm"
        email="sam@example.com"
        onConfirm={noop}
        onChooseOther={noop}
      />
      <AccountLinkCard state="failed" email="sam@example.com" onRetry={noop} />
    </div>
  {:else if kind === "invitations"}
    <div style="padding:12px;display:grid;gap:12px">
      <PopupInvitation presentation={invitation("sync")} />
      <PopupInvitation presentation={invitation("rating")} />
    </div>
  {:else if kind === "focus"}
    <div class="gallery-focus" style="padding:16px;display:grid;gap:16px">
      <div style="display:flex;gap:20px;align-items:center">
        <Toggle checked label="Focus" onChange={noop} />
        <button type="button" class="secondary" onclick={noop}
          >Don't share</button
        >
        <button type="button" class="link" onclick={noop}
          >Restore purchase</button
        >
      </div>
      <div class="hero">
        <div class="hero-text">
          <h1 style="font-size:18px;margin:0">Still is active</h1>
        </div>
        <Toggle checked onBlue label="Still" onChange={noop} />
      </div>
    </div>
  {:else if kind === "large-text"}
    <div class="service-group" style="margin:8px">
      <div style="padding:0 10px">
        <FeatureRow
          id="youtube.endscreen"
          label="End-of-video suggestions"
          state="purchased"
          checked
          inactive={false}
          unsupportedText=""
          onChange={noop}
        />
        <FeatureRow
          id="youtube.livechat"
          label="Live chat"
          state="locked"
          checked={false}
          inactive={false}
          unsupportedText=""
          onChange={noop}
          onLock={noop}
        />
      </div>
    </div>
  {:else if kind === "long-text"}
    <div style="padding:12px;display:grid;gap:12px">
      <div class="service-group">
        <div style="padding:0 16px">
          <FeatureRow
            id="youtube.endscreen"
            label="Vorschläge am Ende des Videos"
            note="Wiederholen und die Player-Steuerung bleiben erhalten."
            state="purchased"
            checked
            inactive={false}
            unsupportedText=""
            onChange={noop}
          />
        </div>
      </div>
      <StatusLine
        tone="failed"
        actionLabel="Erneut versuchen"
        onAction={noop}
        text="Die Überprüfung konnte nicht abgeschlossen werden. Es hat sich nichts geändert."
      />
    </div>
  {/if}
</div>
