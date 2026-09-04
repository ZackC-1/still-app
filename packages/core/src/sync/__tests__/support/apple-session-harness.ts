import { vi } from "vitest";
import { SettingsCache } from "../../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../../storage/adapter.js";
import { UiController } from "../../../ui/controller.svelte.js";
import {
  createAppleSession,
  type AppleSessionBridge,
  type AppleSessionDeps,
} from "../../apple-session.js";
import type { SyncState } from "../../service.js";

// The Apple session harness, shared by the suite that runs against the switch as shipped and the
// one that runs the money flows with the switch mocked on. One harness so the two cannot drift.

export function makeBridge(over: Partial<AppleSessionBridge> = {}): AppleSessionBridge {
  return {
    available: true,
    signInWithApple: vi.fn(async () => ({ identityToken: "tok", nonce: "n" })),
    configurePurchases: vi.fn(async () => {}),
    purchaseStillPro: vi.fn(async () => ({ outcome: "purchased" as const, entitled: true })),
    restore: vi.fn(async () => false),
    receiptStatus: vi.fn(async () => "noSignal" as const),
    attachPurchases: vi.fn(async () => false),
    price: vi.fn(async () => "$1.99"),
    signOut: vi.fn(async () => {}),
    setEntitlement: vi.fn(async () => {}),
    ...over,
  };
}

export function harness(opts: {
  bridge?: Partial<AppleSessionBridge>;
  /** What the (fake) reconcile lands in the controller when enterSession runs. */
  onSignedInState?: Partial<SyncState>;
  exchange?: AppleSessionDeps["exchangeAppleCredential"];
} = {}) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
  const controller = new UiController({ cache, host: { canPurchase: true } });
  const bridge = makeBridge(opts.bridge);
  // A fake SyncService: onSignedIn projects the configured post-reconcile state through the same
  // onSyncState path the real service drives.
  const sync = {
    onSignedIn: vi.fn(async (userId: string) => {
      session.onSyncState({
        userId,
        entitled: false,
        syncing: false,
        cloudReachable: true,
        confirmed: true,
        ...opts.onSignedInState,
      });
    }),
    signOut: vi.fn(async () => {
      session.onSyncState({ userId: null, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
    }),
    deleteAccount: vi.fn(async () => {}),
  };
  const session = createAppleSession({
    controller,
    sync,
    bridge,
    exchangeAppleCredential: opts.exchange ?? (async () => ({ userId: "u1" })),
  });
  return { session, controller, bridge, sync };
}
