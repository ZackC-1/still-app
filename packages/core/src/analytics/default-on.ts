import {
  CONSENT_KEY,
  createStoredConsent,
  readAnalyticsPermission,
  samePermission,
  type AnalyticsPermission,
  type AnalyticsPrivacyPolicy,
} from "./consent.js";
import type { AnalyticsKeyValue } from "./identity.js";
import { createAppleConsentStore } from "./apple-consent-store.js";
import { createAppAnalytics, type AppAnalytics, type AppAnalyticsDeps } from "./apple-app.js";
import { STATE_KEY, analyticsConfigured } from "./client.js";
import { originProof } from "./derive.js";
import { isAnalyticsId } from "./identity.js";
import { NOTICE_KEY, type SubjectDeps } from "./extension-host.js";
import type { NativeBridge } from "../native/bridge.js";
import type { StillBridgeWindow } from "../storage/wkwebview-adapter.js";

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
//     the add-on manager) and stopped as soon as it is not. Still's own off is kept even if Firefox
//     refuses to withdraw the permission (a durable "stopped by Still" mark).
//   * The one-time notice is versioned by the disclosure: someone who acknowledged an earlier one
//     (the 2.1 notice included) sees it again when the disclosure changes, still on by default.
//   * Signed-in devices report under their own server-issued identity (owner decision 50), which
//     the server also gives the account's email; see `supabaseSubjectIssuer`.
//
// Hosts pass it only from their V3 branches (the folding choice is the host's), together with
// DEFAULT_ON_USAGE_POLICY. Privacy limits are unchanged: the closed event schema, no content-script
// sends, no fingerprinting, never advertising.

/** What the default-on permission discloses. Its digest is the permission version, so a different
 * disclosure is a different permission. */
export const USAGE_DISCLOSURE =
  "Still usage sharing (ADR 0004): on by default on each device, with an off switch; on Firefox, only while the optional technicalAndInteraction data-collection permission is granted; the Safari extension follows the Apple app. Sends a closed set of product events to PostHog Cloud (US) with no pages, videos, searches or free text, nothing from content scripts, no location and no fingerprinting. Turning sharing off sends nothing more; turning it back on starts a new anonymous identity. While signed in, a device reports under its own identity issued by Still's server, which attaches the account's email on the server; that identity and its events are deleted with the account. PostHog may process the data with its AI providers as the privacy policy states. Never used for advertising.";

/** SHA-256 of USAGE_DISCLOSURE (a test recomputes it). */
export const USAGE_PERMISSION_VERSION = "1f65beb21552e4bda2419619b0b85f93d14c6ecb66fc5ed64d75752db0abf6b9";

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

/** Firefox: Still's own off, kept while Firefox still reports the permission granted (it refused or
 * failed to withdraw it). Cleared when Firefox reports it withdrawn, or by Still's switch turning
 * sharing back on. Local, never sent. */
export const FIREFOX_STOPPED_KEY = "still:analytics:stopped-by-still";

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
  const read = async (key: string): Promise<{ readonly value: unknown } | null> => {
    try {
      return { value: await store.get(key) };
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
    return current((await read(CONSENT_KEY))?.value);
  };
  const browserGranted = async () => (await browserPermission?.granted().catch(() => false)) === true;

  const settle = async (): Promise<AnalyticsPermission | null> => {
    const raw = await read(CONSENT_KEY);
    if (!raw) return null; // unreadable: hold, write nothing
    const permission = readAnalyticsPermission(raw.value);
    if (browserPermission) {
      const mark = await read(FIREFOX_STOPPED_KEY);
      if (!(await browserGranted())) {
        // Withdrawn (the add-on manager, Still's switch, or never granted): end any permission still
        // in force; Firefox now agrees with any earlier off, so its mark is no longer needed.
        if (permission?.state === "granted") await stored.set(false);
        if (mark?.value === true) await store.set(FIREFOX_STOPPED_KEY, null);
        return null;
      }
      // Still's own off stands while Firefox still reports the permission (or the mark is unreadable).
      if (!mark || mark.value === true) {
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
          // The mark first, so Still's off holds even if what follows fails or Firefox keeps the
          // permission. It stays only while Firefox still reports the permission: once Firefox has
          // withdrawn it, a later grant in the add-on manager must turn sharing on again.
          if (browserPermission) await store.set(FIREFOX_STOPPED_KEY, true);
          await stored.set(false);
          if (browserPermission) {
            await browserPermission.revoke().catch(() => undefined);
            if (!(await browserGranted())) await store.set(FIREFOX_STOPPED_KEY, null);
          }
          return;
        }
        if (browserPermission) {
          if (!(await browserGranted())) return; // the prompt was declined
          await store.set(FIREFOX_STOPPED_KEY, null);
        }
        await stored.grant(USAGE_PERMISSION_VERSION);
      }),
  };
}

// ── The one-time notice, versioned by the disclosure ──────────────────────────────────────────

/** The disclosure version whose notice this device acknowledged. Local, never sent. */
export const NOTICE_VERSION_KEY = "still:analytics:notice-version";

/**
 * Extension local storage as the extension host sees it, with the notice flag (NOTICE_KEY) answered
 * from the acknowledged disclosure version: an earlier acknowledgement (the 2.1 notice, or a
 * notice for an earlier disclosure) reads as not seen, so the notice shows again. Every other key
 * passes through.
 */
export function versionedNotice(store: AnalyticsKeyValue): AnalyticsKeyValue {
  return {
    async get(key) {
      if (key === NOTICE_KEY) return (await store.get(NOTICE_VERSION_KEY)) === USAGE_PERMISSION_VERSION;
      return store.get(key);
    },
    async set(key, value) {
      if (key === NOTICE_KEY) return store.set(NOTICE_VERSION_KEY, value === true ? USAGE_PERMISSION_VERSION : null);
      return store.set(key, value);
    },
  };
}

// ── Per-device identities for signed-in devices (owner decision 50) ───────────────────────────

/** The parts of a Supabase client a subject request uses. */
export interface SubjectIssuingClient {
  readonly auth: {
    getSession(): Promise<{
      readonly data: { readonly session: { readonly access_token: string; readonly user: { readonly id: string } } | null };
      readonly error: unknown;
    }>;
  };
  readonly functions: {
    invoke(
      name: string,
      options: { body: { originProof: string }; headers: Record<string, string>; signal: AbortSignal },
    ): Promise<{ readonly data: unknown; readonly error: unknown }>;
  };
}

/**
 * Ask `analytics-identify` for this device's identity for `account`: the request carries only the
 * origin proof (a one-way hash; derive.ts), with that account's own session and nothing else. The
 * server issues or returns the device's subject (never the account id), attaches the account's
 * email to it on the server, and answers `{state: "active", subject}` or `{state: "stopped"}`. Until
 * the server's `ANALYTICS_SUBJECTS_ENABLED` switch is on it answers 503: this throws, and what the
 * signed-in device recorded keeps waiting on the device, bound to the account.
 */
export function supabaseSubjectIssuer(
  client: SubjectIssuingClient,
  now: () => number = Date.now,
): SubjectDeps["issue"] {
  // While the server refuses (503 until its switch is on, 429 when rate limited), wait before asking
  // again instead of asking at every Still screen: signed-in use just keeps waiting on the device.
  let retryAt = 0;
  return async (body, signal, account) => {
    if (now() < retryAt) throw new Error("Per-device identities are unavailable; retrying later");
    const { data, error } = await client.auth.getSession();
    const session = data.session;
    // Refuse a session for anyone else: the identity must be issued to this account only.
    if (error || !session || session.user.id.toLowerCase() !== account.toLowerCase())
      throw new Error("No session for this account");
    const reply = await client.functions.invoke("analytics-identify", {
      body: { originProof: body.originProof },
      headers: { Authorization: `Bearer ${session.access_token}` },
      signal,
    });
    if (reply.error) {
      const status = (reply.error as { context?: { status?: unknown } }).context?.status;
      if (status === 503 || status === 429) retryAt = now() + SUBJECT_RETRY_MS;
      throw reply.error;
    }
    return reply.data;
  };
}

/** How long a subject issuer waits after the server answered 503 or 429. */
export const SUBJECT_RETRY_MS = 15 * 60_000;

// ── The Apple app ─────────────────────────────────────────────────────────────────────────────

export interface DefaultOnAppAnalyticsDeps
  extends Omit<AppAnalyticsDeps, "permission" | "privacyPolicy" | "commitPermission" | "subjects"> {
  readonly bridge: AppAnalyticsDeps["bridge"] &
    Pick<NativeBridge, "observeAnalyticsPermission" | "commitAnalyticsPermission">;
  /** Requests this device's identity for a signed-in account (supabaseSubjectIssuer). Absent in a
   * build without sign-in: signed-in use then never exists. */
  readonly issueSubject?: SubjectDeps["issue"];
  /** The web view's window, for the native port (default: globalThis). */
  readonly win?: StillBridgeWindow;
}

/** The app's V3 permission wiring: the record lives in the App Group, the slot the Safari extension
 * reads; on by default; a 2.1 "off" (native `false`) stays off. */
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

/**
 * The Apple app's V3 analytics: createAppAnalytics with the default-on wiring above, plus what the
 * shared module leaves to its host:
 *
 *   * The switch follows the App Group record. While sharing is off no client runs (none may run
 *     under a stopped permission), so the shared module answers "no switch"; this answers off when
 *     the record is stopped or off, and hides the switch only when the state is unknown.
 *   * An off that the App Group did not take is reported as a failure (the controller keeps the
 *     switch on) rather than shown as off while the Safari extension keeps reporting.
 *   * Turning sharing on starts a new client, which sends nothing until it is told who is signed
 *     in; the latest account answer is given again to the new one.
 *   * The notice is versioned by the disclosure (NOTICE_VERSION_KEY in the web view's storage).
 *   * Signed-in identities: the server-issued subject is also published to the App Group, so the
 *     Safari extension on this device reports under the same one; an account deletion clears it.
 *
 * main.ts chooses this factory only in V3 builds (a choice that folds away in 2.x builds).
 */
export function createDefaultOnAppAnalytics(deps: DefaultOnAppAnalyticsDeps): AppAnalytics {
  const consentStore = createAppleConsentStore(deps.bridge);
  const usage = createDefaultOnUsage({ store: consentStore });
  const port = () => (deps.win ?? (globalThis as unknown as StillBridgeWindow)).webkit?.messageHandlers?.still ?? null;

  // ── The identity the Safari extension follows ──
  // Published only once the shared module has confirmed it (the client's stored account state names
  // it), republished whenever that changes, and cleared when there is none (signed out, deleted,
  // sharing off, stopped by the server). A write counts only when native answers ok.
  type Published = { readonly account: string; readonly originProof: string; readonly subject: string } | null;
  let published: string | undefined; // what native last confirmed, as JSON; undefined: not yet this launch
  const confirmedIdentity = async (): Promise<Published> => {
    const permission = await usage.permission();
    if (!permission) return null;
    const state = (await deps.store.get(STATE_KEY).catch(() => null)) as Record<string, unknown> | null;
    if (
      !state ||
      !isAnalyticsId(state.userId) ||
      !isAnalyticsId(state.accountRef) ||
      !samePermission(readAnalyticsPermission(state.permission), permission)
    )
      return null;
    return {
      account: state.accountRef.toLowerCase(),
      originProof: await originProof(permission.origin),
      subject: state.userId.toLowerCase(),
    };
  };
  let syncing: Promise<void> = Promise.resolve();
  const syncPublished = (): Promise<void> =>
    (syncing = syncing.then(async () => {
      const wanted = await confirmedIdentity().catch((): Published | undefined => undefined);
      if (wanted === undefined) return; // unknown: change nothing
      const json = JSON.stringify(wanted);
      if (json === published) return;
      try {
        const raw = await port()?.postMessage({ kind: "setAnalyticsSubject", subject: wanted });
        const reply = (typeof raw === "string" ? JSON.parse(raw) : raw) as { ok?: unknown } | null;
        if (reply?.ok === true) published = json;
      } catch {
        /* not ok: tried again at the next chance */
      }
    }));
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const syncSoon = () => {
    if (syncTimer !== undefined) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void syncPublished();
    }, 2_000);
  };

  const issueSubject = deps.issueSubject;
  const app = createAppAnalytics({
    ...deps,
    permission: usage.permission,
    privacyPolicy: DEFAULT_ON_USAGE_POLICY,
    commitPermission: usage.commit,
    subjects: issueSubject
      ? {
          issue: issueSubject,
          // The server stopped this device's identity: end sharing here (never a device erasure),
          // and withdraw it from the Safari extension.
          onStopped: async () => {
            await usage.commit(false);
            await syncPublished();
          },
        }
      : undefined,
  });
  const ui = app.ui;
  /** The App Group record as stored, without granting: "on", "off", or null when unknown. */
  const storedState = async (): Promise<"on" | "off" | null> => {
    try {
      const value = await consentStore.get(CONSENT_KEY);
      if (value === false) return "off";
      const permission = readAnalyticsPermission(value);
      return permission?.state === "stopped" ? "off" : permission?.state === "granted" ? "on" : null;
    } catch {
      return null;
    }
  };
  const noticeAcknowledged = async () =>
    (await deps.store.get(NOTICE_VERSION_KEY).catch(() => null)) === USAGE_PERMISSION_VERSION;
  /** The latest account answer from the host: an account, nobody, or not known yet. */
  let account: string | null | undefined;
  const thenSync = async (work: Promise<void> | void): Promise<void> => {
    await work;
    await syncPublished();
  };
  return {
    ...app,
    start: () => thenSync(app.start()),
    recheckSetup: () => thenSync(app.recheckSetup()),
    identifyAccount(userId) {
      account = userId;
      return thenSync(app.identifyAccount(userId));
    },
    accountAbsent() {
      account = null;
      return thenSync(app.accountAbsent());
    },
    ui: {
      ...ui,
      track(name, props) {
        ui.track(name, props);
        syncSoon(); // an ordinary screen may have just confirmed this device's identity
      },
      identify(userId) {
        account = userId;
        ui.identify(userId);
        syncSoon();
      },
      async reset(options) {
        account = null;
        await thenSync(ui.reset(options));
      },
      async sharing() {
        const state = await ui.sharing!.call(ui);
        if (state) return state.enabled && !state.noticeNeeded && !(await noticeAcknowledged())
          ? { enabled: true, noticeNeeded: true }
          : state;
        if (!analyticsConfigured(deps.config)) return null;
        // Off on this device shows the switch (off); anything else unknown hides it, as before.
        return (await storedState()) === "off" ? { enabled: false, noticeNeeded: false } : null;
      },
      async setSharing(enabled) {
        const on = await ui.setSharing!.call(ui, enabled);
        // An off the App Group positively did not take (it still reads on): try once more, then
        // report failure so the switch keeps showing on (the Safari extension follows the App
        // Group, not this screen). A read-back that fails is unknown, not a failure.
        if (!enabled && (await storedState()) === "on") {
          await usage.commit(false).catch(() => undefined);
          if ((await storedState()) === "on") throw new Error("Sharing could not be turned off");
        }
        if (on && account !== undefined) await (account === null ? app.accountAbsent() : app.identifyAccount(account));
        await syncPublished();
        return on;
      },
      acknowledgeNotice() {
        ui.acknowledgeNotice!.call(ui);
        void Promise.resolve(deps.store.set(NOTICE_VERSION_KEY, USAGE_PERMISSION_VERSION)).catch(() => undefined);
      },
    },
  };
}
