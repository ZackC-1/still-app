<script lang="ts">
  // The V3 desktop popup plus the optional sync invitation card (U13-P2). It reserves and commits
  // the card through the background before anything renders, and adds nothing else to the popup.
  import { onMount } from "svelte";
  import DesktopPopup from "../../../core/src/ui/v3/DesktopPopup.svelte";
  import type { DesktopPopupProps } from "../../../core/src/ui/v3/presentation.js";
  import {
    presentInvitation,
    syncInvitationPresentation,
  } from "../../../core/src/ui/v3/popup-invitation-flow.js";
  import { popupInvitationHost } from "../../lib/invitation-popup-host.js";

  let props: DesktopPopupProps = $props();
  const host = popupInvitationHost();
  let shown = $state.raw<{ installation: string } | null>(null);
  let closed = $state(false);

  onMount(() => {
    if (!host || host.started) return;
    host.started = true;
    void presentInvitation(host.port, host.opening, (reserved) => {
      shown = { installation: reserved.installation };
    });
  });

  // Someone signed in meanwhile (another window, a code entered here): the card has no purpose.
  const invitation = $derived(
    host && shown && !host.controller.userId
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

<DesktopPopup {...props} {invitation} invitationVariant="d28" />
