import {
  FEATURE_IDS,
  SERVICE_IDS,
  type FeatureId,
  type ServiceId,
  type SettingsField,
} from "@still/shared-types";
import type { EntitlementCache } from "../../entitlement/cache.js";
import { isBenefitEffective } from "../../entitlement/access-policy.js";
import {
  requireModernSettings,
  SettingsStorageRecovery,
} from "../../storage/atomic-settings.js";
import type { SettingsCache, SettingsAuthorityRereadOutcome } from "../../storage/cache.js";
import type { DesktopPopupProps } from "./presentation.js";

export interface DesktopPopupBindingState {
  /** Detached accepted modern choices; null never means defaults or saved Off. */
  readonly settings: DesktopPopupProps["settings"] | null;
  readonly access: DesktopPopupProps["access"];
  readonly commandAvailability: "ready" | "unavailable";
  readonly reason: string | null;
}

export type DesktopPopupCommandOutcome =
  | { readonly status: "committed" | "not-committed" }
  | {
      readonly status: "rejected";
      readonly reason: "invalid-input" | "inactive-or-unavailable";
    }
  | { readonly status: "unavailable"; readonly reason: string };

/** Dormant controlled D01 seam. Caller retains cache hydration, watchers and nonblocking actions. */
export function createDesktopPopupBinding(
  settingsCache: SettingsCache,
  accessCache: EntitlementCache,
) {
  const listeners = new Set<(state: DesktopPopupBindingState) => void>();
  let stoppedState: DesktopPopupBindingState | null = null;

  function readAuthority(): DesktopPopupBindingState {
    const access = accessCache.currentAccessSnapshot();
    const record = settingsCache.currentRecord();
    let settings: DesktopPopupProps["settings"] | null = null;
    if (
      "schemaVersion" in record.settings &&
      record.settings.schemaVersion === 2
    ) {
      try {
        settings = requireModernSettings(record);
      } catch {
        /* Unreadable choices stay unavailable. */
      }
    }
    const atomic = record.atomic;
    const reason = !settings
      ? "modern-settings-unavailable"
      : !settingsCache.supportsAtomicIntents() || !atomic
        ? "atomic-command-unavailable"
        : (atomic.paused ??
          (atomic.ownership === "unknown" ? "ownership-unconfirmed" : null));
    return {
      settings,
      access,
      commandAvailability: reason === null ? "ready" : "unavailable",
      reason,
    };
  }

  function read(): DesktopPopupBindingState {
    return stoppedState ? structuredClone(stoppedState) : readAuthority();
  }

  let published = JSON.stringify(read());
  function publish(): void {
    if (stoppedState) return;
    const state = read();
    const signature = JSON.stringify(state);
    if (signature === published) return;
    published = signature;
    for (const listener of [...listeners]) {
      if (stoppedState || published !== signature) break;
      if (listeners.has(listener)) listener(state);
    }
  }
  const unsubscribeSettings = settingsCache.subscribeAuthority(publish);
  const unsubscribeAccess = accessCache.subscribeAccess(publish);

  async function command(
    path: SettingsField,
    value: boolean,
  ): Promise<DesktopPopupCommandOutcome> {
    if (stoppedState) return { status: "unavailable", reason: "stopped" };
    const state = readAuthority();
    if (state.commandAvailability !== "ready")
      return { status: "unavailable", reason: state.reason! };
    const settings = state.settings!;
    if (path !== "globalOn") {
      if (path.startsWith("services.")) {
        if (!settings.globalOn)
          return { status: "rejected", reason: "inactive-or-unavailable" };
        if (
          path === "services.tiktok" &&
          !isBenefitEffective(
            { ...settings, services: { ...settings.services, tiktok: true } },
            "tiktok.all",
            state.access.states["tiktok.all"],
          )
        )
          return { status: "rejected", reason: "inactive-or-unavailable" };
      } else {
        const feature = path.slice(6) as FeatureId;
        // Availability for editing is independent of the existing saved Off intention.
        const candidate = {
          ...settings,
          sites: { ...settings.sites, [feature]: true },
        };
        if (
          !isBenefitEffective(candidate, feature, state.access.states[feature])
        )
          return { status: "rejected", reason: "inactive-or-unavailable" };
      }
    }
    try {
      const outcome = await settingsCache.commitAtomicIntent(path, value);
      return {
        status: outcome.intentCommitted ? "committed" : "not-committed",
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof SettingsStorageRecovery
            ? error.reason
            : "write-failed",
      };
    } finally {
      // State-only recovery holds can change without a settings-change notification.
      publish();
    }
  }

  const invalid = (): Promise<DesktopPopupCommandOutcome> =>
    Promise.resolve({ status: "rejected", reason: "invalid-input" });
  return {
    current: read,
    async rereadAuthority(): Promise<SettingsAuthorityRereadOutcome> {
      if (stoppedState) return { status: "unavailable", reason: "stopped" };
      const outcome = await settingsCache.rereadAuthority();
      // A shared-cache read may finish after stop; this binding owns only its view lifetime.
      if (stoppedState) return { status: "unavailable", reason: "stopped" };
      publish();
      return outcome;
    },
    subscribe(listener: (state: DesktopPopupBindingState) => void): () => void {
      if (stoppedState) return () => {};
      listeners.add(listener);
      listener(read());
      return () => {
        listeners.delete(listener);
      };
    },
    setGlobalOn(value: boolean): Promise<DesktopPopupCommandOutcome> {
      return typeof value === "boolean"
        ? command("globalOn", value)
        : invalid();
    },
    setService(
      service: ServiceId,
      value: boolean,
    ): Promise<DesktopPopupCommandOutcome> {
      return SERVICE_IDS.includes(service) && typeof value === "boolean"
        ? command(`services.${service}`, value)
        : invalid();
    },
    setFeature(
      feature: FeatureId,
      value: boolean,
    ): Promise<DesktopPopupCommandOutcome> {
      return FEATURE_IDS.includes(feature) && typeof value === "boolean"
        ? command(`sites.${feature}`, value)
        : invalid();
    },
    stop(): void {
      if (stoppedState) return;
      stoppedState = structuredClone({
        ...readAuthority(),
        commandAvailability: "unavailable",
        reason: "stopped",
      });
      unsubscribeSettings();
      unsubscribeAccess();
      listeners.clear();
      // Existing admitted commands may still commit; no new commands or late view publications.
    },
  };
}
