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

  let { presentation }: { presentation?: PopupInvitationPresentation } =
    $props();
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
      "Rate Still",
      "A rating helps other people find Still.",
      "Rate Still",
    ],
    sync: [
      "Use the same settings in every browser",
      "Sign in for free settings sync. Optional.",
      "Sign in",
    ],
    link: [
      "Link Still Pro to an account",
      "So you can restore it in other browsers. Optional.",
      "Link",
    ],
  } as const;
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
    <section class="card card-stack" aria-label={copy[presentation.kind][0]}>
      <div class="sync-row-text">
        <h2 class="sync-row-title">{copy[presentation.kind][0]}</h2>
        <p class="muted sync-row-sub">{copy[presentation.kind][1]}</p>
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
