// QA-ONLY. Never import this from product code (guarded by tests/qa/webkit/guard.spec.ts).
//
// The Node side of the WebKit lane's recorded-state boundary shim: the one App Group the Safari
// extension pages and the Apple app's web view both talk to, answered the way the native hosts
// answer them. Every reply envelope below is copied from the Swift host that produces it:
//
//   Safari extension page, browser.runtime.sendNativeMessage → SafariWebExtensionHandler.swift
//     { settings: "<record json>" | "" | "{\"status\":\"unavailable\"}" }   (SettingsBridge.handle)
//     { settings: "<{record,changed,status} json>" } for settingsIntent        (SettingsBridge.handle)
//     { accountSyncStatus: "<json>" | null }                                   (AccountSyncStatus.readReply)
//   Safari extension page, browser.runtime.sendMessage → the extension background's own routers
//     (createSettingsIntentRouter, createEntitlementMessageRouter, the reconcile nudge).
//   Apple app web view, webkit.messageHandlers.still.postMessage → WebBridgeRouter.swift
//     get / settingsIntent / settingsAtomic → the same SettingsBridge strings, unwrapped;
//     onboardingState, safariSetupState, restore, receiptStatus, analyticsContext, ... → objects.
//
// The App Group record itself is held and changed by the reviewed TypeScript AtomicSettingsWriter,
// the reference implementation StillKit's AtomicSettingsRecord is parity-tested against
// (packages/shared-types/fixtures/atomic-settings-writer-vectors.json). So a recorded state is a
// real record, and a toggle commit gets the record the native writer would commit, not a guess.
import {
  AtomicSettingsWriter,
  SettingsStorageRecovery,
  type SettingsIntent,
} from "../../../../packages/core/src/storage/atomic-settings.js";
import type { StorageAdapter, StoredSettingsRecord } from "../../../../packages/core/src/storage/adapter.js";
import { initialAccessSnapshot, packagedAccessContext } from "../../../../packages/core/src/entitlement/access-policy.js";
import { parseAccessCacheRecord } from "../../../../packages/core/src/entitlement/access-record.js";
import type { QaState } from "./states.js";

export type Surface = "extension-native" | "extension-background" | "app";

export interface LoggedMessage {
  readonly surface: Surface;
  readonly frame: string;
  readonly message: unknown;
  readonly reply: unknown;
  /** The reply was a rejection (a native error string), not a value. */
  readonly rejected?: string;
}

/** Thrown into the page as a rejected postMessage / sendNativeMessage, like a native error reply. */
export class NativeRejection extends Error {}

class MemoryAppGroup implements StorageAdapter {
  record: StoredSettingsRecord | null;
  constructor(initial: StoredSettingsRecord | null) {
    this.record = initial ? structuredClone(initial) : null;
  }
  async get(): Promise<StoredSettingsRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }
  async set(record: StoredSettingsRecord): Promise<void> {
    const { intentCommitted: _transient, ...persisted } = record;
    this.record = structuredClone(persisted);
  }
  subscribe(): () => void {
    return () => {};
  }
}

/** Deterministic ids for the writer, so the same recorded state gives the same bytes every run. */
function counterUuid(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
}

const json = (value: unknown): string => JSON.stringify(value);
const objectOf = (message: unknown): Record<string, unknown> =>
  message && typeof message === "object" && !Array.isArray(message) ? (message as Record<string, unknown>) : {};

export class NativeModel {
  readonly log: LoggedMessage[] = [];
  private readonly group: MemoryAppGroup;
  private readonly writer: AtomicSettingsWriter;
  private onboardingComplete = false;

  private constructor(readonly state: QaState, record: StoredSettingsRecord | null) {
    this.group = new MemoryAppGroup(record);
    this.writer = new AtomicSettingsWriter(this.group, counterUuid());
  }

  /**
   * Build the App Group for a state. The record is produced by the reviewed writer from the
   * state's recipe (a 2.1.x never-edited record converted with unknown ownership, as the Apple
   * app's atomic mode does on first launch, then each recorded deliberate edit committed), so
   * it is exactly what native would hold, never a hand-written object.
   */
  static async create(state: QaState): Promise<NativeModel> {
    const record = await recordFor(state);
    return new NativeModel(state, record);
  }

  currentRecord(): StoredSettingsRecord | null {
    return this.group.record ? structuredClone(this.group.record) : null;
  }

  /** Every message one surface sent, in order. */
  messages(surface?: Surface): unknown[] {
    return this.log.filter((m) => !surface || m.surface === surface).map((m) => m.message);
  }

  async handle(surface: Surface, frame: string, message: unknown): Promise<unknown> {
    try {
      const reply = await this.route(surface, message);
      this.log.push({ surface, frame, message, reply });
      return reply;
    } catch (error) {
      const rejected = error instanceof Error ? error.message : String(error);
      this.log.push({ surface, frame, message, reply: undefined, rejected });
      throw error;
    }
  }

  private async route(surface: Surface, message: unknown): Promise<unknown> {
    if (this.state.native === "absent" && surface !== "extension-background")
      throw new NativeRejection("still: native host unavailable");
    const m = objectOf(message);
    if (surface === "extension-native") return this.extensionNative(m);
    if (surface === "extension-background") return this.extensionBackground(m);
    return this.app(m);
  }

  // ---- SettingsBridge.handle (StillKit), shared by both hosts -------------------------------
  private async settingsBridge(m: Record<string, unknown>): Promise<string | null> {
    switch (m.kind) {
      case "get": {
        const record = this.currentRecord();
        return record ? json(record) : "";
      }
      case "settingsIntent": {
        const keys = Object.keys(m).sort().join(",");
        if (keys !== "kind,path,updatedAt,value") return "";
        try {
          const intent: SettingsIntent = { path: m.path as SettingsIntent["path"], value: m.value as boolean, updatedAt: m.updatedAt as number };
          const committed = await this.writer.commit(intent);
          const { intentCommitted, ...record } = committed;
          return json({ record, changed: intentCommitted === true, status: "committed" });
        } catch {
          return "";
        }
      }
      case "settingsAtomic": {
        try {
          const command = JSON.parse(String(m.command)) as Record<string, unknown>;
          if (command.action !== "initialize") return json({ status: "unavailable" });
          // AtomicSettingsRecord.initialize: an absent record is unreadable, never fresh defaults.
          if (!this.group.record) return json({ status: "unavailable" });
          return json(await this.writer.initialize(command.ownership as "unknown"));
        } catch (error) {
          if (error instanceof SettingsStorageRecovery) return json({ status: "unavailable" });
          return json({ status: "unavailable" });
        }
      }
      case "set": {
        // A coarse legacy snapshot never replaces a modern record: the store returns what it holds.
        const record = this.currentRecord();
        return record ? json(record) : "";
      }
      default:
        return null;
    }
  }

  // ---- SafariWebExtensionHandler.beginRequest -------------------------------------------------
  private async extensionNative(m: Record<string, unknown>): Promise<unknown> {
    if (m.kind === "getAccountSyncStatus")
      return { accountSyncStatus: this.state.accountSyncStatus ? json(this.state.accountSyncStatus) : null };
    if (m.kind === "getBenefitAccess")
      return { entitlement: json({ ok: true, snapshot: initialAccessSnapshot(packagedAccessContext()) }) };
    const settings = await this.settingsBridge(m);
    return { settings: settings ?? "" };
  }

  // ---- The extension background's page-facing routers ---------------------------------------
  private async extensionBackground(m: Record<string, unknown>): Promise<unknown> {
    switch (m.kind) {
      case "reconcile":
        return undefined;
      case "still:settings-read": {
        // createSettingsIntentRouter answers with the background's own native read.
        if (this.state.native === "absent") return { status: "unavailable" };
        return { status: "ready", record: this.currentRecord() };
      }
      case "observeBenefits":
        // Paid tier off: the packaged free snapshot, with no native or network wait.
        return { ok: true, snapshot: initialAccessSnapshot(packagedAccessContext()) };
      case "observeAccess":
        return { ok: true, record: parseAccessCacheRecord(undefined) };
      default:
        // Analytics hand-offs and anything else: the background accepts and answers nothing.
        return undefined;
    }
  }

  // ---- WebBridgeRouter.handle (Apple app web view) ------------------------------------------
  private async app(m: Record<string, unknown>): Promise<unknown> {
    const settings = await this.settingsBridge(m);
    if (settings !== null) return settings;
    const s = this.state;
    switch (m.kind) {
      case "onboardingState":
        return {
          ok: true,
          shouldShow: s.onboarding.shouldShow && !this.onboardingComplete,
          platform: s.platform === "mac" ? "macos" : "ios",
          osMajorVersion: s.onboarding.osMajorVersion,
        };
      case "completeOnboarding":
        if (!s.onboarding.shouldShow) throw new NativeRejection("still: onboarding not presented by the web view");
        this.onboardingComplete = true;
        return { ok: true };
      case "safariSetupState":
        return s.platform === "mac"
          ? { ok: true, platform: "macos", extensionStatus: s.macExtension, enableLocation: "safariExtensionSettings" }
          : { ok: true, platform: "ios", extensionStatus: "unknown", enableLocation: "settingsAppStillPage" };
      case "openDestination":
        return { ok: true, destination: m.destination };
      case "restore":
        // FreePeriodRestoreCheck.reply while the paid tier is off. "pending" never answers, the way
        // the App Store check looks while it is still running.
        if (s.restore === "pending") return new Promise(() => {});
        return { entitled: s.restore === "restored", restore: s.restore };
      case "receiptStatus":
        return { receipt: "noSignal" };
      case "purchaseStatus":
      case "attachPurchases":
        return { entitled: false };
      case "purchase":
        // MonetizationConfig.paidTierEnabled is false: refused at the native boundary.
        return { outcome: "unavailable", entitled: false };
      case "price":
        return {};
      case "getBenefitAccess":
        return json({ ok: true, snapshot: initialAccessSnapshot(packagedAccessContext()) });
      case "getAccess":
        return json({ ok: true, record: parseAccessCacheRecord(undefined) });
      case "getEntitlement":
        return json({ entitled: false });
      case "setAccountSyncStatus":
      case "acknowledgeAnalyticsNotice":
        return { ok: true };
      case "setAnalyticsConsent":
        return { ok: true, enabled: m.enabled === true, answered: true };
      case "analyticsContext":
        return {
          platform: s.platform === "mac" ? "macos" : "ios",
          appVersion: "2.2.0",
          installId: "00000000-0000-4000-8000-0000000000aa",
          anchorId: "00000000-0000-4000-8000-0000000000bb",
          created: false,
          returning: false,
          previousVersion: null,
          consent: false,
          consentAnswered: true,
          noticeSeen: true,
          extensionEnabled: s.platform === "mac" ? s.macExtension === "enabled" : null,
          device: s.device,
        };
      default:
        throw new NativeRejection(`still: unrecognized message ${String(m.kind)}`);
    }
  }
}

/** A fixed clock for recorded edits (2026-10-01T00:00:00Z), so records are byte-stable. */
export const RECORDED_EDIT_TIME = Date.UTC(2026, 9, 1);

async function recordFor(state: QaState): Promise<StoredSettingsRecord | null> {
  if (state.appGroup === "empty") return null;
  // The 2.1.x install that never saved a setting: bundled defaults with no edit stamp (the shape
  // packages/shared-types/fixtures/upgrade-2.1.1.json records), converted as the app does.
  const { DEFAULT_SETTINGS } = await import("../../../../packages/shared-types/src/index.js");
  const group = new MemoryAppGroup({ settings: DEFAULT_SETTINGS, syncMetadata: null, syncEpoch: 0 });
  const writer = new AtomicSettingsWriter(group, counterUuid());
  if (state.appGroup === "legacy") return group.record;
  await writer.initialize("unknown");
  let step = 0;
  for (const [path, value] of state.edits) await writer.commit({ path, value, updatedAt: RECORDED_EDIT_TIME + ++step });
  return group.record;
}
