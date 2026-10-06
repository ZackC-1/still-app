// QA-ONLY. Never import this from product code (guarded by tests/qa/webkit/guard.spec.ts).
//
// Named recorded states for the WebKit lane. A state says what the native side holds and answers;
// it never says what a screen should show. Screens get there through their own code, plus real
// clicks and key presses where a frame needs them (see tests/visual/real/webkit/cases.mjs).
import type { AccountSyncStatus } from "../../../../packages/core/src/sync/account-status.js";
import type { SettingsField } from "../../../../packages/shared-types/src/index.js";

export interface QaState {
  readonly name: string;
  /** Which page code reads: the extension's platform (getPlatformInfo().os) or the app host. */
  readonly platform: "ios" | "mac";
  /** Device class the app reports in analyticsContext. */
  readonly device: "phone" | "tablet" | "desktop";
  /**
   * The App Group settings record:
   *  - "atomic": the Apple app's atomic-mode record (unknown ownership), plus `edits`;
   *  - "legacy": a 2.1.x record the app never converted (the extension keeps its legacy screen);
   *  - "empty": nothing saved.
   */
  readonly appGroup: "atomic" | "legacy" | "empty";
  /** Deliberate edits committed in order through the native writer before the page opens. */
  readonly edits: readonly (readonly [SettingsField, boolean])[];
  /** "absent": every native message rejects (the extension outside the app, or no host). */
  readonly native: "present" | "absent";
  /** What the app wrote for the extension to display. Null: signed out. */
  readonly accountSyncStatus: AccountSyncStatus | null;
  /** OnboardingGate's web reply. */
  readonly onboarding: { readonly shouldShow: boolean; readonly osMajorVersion: number };
  /** SafariExtensionBridge.currentStatus on macOS (iOS cannot know: always "unknown"). */
  readonly macExtension: "enabled" | "disabled" | "unknown";
  /** FreePeriodRestoreResult for a Restore tap; "pending" never answers. */
  readonly restore: "restored" | "none" | "failed" | "pending";
}

const BASE: QaState = {
  name: "base",
  platform: "ios",
  device: "phone",
  appGroup: "atomic",
  edits: [],
  native: "present",
  accountSyncStatus: null,
  onboarding: { shouldShow: false, osMajorVersion: 26 },
  macExtension: "unknown",
  restore: "none",
};

export function qaState(overrides: Partial<QaState> & { name: string }): QaState {
  return { ...BASE, ...overrides };
}

/** Recorded states the runner and the specs use, by name. */
export const STATES = {
  /** Safari popup / settings on iPhone or iPad: the app's atomic record, nothing edited. */
  "ios-fresh": qaState({ name: "ios-fresh" }),
  "ipad-fresh": qaState({ name: "ipad-fresh", device: "tablet" }),
  /** Safari on macOS: the same record, read by the desktop popup. */
  "mac-fresh": qaState({ name: "mac-fresh", platform: "mac", device: "desktop", macExtension: "enabled" }),
  /** Still turned off on purpose; every service choice kept. */
  "mac-still-off": qaState({ name: "mac-still-off", platform: "mac", device: "desktop", macExtension: "enabled", edits: [["globalOn", false]] }),
  "ios-still-off": qaState({ name: "ios-still-off", edits: [["globalOn", false]] }),
  /** The Apple app on iPhone, onboarding already done. Restore answers per state. */
  "app-iphone": qaState({ name: "app-iphone" }),
  "app-iphone-restore-none": qaState({ name: "app-iphone-restore-none", restore: "none" }),
  "app-iphone-restore-restored": qaState({ name: "app-iphone-restore-restored", restore: "restored" }),
  "app-iphone-restore-pending": qaState({ name: "app-iphone-restore-pending", restore: "pending" }),
  "app-ipad-restore-failed": qaState({ name: "app-ipad-restore-failed", device: "tablet", restore: "failed" }),
  "app-mac": qaState({ name: "app-mac", platform: "mac", device: "desktop", macExtension: "enabled" }),
  /** The Apple app's first launch with web onboarding: the gate says show. */
  "app-iphone-onboarding": qaState({ name: "app-iphone-onboarding", onboarding: { shouldShow: true, osMajorVersion: 26 } }),
  "app-ipad-onboarding": qaState({ name: "app-ipad-onboarding", device: "tablet", onboarding: { shouldShow: true, osMajorVersion: 26 } }),
  "app-mac-onboarding-off": qaState({ name: "app-mac-onboarding-off", platform: "mac", device: "desktop", macExtension: "disabled", onboarding: { shouldShow: true, osMajorVersion: 26 } }),
  "app-mac-onboarding-on": qaState({ name: "app-mac-onboarding-on", platform: "mac", device: "desktop", macExtension: "enabled", onboarding: { shouldShow: true, osMajorVersion: 26 } }),
} as const satisfies Record<string, QaState>;

export type StateName = keyof typeof STATES;
