<script lang="ts">
  // The V3 desktop popup plus its one optional card: the sync invitation (U13-P2) or the rating
  // card (U13-P3), whichever the background's ledger picked for this opening. It reserves and
  // commits the card through the background before anything renders, and adds nothing else.
  import { onMount } from "svelte";
  import DesktopPopup from "@still/core/ui/v3/DesktopPopup.svelte";
  import type { DesktopPopupProps } from "@still/core/ui/v3/presentation";
  import {
    presentInvitation,
    syncInvitationPresentation,
  } from "@still/core/ui/v3/popup-invitation-flow";
  import { popupInvitationHost } from "../../lib/invitation-popup-host.js";
  import { openRatingReview, ratingCardPresentation } from "../../lib/rating-card.js";
  import { useSiteAccessCard } from "../../lib/site-access-card.svelte.js";

  let props: DesktopPopupProps = $props();
  // ISS-0037: warn at the top when the browser withholds Still's four sites, with Allow.
  const siteAccess = useSiteAccessCard();
  const host = popupInvitationHost();
  let shown = $state.raw<{
    installation: string;
    kind: "sync" | "rating";
    generation: number;
  } | null>(null);
  let closed = $state(false);

  onMount(() => {
    if (!host || host.started) return;
    host.started = true;
    // The popup hides the card during its own setup state or a pending, failed or cautioned
    // account state. Say so up front, so nothing is reserved or consumed unseen.
    // The same conditions DesktopPopup uses to hide the card, read now and again right before
    // the commit (an account status can arrive while the background decides). The site access
    // card (ISS-0037) also holds it: no rating or sync ask while Still cannot work, or just after
    // access came back. Nothing is asked until the browser has answered the access question, so
    // the one card is never committed and then left beside the warning.
    const holdNow = (): "setup" | "error" | undefined => {
      const tone = props.account?.status?.tone;
      return props.desktopSetup || siteAccess.current
        ? "setup"
        : tone === "pending" || tone === "failed" || tone === "caution"
          ? "error"
          : undefined;
    };
    void siteAccess.settled.then(() => presentInvitation(
      host.port,
      host.opening,
      (reserved) => {
        const kind = reserved.reservation.kind;
        if (kind === "sync" || kind === "rating")
          shown = {
            installation: reserved.installation,
            kind,
            generation: reserved.reservation.generation,
          };
      },
      holdNow(),
      () => holdNow() === undefined,
    ));
  });

  // Someone signed in meanwhile (another window, a code entered here): the sync card has no
  // purpose. The rating card is already spent and stays until either button closes it.
  const invitation = $derived(
    host && shown?.kind === "rating"
      ? ratingCardPresentation({
          installation: shown.installation,
          opening: host.opening,
          surface: host.surface,
          generation: shown.generation,
          closed,
          onRate: () => {
            closed = true;
            openRatingReview(host.surface);
          },
          onNotNow: () => {
            closed = true;
          },
        })
      : host && shown?.kind === "sync" && !host.controller.userId
      ? syncInvitationPresentation({
          installation: shown.installation,
          opening: host.opening,
          surface: host.surface,
          closed,
          onSignIn: () => {
            closed = true;
            host.controller.openSignIn();
          },
          onNotNow: () => {
            closed = true;
          },
        })
      : undefined,
  );
</script>

<DesktopPopup
  {...props}
  {invitation}
  invitationVariant="d28"
  siteAccess={siteAccess.current}
/>
