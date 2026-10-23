<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    invitationVisible,
    invitationPortReady,
    sameInvitationIdentity,
    type PopupInvitationPresentation,
    type InvitationIntentPort,
  } from "./invitation-presentation.js";
  import "./design/styles.css";

  let { presentation }: {
    presentation?: PopupInvitationPresentation;
  } = $props();
  // A local current-request fence; caller observations alone control visibility.
  let current = $derived(
    invitationVisible(presentation)
      ? {
          observation: presentation,
          accept: presentation.accept,
          dismiss: presentation.dismiss,
          acceptRequest: presentation.accept?.request,
          dismissRequest: presentation.dismiss?.request,
        }
      : undefined,
  );
  // Retain every issued choice for this mounted component, including while its
  // chosen port is unavailable. Caller publication cannot erase an earlier claim.
  let requested = $state.raw<
    {
      kind: PopupInvitationPresentation["kind"];
      identity: PopupInvitationPresentation["identity"];
      admission: string | undefined;
      which: "accept" | "dismiss";
      request: () => void;
    }[]
  >([]);
  function choiceClaimed(observation: PopupInvitationPresentation) {
    return Boolean(
      requested.some(
        (claim) =>
          claim.kind === observation.kind &&
          sameInvitationIdentity(claim.identity, observation.identity) &&
          claim.admission ===
            (observation.kind === "rating"
              ? observation.rating?.display.receiptId
              : undefined) &&
          (!invitationPortReady(observation, observation[claim.which]) ||
            claim.request === observation[claim.which]?.request),
      ),
    );
  }
  let mounted = true;
  onDestroy(() => {
    mounted = false;
  });
  const copy = {
    rating: [
      "Enjoying Still?",
      "A rating helps other people find Still.",
      "Rate Still",
    ],
    // The sync invitation reads as the popups' Settings sync card (owner, 21 Oct 2026).
    sync: [
      "Settings sync",
      "Sync settings across devices and browsers. Free.",
      "Sign in",
    ],
    link: [
      "Link Still Pro to your account",
      "So you can restore it in other browsers. Optional.",
      "Link",
    ],
  } as const;
  let title = $derived(presentation ? copy[presentation.kind][0] : "");
  let detail = $derived(presentation ? copy[presentation.kind][1] : "");
  function intent(
    observation: PopupInvitationPresentation,
    port: InvitationIntentPort | undefined,
    which: "accept" | "dismiss",
  ) {
    const scope = current;
    const identity = { ...observation.identity };
    const kind = observation.kind;
    const request = port?.request;
    return () => {
      if (
        !mounted ||
        !scope ||
        current !== scope ||
        choiceClaimed(observation) ||
        presentation !== observation ||
        presentation.kind !== kind ||
        !sameInvitationIdentity(identity, presentation.identity) ||
        !invitationVisible(presentation) ||
        presentation[which] !== port ||
        port?.request !== request ||
        !invitationPortReady(presentation, port)
      )
        return;
      requested = [
        ...requested,
        {
          kind,
          identity,
          admission:
            kind === "rating"
              ? observation.rating?.display.receiptId
              : undefined,
          which,
          request: port.request,
        },
      ];
      request?.();
    };
  }
</script>

{#if invitationVisible(presentation)}
  {#key current}
    <section class="card card-stack" aria-label={title}>
      <div class="sync-row-text">
        <h2 class="sync-row-title">{title}</h2>
        <p class="muted sync-row-sub">{detail}</p>
      </div>
      <div class="inline-actions">
        <button
          type="button"
          class="primary inline"
          aria-disabled={choiceClaimed(presentation) ||
            !invitationPortReady(presentation, presentation.accept) ||
            undefined}
          onclick={intent(presentation, presentation.accept, "accept")}
          >{copy[presentation.kind][2]}</button
        >
        <button
          type="button"
          class="link"
          aria-disabled={choiceClaimed(presentation) ||
            !invitationPortReady(presentation, presentation.dismiss) ||
            undefined}
          onclick={intent(presentation, presentation.dismiss, "dismiss")}
          >Not now</button
        >
      </div>
    </section>
  {/key}
{/if}

<style>
  /* The owner's canvas (Chrome-Popup-Invite and Chrome-Popup-Rating, 21 Oct 2026): 10px between
     the text and the buttons, the detail at 1.4 line height, the main button 14px from its label
     on each side, 16px between the two buttons and "Not now" at 14px. */
  section.card-stack {
    gap: 10px;
  }
  .sync-row-sub {
    line-height: 1.4;
  }
  .inline-actions {
    column-gap: var(--space-4);
  }
  .inline-actions > .primary.inline {
    padding-inline: 14px;
  }
  .inline-actions > .link {
    font-size: calc(14px * var(--text-scale, 1));
    line-height: normal;
  }
</style>
