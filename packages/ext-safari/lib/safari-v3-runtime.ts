import { ChromeStorageAdapter, SettingsCache, type StoredSettingsRecord } from "@still/core/storage";
import {
  createExtensionUiController,
  type CommittedPopupBinding,
  type CommittedPopupToggle,
  type UiController,
} from "@still/core/ui";
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
// No legacy `set` is sent: onLocalSettingsCommit is deliberately not passed here.

export interface SafariV3Composition {
  readonly controller: UiController;
  readonly binding: CommittedPopupBinding;
  /** Existing usage events for a really committed switch; nothing for a refused or failed one. */
  report(toggle: CommittedPopupToggle): void;
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
 * The V3 composition, or null when this page must keep today's legacy screen: the build did not
 * opt in, or the saved record is not the Apple app's atomic record.
 */
export async function composeSafariV3(
  where: "popup" | "options",
  env: SafariV3BuildInput,
  probe: () => Promise<StoredSettingsRecord | null> = probeSavedRecord,
): Promise<SafariV3Composition | null> {
  if (!selectSafariV3Build(env)) return null;
  if (!savedRecordIsAtomic(await probe())) return null;
  // Same nudge as the legacy page: the background pulls the app's record and access into storage.
  void browser.runtime.sendMessage({ kind: "reconcile" }).catch(() => {});
  const analytics = createSafariPageAnalytics();
  let binding: CommittedPopupBinding | undefined;
  const controller = createExtensionUiController(undefined, {
    accountManagedByApp: true,
    readAccountStatus,
    analytics,
    openedWhere: where,
    onCommittedPopupBinding: (handoff) => {
      binding = handoff;
    },
  });
  return {
    controller,
    binding: binding!,
    report({ service, enabled }) {
      if (service === undefined) analytics.track("global_toggled", { enabled, where });
      else analytics.track("service_toggled", { service, enabled, where });
    },
  };
}
