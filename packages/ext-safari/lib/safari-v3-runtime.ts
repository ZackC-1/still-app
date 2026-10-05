import { ChromeStorageAdapter, SettingsCache, type StoredSettingsRecord } from "@still/core/storage";
import { ChromeEntitlementAdapter, EntitlementCache } from "@still/core/entitlement";
import { UiController, type CommittedPopupBinding, type CommittedPopupToggle } from "@still/core/ui";
import { watchAccountStatus } from "../../core/src/ui/account-status.js";
import { createDesktopPopupBinding } from "../../core/src/ui/v3/desktop-popup-binding.js";
import { readAccountStatus } from "./account-status.js";
import { createSafariPageAnalytics } from "./analytics.js";
import { savedRecordIsAtomic, selectSafariV3Build, type SafariV3BuildInput } from "./safari-v3.js";

// Composition for the Safari V3 popup and settings page. Reached only from the entrypoints'
// dynamic import, which default builds fold away (see entrypoints/popup/main.ts).
//
// Authority: the ordinary extension-page settings cache. On a Safari extension page it reads the
// App Group record through the app's native handler and saves each deliberate switch as ONE native
// settings intent (ChromeStorageAdapter.commitIntent → SharedSettingsStore.commitIntent), then
// mirrors the committed record into browser.storage so the content scripts keep blocking with it.
// No legacy `set` is sent.
//
// This is the Safari subset of createExtensionUiController (no purchase injection, the app owns the
// account), composed here rather than through that factory for one reason: every watcher it starts
// is returned in `stop()`, so a failed mount can hand the page to the legacy screen with nothing
// left running twice. `opened` is reported only once the V3 screen has really mounted.

export interface SafariV3Composition {
  readonly controller: UiController;
  readonly binding: CommittedPopupBinding;
  /** Existing usage events for a really committed switch; nothing for a refused or failed one. */
  report(toggle: CommittedPopupToggle): void;
  /** The existing `opened` event, sent by the caller after a successful mount. */
  opened(): void;
  /** Resolves once the first settings read settled, either way. Until then a hold is "checking". */
  readonly settled: Promise<void>;
  /** Stop the binding, account polling, entitlement and settings watchers. Idempotent. */
  stop(): void;
}

/**
 * One read-only look at the saved record: a native `get` (or, with the app unreachable, the copy
 * already in browser storage). It never initializes, converts or writes anything, and it never
 * starts watching, so there is nothing to tear down.
 */
export async function probeSavedRecord(): Promise<StoredSettingsRecord> {
  const probe = new SettingsCache(new ChromeStorageAdapter());
  await probe.hydrate().catch(() => {
    /* A failed read with no retained copy leaves no atomic record: the caller keeps legacy. */
  });
  return probe.currentRecord();
}

/**
 * Whether this page shows V3: the build opted in and the saved record is the Apple app's atomic
 * record. Side-effect free apart from the probe's single read.
 */
export async function decideSafariV3(
  env: SafariV3BuildInput,
  probe: () => Promise<StoredSettingsRecord | null> = probeSavedRecord,
): Promise<boolean> {
  return selectSafariV3Build(env) && savedRecordIsAtomic(await probe());
}

/** Build the V3 composition. Call only after decideSafariV3 said yes. */
export function composeSafariV3(where: "popup" | "options"): SafariV3Composition {
  // Same nudge as the legacy page: the background pulls the app's record and access into storage.
  void browser.runtime.sendMessage({ kind: "reconcile" }).catch(() => {});
  const analytics = createSafariPageAnalytics();
  const cache = new SettingsCache(new ChromeStorageAdapter());
  // A failed first read is a held state the screen shows and can retry; never unhandled.
  const settled = cache.hydrate().then(
    () => {},
    () => {},
  );
  const unwatchSettings = cache.watch();
  const controller = new UiController({
    cache,
    host: { canPurchase: false },
    analytics,
    where,
  });
  controller.accountManagedByApp = true;
  const entitlement = new EntitlementCache(new ChromeEntitlementAdapter());
  let live = true;
  const unsubscribeEntitlement = entitlement.subscribe((entitled) => {
    controller.entitled = entitled;
  });
  void entitlement.hydrate().then((entitled) => {
    if (live) controller.entitled = entitled;
  });
  const unwatchEntitlement = entitlement.watch();
  const stopAccount = watchAccountStatus(controller, () => readAccountStatus(cache.currentRecord()));
  const binding = createDesktopPopupBinding(cache, entitlement);
  return {
    controller,
    binding,
    report({ service, enabled }) {
      if (service === undefined) analytics.track("global_toggled", { enabled, where });
      else analytics.track("service_toggled", { service, enabled, where });
    },
    opened() {
      analytics.track("opened", { where });
    },
    settled,
    stop() {
      if (!live) return;
      live = false;
      binding.stop();
      stopAccount();
      unwatchEntitlement();
      unsubscribeEntitlement();
      unwatchSettings();
    },
  };
}
