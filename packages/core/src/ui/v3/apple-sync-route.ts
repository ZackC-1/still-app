import type { NativeAppRoute, NativeBridge } from "../../native/bridge.js";

// still://sync in the Apple app (StillKit StillAppRoute): the Safari popup's Sign in hands off here.
// It lands on Settings with the Settings sync card in view and, when signed out, opens the existing
// sign-in sheet over it. Signed in, the card shows the account's sync status; nothing else opens.
// still://pro belongs to the Still Pro host (apple-pro-host). createAppleAppRoutes reads the pending
// route once per app notification and hands it to the one handler it names. Sign-in stays
// optional and free: nothing here touches blocking or Pro.

type RouteBridge = Pick<NativeBridge, "pendingAppRoute" | "acknowledgeAppRoute">;

/** How long a route waits for the launch's account resume before deciding signed in or out. */
export const SYNC_ROUTE_ACCOUNT_WAIT_MS = 3_000;

export interface AppleSyncRouteDeps {
  readonly bridge: RouteBridge;
  /** Leaves any open Still Pro screen so Settings, and its sync card, shows. */
  readonly showSettings: () => void;
  /**
   * Settles once this launch knows whether an account is signed in (the session resume). A cold
   * launch from the link must not read "signed out" before the saved session is restored. Waited
   * for at most SYNC_ROUTE_ACCOUNT_WAIT_MS; absent, the current state is used.
   */
  readonly accountSettled?: () => Promise<unknown>;
  /** Whether the sign-in sheet can open now: this build can sign in, and nobody is signed in. */
  readonly canSignIn: () => boolean;
  readonly openSignIn: () => void;
  /** Brings the sync card into view once Settings renders; `focus` is false under the sheet. */
  readonly reveal: (focus: boolean) => void;
  /** Injectable timer for the bounded account wait. */
  readonly wait?: (ms: number) => Promise<void>;
}

export interface AppleSyncRoute {
  /** `pending` is the route the app router already read; without it this reads it itself. */
  route(pending?: NativeAppRoute): Promise<void>;
  stop(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAppleSyncRoute(deps: AppleSyncRouteDeps): AppleSyncRoute {
  let stopped = false;
  const wait = deps.wait ?? sleep;
  return {
    async route(pending) {
      const route = pending ?? (await deps.bridge.pendingAppRoute());
      if (stopped || !route || route.route !== "sync") return;
      if (deps.accountSettled)
        await Promise.race([
          deps.accountSettled().catch(() => undefined),
          wait(SYNC_ROUTE_ACCOUNT_WAIT_MS),
        ]);
      if (stopped) return;
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

export interface AppleAppRoutesDeps {
  readonly bridge: RouteBridge;
  /** The Still Pro host; absent (paid tier off), still://pro stays pending as before. */
  readonly pro?: { route(pending: NativeAppRoute): Promise<void> };
  readonly sync: AppleSyncRoute;
}

/**
 * One reader for the app's pending route: each `still:route` notification reads it once and hands
 * it to the handler it names, so a Pro and a sync request can never be answered out of order by two
 * separate reads. A notification that arrives while a read is in flight runs one more pass after it.
 */
export function createAppleAppRoutes(deps: AppleAppRoutesDeps): { route(): Promise<void>; stop(): void } {
  let stopped = false;
  let running: Promise<void> | undefined;
  let again = false;
  async function pass(): Promise<void> {
    do {
      again = false;
      const pending = await deps.bridge.pendingAppRoute();
      if (stopped || !pending) continue;
      if (pending.route === "pro") await deps.pro?.route(pending);
      else await deps.sync.route(pending);
    } while (again && !stopped);
  }
  return {
    route() {
      if (stopped) return Promise.resolve();
      if (running) {
        again = true;
        return running;
      }
      running = pass().finally(() => {
        running = undefined;
      });
      return running;
    },
    stop() {
      stopped = true;
      deps.sync.stop();
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

/**
 * revealAppleSyncCard, retried while Settings is still loading (a cold launch from the link renders
 * Settings only once the saved choices are read). Gives up quietly after `attempts` tries.
 */
export async function revealAppleSyncCardWhenRendered(
  root: ParentNode,
  focus: boolean,
  options: { attempts?: number; intervalMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 30;
  const wait = options.wait ?? sleep;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (revealAppleSyncCard(root, focus)) return true;
    await wait(options.intervalMs ?? 100);
  }
  return false;
}
