import type { NativeBridge } from "../../native/bridge.js";

// still://sync in the Apple app (StillKit StillAppRoute): the Safari popup's Sign in hands off here.
// It lands on Settings with the Settings sync card in view and, when signed out, opens the existing
// sign-in sheet over it. Signed in, the card shows the account's sync status; nothing else opens.
// still://pro is the Still Pro host's route (apple-pro-host); each handler leaves the other's
// destination pending. Sign-in stays optional and free: nothing here touches blocking or Pro.

export interface AppleSyncRouteDeps {
  readonly bridge: Pick<NativeBridge, "pendingAppRoute" | "acknowledgeAppRoute">;
  /** Leaves any open Still Pro screen so Settings, and its sync card, shows. */
  readonly showSettings: () => void;
  /** Whether the sign-in sheet can open now (signed out, as the sheet itself requires). */
  readonly canSignIn: () => boolean;
  readonly openSignIn: () => void;
  /** Brings the sync card into view once Settings renders; `focus` is false under the sheet. */
  readonly reveal: (focus: boolean) => void;
}

export interface AppleSyncRoute {
  route(): Promise<void>;
  stop(): void;
}

export function createAppleSyncRoute(deps: AppleSyncRouteDeps): AppleSyncRoute {
  let stopped = false;
  return {
    async route() {
      const route = await deps.bridge.pendingAppRoute();
      if (stopped || !route || route.route !== "sync") return;
      deps.showSettings();
      const signingIn = deps.canSignIn();
      if (signingIn) deps.openSignIn();
      deps.reveal(!signingIn);
      // Acknowledge only after this screen took the represented destination.
      await deps.bridge.acknowledgeAppRoute(route.revision);
    },
    stop() {
      stopped = true;
    },
  };
}

/**
 * Scrolls the rendered Settings sync card into view: the first card whose heading ends in "sync"
 * ("Settings sync", or "Still Pro and sync" once purchased). Returns whether one was found; a
 * missing card leaves the screen as it is.
 */
export function revealAppleSyncCard(root: ParentNode, focus: boolean): boolean {
  const card = Array.from(root.querySelectorAll<HTMLElement>("section.card")).find((section) =>
    /\bsync$/i.test(section.querySelector("h2")?.textContent?.trim() ?? ""),
  );
  if (!card) return false;
  card.scrollIntoView?.({ block: "center" });
  if (focus) {
    card.setAttribute("tabindex", "-1");
    card.focus({ preventScroll: true });
  }
  return true;
}
