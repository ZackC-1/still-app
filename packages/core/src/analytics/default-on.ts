import {
  CONSENT_KEY,
  createStoredConsent,
  readAnalyticsPermission,
  type AnalyticsPermission,
  type AnalyticsPrivacyPolicy,
} from "./consent.js";
import type { AnalyticsKeyValue } from "./identity.js";
import { createAppleConsentStore } from "./apple-consent-store.js";
import { createAppAnalytics, type AppAnalytics, type AppAnalyticsDeps } from "./apple-app.js";
import { analyticsConfigured } from "./client.js";
import type { NativeBridge } from "../native/bridge.js";

// Usage sharing on by default, with a per-device off switch: ADR 0004, reaffirmed by the owner for
// V3 on 2026-10-10 ("By default I want people's analytics turned on. They can turn them off.").
//
// The analytics client admits work only under a granted permission record whose version matches
// the host's policy (client.ts `readAuthority`). This module is that authority for V3 builds:
//
//   * Chrome and the Apple app: the first read with no recorded choice grants the permission (on by
//     default). The 2.1 "on" value counts as no choice; a 2.1 "off" stays off. Turning sharing off
//     stores a stopped record (or `false`), which is never re-granted by a read; only the switch
//     turns it back on, under a new origin and therefore new ids.
//   * Firefox: Mozilla allows usage data only as the optional `technicalAndInteraction`
//     data-collection permission, offered in Firefox's own install prompt. That permission IS the
//     switch: the record is granted while it is granted (at install, from Still's settings or from
//     the add-on manager) and stopped as soon as it is not.
//
// Hosts pass it only from their V3 branches (the folding choice is the host's), together with
// DEFAULT_ON_USAGE_POLICY. Privacy limits are unchanged: the closed event schema, no content-script
// sends, no fingerprinting, never advertising.

/** What the default-on permission discloses. Its digest is the permission version, so a different
 * disclosure is a different permission. */
export const USAGE_DISCLOSURE =
  "Still usage sharing (ADR 0004): on by default on each device, with an off switch; on Firefox, only while the optional technicalAndInteraction data-collection permission is granted; the Safari extension follows the Apple app. Sends a closed set of product events to PostHog Cloud (US) with no pages, videos, searches or free text, nothing from content scripts, no location and no fingerprinting. A signed-in account has its email attached by Still's server. PostHog may process the data with its AI providers as the privacy policy states. Never used for advertising.";

/** SHA-256 of USAGE_DISCLOSURE (a test recomputes it). */
export const USAGE_PERMISSION_VERSION = "8cd9dbc03a8e29603c106027d5e60e93d9431285f2375092129aed7ebee1c6f8";

/** The policy a V3 host passes to the analytics client. It claims no capability evidence: ADR 0004
 * promises none (switching off stops collection and discards what waits; deleting the account is
 * what deletes what was sent). Accepted only in builds compiled with that basis (build-basis.ts). */
export const DEFAULT_ON_USAGE_POLICY: AnalyticsPrivacyPolicy = {
  basis: "adr-0004",
  permissionVersion: USAGE_PERMISSION_VERSION,
  context: "ordinary",
  capabilities: {},
};

/** Firefox's optional data-collection permission, as the switch. */
export interface BrowserUsagePermission {
  granted(): Promise<boolean>;
  /** Withdraw it (no user gesture needed). */
  revoke(): Promise<unknown>;
}

export interface DefaultOnUsageOptions {
  /** Where the permission record lives under CONSENT_KEY: extension local storage, or the Apple
   * App Group through the native bridge (createAppleConsentStore). A read that throws holds
   * sharing for that read and writes nothing. */
  readonly store: AnalyticsKeyValue;
  /** Firefox only: sharing follows this permission exactly. */
  readonly browserPermission?: BrowserUsagePermission;
}

export interface DefaultOnUsage {
  /** The granted permission in force, or null. Grants the default when no choice is recorded. */
  permission(): Promise<AnalyticsPermission | null>;
  /** Whether sharing is on (a granted permission is in force). */
  consent(): Promise<boolean>;
  /** The settings switch: on grants (a fresh origin after a stop), off stops. On Firefox, on takes
   * effect only if the page's permission request was accepted, and off also withdraws it. */
  commit(enabled: boolean): Promise<void>;
}

export function createDefaultOnUsage(options: DefaultOnUsageOptions): DefaultOnUsage {
  const { store, browserPermission } = options;
  const stored = createStoredConsent(store, true, {
    // A stopped origin owes no provider cleanup under ADR 0004 (switching off never promised to
    // delete what this device had already sent; account deletion does), so the switch may always
    // start again. A new grant derives a new origin and new ids; nothing is reused.
    cleanupOwned: async () => true,
  });
  // Reads and switch changes run one at a time, so a default grant can never land after an off.
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(op: () => Promise<T>): Promise<T> => {
    const next = chain.then(op, op);
    chain = next.catch(() => undefined);
    return next;
  };
  const readRaw = async (): Promise<{ readonly value: unknown } | null> => {
    try {
      return { value: await store.get(CONSENT_KEY) };
    } catch {
      return null;
    }
  };
  const current = (value: unknown): AnalyticsPermission | null => {
    const permission = readAnalyticsPermission(value);
    return permission?.state === "granted" && permission.version === USAGE_PERMISSION_VERSION ? permission : null;
  };
  const grant = async (): Promise<AnalyticsPermission | null> => {
    await stored.grant(USAGE_PERMISSION_VERSION);
    return current((await readRaw())?.value);
  };
  const browserGranted = async () => (await browserPermission?.granted().catch(() => false)) === true;

  const settle = async (): Promise<AnalyticsPermission | null> => {
    const raw = await readRaw();
    if (!raw) return null; // unreadable: hold, write nothing
    const permission = readAnalyticsPermission(raw.value);
    if (browserPermission) {
      if (!(await browserGranted())) {
        // Withdrawn (the add-on manager, or never granted): end any permission still in force.
        if (permission?.state === "granted") await stored.set(false);
        return null;
      }
      return current(raw.value) ?? grant();
    }
    const inForce = current(raw.value);
    if (inForce) return inForce;
    // On only where no choice is recorded: nothing yet, or the 2.1 default `true`, or a permission
    // granted under an earlier disclosure. A stop, a 2.1 `false` or anything unrecognised stays off.
    const noChoice = raw.value === null || raw.value === undefined || raw.value === true;
    if (noChoice || permission?.state === "granted") return grant();
    return null;
  };

  const permission = () => run(settle).catch(() => null);
  return {
    permission,
    consent: async () => (await permission()) !== null,
    commit: (enabled) =>
      run(async () => {
        if (!enabled) {
          await stored.set(false);
          await browserPermission?.revoke().catch(() => undefined);
          return;
        }
        if (browserPermission && !(await browserGranted())) return; // the prompt was declined
        await stored.grant(USAGE_PERMISSION_VERSION);
      }),
  };
}

/** The Apple app's V3 wiring for createAppAnalytics: the permission lives in the App Group (the
 * same slot the Safari extension reads), on by default, with the existing notice and switch. A 2.1
 * "off" (native `false`) stays off. */
export function defaultOnAppleAnalytics(
  bridge: Pick<NativeBridge, "observeAnalyticsPermission" | "commitAnalyticsPermission">,
): {
  readonly permission: () => Promise<AnalyticsPermission | null>;
  readonly privacyPolicy: AnalyticsPrivacyPolicy;
  readonly commitPermission: (enabled: boolean) => Promise<void>;
} {
  const usage = createDefaultOnUsage({ store: createAppleConsentStore(bridge) });
  return { permission: usage.permission, privacyPolicy: DEFAULT_ON_USAGE_POLICY, commitPermission: usage.commit };
}

/** The Apple app's V3 analytics: createAppAnalytics with the default-on wiring above, plus two
 * things the shared module leaves to its host:
 *
 *   * While sharing is off on this device no client runs (none may run under a stopped permission),
 *     so the shared module answers "no switch". This keeps the switch, showing off, so it can be
 *     turned back on after a relaunch.
 *   * Turning sharing on starts a new client under the new permission, and a client sends nothing
 *     until it has been told who is signed in. The launch told the earlier client (or none), so the
 *     latest account answer is given again to the new one.
 *
 * main.ts chooses this factory only in V3 builds (a choice that folds away in 2.x builds). */
export function createDefaultOnAppAnalytics(
  deps: Omit<AppAnalyticsDeps, "permission" | "privacyPolicy" | "commitPermission"> & {
    readonly bridge: AppAnalyticsDeps["bridge"] &
      Pick<NativeBridge, "observeAnalyticsPermission" | "commitAnalyticsPermission">;
  },
): AppAnalytics {
  const app = createAppAnalytics({ ...deps, ...defaultOnAppleAnalytics(deps.bridge) });
  const ui = app.ui;
  /** The latest account answer from the host: an account, nobody, or not known yet. */
  let account: string | null | undefined;
  return {
    ...app,
    identifyAccount(userId) {
      account = userId;
      return app.identifyAccount(userId);
    },
    accountAbsent() {
      account = null;
      return app.accountAbsent();
    },
    ui: {
      ...ui,
      identify(userId) {
        account = userId;
        ui.identify(userId);
      },
      reset(options) {
        account = null;
        return ui.reset(options);
      },
      async sharing() {
        const state = await ui.sharing!.call(ui);
        if (state || !analyticsConfigured(deps.config)) return state;
        // Only inside the app (a native context answers), as everywhere else on this surface.
        return (await deps.bridge.analyticsContext().catch(() => null)) ? { enabled: false, noticeNeeded: false } : null;
      },
      async setSharing(enabled) {
        const on = await ui.setSharing!.call(ui, enabled);
        if (on && account !== undefined) await (account === null ? app.accountAbsent() : app.identifyAccount(account));
        return on;
      },
    },
  };
}
