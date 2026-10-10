import type { AnalyticsPermission, AnalyticsPrivacyPolicy } from "./consent.js";
import {
  AnalyticsClient,
  type AnalyticsConfig,
  type AnalyticsClientDeps,
  type TrackOptions,
} from "./client.js";
import {
  canonicalEvent,
  isAppClientEvent,
  serverIdentifyFor,
  type AnalyticsDevice,
  type AnalyticsSurface,
} from "./events.js";
import { isAnalyticsId, type AnalyticsIdentity, type AnalyticsKeyValue } from "./identity.js";
import { ANON_INDEX_LIMIT, originProof } from "./derive.js";
import type { AccountErasureService, ErasureService, ErasureWithdrawal } from "./erasure.js";
import { USAGE_ON_BY_DEFAULT_BUILD } from "./build-basis.js";
import type {
  UiAccountErasureView,
  UiAnalytics,
  UsageSharingState,
} from "../ui/controller.svelte.js";

// The analytics host every browser extension build shares (Chrome, Firefox, Safari). The
// extension's background owns the one client, so a popup that closes mid-send loses nothing and
// there is one queue per browser profile. Pages talk to it over ANALYTICS_MESSAGE_KIND. Content
// scripts send nothing: they run on the sites people visit, and Still never records browsing.
//
// A background usually starts because someone just opened YouTube, Instagram, Facebook or TikTok
// (the content script wakes it), or because the analytics alarm fired. So:
//   * Background work is "quiet": stamped with its day only and not sent then (client.ts
//     TrackOptions). It goes out with the next popup or settings open, or at the random time the
//     alarm picks, so neither the event nor its arrival says when a site was visited.
//   * A day of use (`active`) comes only from real use: the content script's visit nudge
//     (onActivity) or a Still screen. A background start by itself (an alarm, a browser restart)
//     records nothing, so the alarm can never manufacture retention.
//   * Every send waits for the start's account check, so an account that has ended is let go (and
//     its waiting events dropped) before anything leaves.
//
// What differs by build is injected: where the ids come from (browser sync storage, or the Apple
// App Group), who owns consent (a stored switch, Firefox's data-collection permission, or the
// Apple app's switch), and whether the one-time notice applies.

export const ANALYTICS_MESSAGE_KIND = "still:analytics";
export const NOTICE_KEY = "still:analytics:notice-seen";
export const SERVER_IDENTIFIED_KEY = "still:analytics:server-identified";
/** Legacy storage key retained for migration/tests. Its pre-consent history is never replayed. */
export const PENDING_INSTALL_KEY = "still:analytics:pending-install";
/** This device's issued per-account subjects (U5-W2): which PostHog identity each account uses here. */
export const SUBJECTS_KEY = "still:analytics:subjects";
export const SUBJECTS_LIMIT = 8;
/** Set when the server stopped this device because sharing was turned off for the account from
 * another device (an account-wide deletion): `{account}`. Read for the line "Sharing was turned off
 * from another device." and cleared once it has been shown. Local, never sent. */
export const STOPPED_ELSEWHERE_KEY = "still:analytics:stopped-elsewhere";

const QUIET: TrackOptions = { quiet: true };
type Observation = ReturnType<AnalyticsClient["captureObservation"]>;
/** Longest a send waits for the background start's account check. */
export const START_HOLD_LIMIT_MS = 10_000;
/** Longest one server email attach may take before a later screen may try again. */
export const SERVER_ATTACH_LIMIT_MS = 15_000;

export interface MessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: unknown;
  readonly incognito?: boolean;
}

export interface ExtensionAnalyticsHostDeps {
  readonly surface: AnalyticsSurface;
  readonly device?: AnalyticsDevice;
  readonly config: AnalyticsConfig;
  readonly appVersion: string;
  /** This extension's local storage: account, markers, notice flag and a pending install. */
  readonly local: AnalyticsKeyValue;
  /** Where queued events wait: IndexedDB private to the background (idb.ts). */
  readonly queueStore?: AnalyticsKeyValue;
  readonly identity: () => Promise<AnalyticsIdentity>;
  readonly consent: () => Promise<boolean>;
  readonly permission?: () => Promise<AnalyticsPermission | null>;
  readonly privacyPolicy?: AnalyticsPrivacyPolicy;
  readonly envelope?: AnalyticsClientDeps["envelope"];
  /** Existing common authority commits the actual reviewed combined choice; legacy toggles cannot grant. */
  readonly commitPermission?: (enabled: boolean) => Promise<void>;
  /** Persist a switch change. Absent where something else owns consent (Firefox's permission,
   * the Apple app's switch); the host then re-reads `consent` after a change. */
  readonly storeConsent?: (enabled: boolean) => Promise<void>;
  /** Whether this surface shows the one-time "sharing is on" notice. */
  readonly noticeApplies: boolean;
  /** Only extension pages (popup, options) may use the page protocol. */
  readonly isTrustedPage: (sender: MessageSender) => boolean;
  /** Ask Still's server to attach the signed-in account's email (analytics-identify). */
  readonly identifyOnServer?: (signal?: AbortSignal) => Promise<void>;
  /** Per-device identities (U5-W2); see SubjectDeps. Absent: the account id is confirmed, as before. */
  readonly subjects?: SubjectDeps;
  /** Device erasure (U5-W2): records the stop when sharing is switched off here, and submits it. */
  readonly erasure?: ErasureService;
  /** Account-wide erasure (U5-W3 packet B, "Delete shared data on all devices"). Offered to pages
   * only while per-device subjects are wired too: without them no account-linked identity exists
   * to delete, so the action stays hidden (the page's state request answers null). */
  readonly accountErasure?: AccountErasureService;
  /** Ask for a flush at a random later time (an alarm), for events recorded quietly at a
   * background start. Without it they wait for the next popup or settings open. */
  readonly requestQuietFlush?: () => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface ExtensionAnalyticsHost {
  readonly client: AnalyticsClient;
  /** runtime.onInstalled: `installed` for a new install, `updated` for an update. */
  onInstalled(
    details: { reason: string; previousVersion?: string },
    observation?: Observation,
  ): void;
  /** Background start: one quiet `active` a day, setup complete on Safari (the extension is
   * running), a pending install if sharing is now on, and the current account. `null` means known to
   * be signed out (an earlier account is let go, whether it signed out here, elsewhere or was
   * deleted); `undefined` means it could not be read, so nothing about the account changes.
   *
   * Call it synchronously when the background starts, passing the session read itself (a promise)
   * rather than awaiting it first: the start's account ask is reserved at once, so a sign-out,
   * deletion or sign-in that happens while the read is in flight supersedes it, and a stale read
   * that lands afterwards changes nothing. A rejected read counts as `undefined`. */
  onStart(userId: string | null | undefined | PromiseLike<string | null | undefined>): void;
  /** The content script's visit nudge: real use. One quiet `active` for the day, and on Safari the
   * setup milestones (the extension demonstrably runs). */
  onActivity(observation?: Observation): void;
  /** Terminal host teardown, including owned startup/send timers and pending authority. */
  stop(): void;
  /** Flush after the start's account check has settled (the alarm handler). */
  flushWhenReady(): Promise<void>;
  /** Identify the install, and once per account have the server attach the email. */
  identify(userId: string, options?: TrackOptions): Promise<void>;
  /** V3 builds only: forget this device's cached per-device identities for the account the client
   * reported as (a host that confirms "nobody" itself, as the Safari extension does). */
  readonly forgetSubjects?: (reportingAs: string | null) => Promise<void>;
  readonly listener: (
    message: unknown,
    sender: MessageSender,
    sendResponse: (response?: unknown) => void,
    observation?: Observation,
  ) => boolean;
}

type PageRequest =
  | {
      readonly action: "track";
      readonly name: string;
      readonly props?: unknown;
    }
  | { readonly action: "identify"; readonly userId: string }
  | { readonly action: "reset"; readonly forgetAccount: boolean; readonly account?: string }
  | { readonly action: "sharing" }
  | { readonly action: "setSharing"; readonly enabled: boolean }
  | { readonly action: "acknowledgeNotice" }
  | {
      readonly action: "accountErasure";
      readonly op: "state" | "start" | "retry" | "acknowledge";
      readonly account: string;
    };

export interface AccountIdentifier {
  /** Identify the install as this account; an ordinary (not quiet) identify also runs the attach.
   * `ask`: an account ask the caller reserved earlier (`client.reserveAccountAsk`), for an identify
   * whose account was read after a wait; anything asked since supersedes it. */
  identify(userId: string, options?: TrackOptions, ask?: number): Promise<void>;
  /** An account deletion (or a start that finds nobody signed in): forget this device's cached
   * per-device subjects for `account` when named, for the account the host last asked for, and for
   * the one being reported as, so no deleted account's mapping stays. */
  forgetSubjects(reportingAs: string | null, account?: string): Promise<void>;
  /**
   * The server email attach for whichever account the client reports as right now, once per
   * account while sharing is on. It never changes the account itself (a stale read must not restore
   * an account that signed out meanwhile), it re-checks the account and sharing immediately before
   * the request, and concurrent calls share one attempt. A quiet identify (a background start)
   * never runs it: its arrival time would mark a site visit.
   */
  attach(
    observation?: Awaited<ReturnType<AnalyticsClient["captureObservation"]>>,
  ): Promise<void>;
}

/** The server's answer to a per-device identity request (analytics-identify with an origin proof). */
export type SubjectReply = { readonly state: "active"; readonly subject: string } | { readonly state: "stopped" };

/**
 * Per-device identities (owner decision 50). With these, a signed-in device reports under its own
 * server-issued subject instead of the account id, so stopping on one device can delete only that
 * device's history. The request carries only the origin proof, a one-way hash of the private
 * origin; the origin itself never leaves the device.
 */
export interface SubjectDeps {
  /** POST {originProof} to analytics-identify with `account`'s own session (a host must refuse if
   * its session is for another account); resolve the JSON reply. */
  readonly issue: (body: { readonly originProof: string }, signal: AbortSignal, account: string) => Promise<unknown>;
  /** The server stopped this device (it was erased): end the permission in force here.
   * Owner decision 61: an account-wide deletion erases account data only. A host must never wire
   * this, or any account-wide deletion, to the device "stop sharing" erasure (`ErasureService`):
   * this device's signed-out (anonymous) data stays until sharing is turned off on this device. */
  readonly onStopped: () => Promise<void>;
  /** V3 builds: `issue` reads an identity already issued on this device (the Safari extension reads
   * the Apple app's from the App Group) and makes no network request. A background start may then
   * use it (it cannot mark a visit), and it is authoritative: a cached identity it no longer
   * confirms is forgotten, never reused. Honoured only in V3 builds (build-basis.ts). */
  readonly local?: boolean;
}

interface StoredSubject {
  readonly account: string;
  readonly origin: string;
  readonly subject: string;
}

function readSubjects(value: unknown): StoredSubject[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is StoredSubject =>
          !!v &&
          typeof v === "object" &&
          isAnalyticsId((v as StoredSubject).account) &&
          isAnalyticsId((v as StoredSubject).origin) &&
          isAnalyticsId((v as StoredSubject).subject),
      )
    : [];
}

function subjectReply(value: unknown, account: string): SubjectReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.state === "stopped") return { state: "stopped" };
  if (v.state === "active" && isAnalyticsId(v.subject) && v.subject.toLowerCase() !== account.toLowerCase()) {
    return { state: "active", subject: v.subject.toLowerCase() };
  }
  return null;
}

/** Shared by the extension host and the Apple app. */
export function createAccountIdentifier(deps: {
  readonly client: AnalyticsClient;
  readonly local: AnalyticsKeyValue;
  readonly consent: () => Promise<boolean>;
  readonly identifyOnServer?: (signal?: AbortSignal) => Promise<void>;
  readonly subjects?: SubjectDeps;
}): AccountIdentifier {
  const { client } = deps;
  const consented = () => deps.consent().catch(() => false);
  // One attempt at a time per account: a request still running for account A never stands in for
  // account B, and a hung request is abandoned after SERVER_ATTACH_LIMIT_MS so retries continue.
  const inflight = new Map<string, Promise<void>>();
  const attach = async (
    original?: Awaited<ReturnType<AnalyticsClient["captureObservation"]>>,
  ): Promise<void> => {
    if (!deps.identifyOnServer || !client.enabled || !client.accountConfirmed)
      return;
    const observation =
      original === undefined ? await client.captureObservation() : original;
    if (!observation || !(await client.observationCurrent(observation))) return;
    const userId = await client.signedInAs();
    if (!userId) return;
    const existing = inflight.get(userId);
    if (existing) return existing;
    const attempt = (async () => {
      const stamp = observation.stamp;
      if (!observation) return;
      if (!(await consented()) || !(await client.canReport())) return;
      const marker = await deps.local
        .get(SERVER_IDENTIFIED_KEY)
        .catch(() => null);
      const authority = {
        userId,
        origin: observation.permission.origin,
        generation: observation.permission.generation,
        version: observation.permission.version,
      };
      if (
        marker &&
        typeof marker === "object" &&
        Object.entries(authority).every(
          ([key, value]) => (marker as Record<string, unknown>)[key] === value,
        )
      )
        return;
      // Immediately before the request: same confirmed account, sharing still on, nothing reset.
      if ((await client.signedInAs()) !== userId || !(await consented()))
        return;
      if (
        !client.accountConfirmed ||
        !(await client.canReport()) ||
        !client.isCurrent(stamp) ||
        !(await client.observationCurrent(observation))
      )
        return;
      const controller = new AbortController();
      const scope = client.cancellationSignal();
      const abort = () => controller.abort();
      scope.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error("cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, {
          once: true,
        });
      });
      try {
        if (scope.aborted || !client.isCurrent(stamp)) return;
        await Promise.race([
          deps.identifyOnServer!(controller.signal),
          cancelled,
          new Promise<never>(
            (_, reject) =>
              (timer = setTimeout(() => {
                controller.abort();
                reject(new Error("timeout"));
              }, SERVER_ATTACH_LIMIT_MS)),
          ),
        ]);
        if (
          client.accountConfirmed &&
          client.isCurrent(stamp) &&
          (await client.canReport()) &&
          (await client.observationCurrent(observation)) &&
          client.isCurrent(stamp)
        )
          await deps.local.set(SERVER_IDENTIFIED_KEY, authority);
      } catch {
        /* retried at the next Still screen */
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        scope.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", rejectAbort);
      }
    })().finally(() => inflight.delete(userId));
    inflight.set(userId, attempt);
    return attempt;
  };
  // ── Per-device subjects ──
  const subjectRequests = new Map<string, Promise<string | "stopped" | null>>();
  const cachedSubject = async (account: string, origin: string): Promise<string | null> => {
    const stored = readSubjects(await deps.local.get(SUBJECTS_KEY).catch(() => null));
    return stored.find((s) => s.account === account && s.origin === origin)?.subject ?? null;
  };
  const rememberSubject = async (entry: StoredSubject): Promise<boolean> => {
    try {
      const stored = readSubjects(await deps.local.get(SUBJECTS_KEY)).filter(
        (s) => !(s.account === entry.account && s.origin === entry.origin),
      );
      await deps.local.set(SUBJECTS_KEY, [...stored, entry].slice(-SUBJECTS_LIMIT));
      return (await cachedSubject(entry.account, entry.origin)) === entry.subject;
    } catch {
      return false;
    }
  };
  const forgetEntry = async (entry: StoredSubject): Promise<void> => {
    try {
      const stored = readSubjects(await deps.local.get(SUBJECTS_KEY));
      const kept = stored.filter(
        (s) => !(s.account === entry.account && s.origin === entry.origin && s.subject === entry.subject),
      );
      if (kept.length !== stored.length) await deps.local.set(SUBJECTS_KEY, kept);
    } catch {
      /* best effort: the entry is local, bounded and never sent */
    }
  };
  /** One bounded, cancellable request per (account, origin). Never from a background start. */
  const requestSubject = (
    account: string,
    observation: NonNullable<Awaited<ReturnType<AnalyticsClient["captureObservation"]>>>,
  ): Promise<string | "stopped" | null> => {
    const origin = observation.permission.origin;
    const key = `${account}:${origin}`;
    const existing = subjectRequests.get(key);
    if (existing) return existing;
    const attempt = (async (): Promise<string | "stopped" | null> => {
      const controller = new AbortController();
      const scope = client.cancellationSignal();
      const abort = () => controller.abort();
      scope.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (scope.aborted || !(await client.observationCurrent(observation))) return null;
        const proof = await originProof(origin);
        const reply = subjectReply(
          await Promise.race([
            deps.subjects!.issue({ originProof: proof }, controller.signal, account),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("timeout"));
              }, SERVER_ATTACH_LIMIT_MS);
              controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            }),
          ]),
          account,
        );
        if (!reply || !(await client.observationCurrent(observation))) return null;
        if (reply.state === "stopped") return "stopped";
        const entry = { account, origin, subject: reply.subject };
        const remembered = await rememberSubject(entry);
        // A forget (a deletion) or any other cancellation that landed while the write was in flight
        // must not leave the mapping behind: remove it again and confirm nothing.
        if (scope.aborted) {
          await forgetEntry(entry);
          return null;
        }
        return remembered ? reply.subject : null;
      } catch {
        return null; // retried at the next Still screen
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        scope.removeEventListener("abort", abort);
      }
    })().finally(() => subjectRequests.delete(key));
    subjectRequests.set(key, attempt);
    return attempt;
  };
  /** The last account a host asked for, and the client state it was asked under. A later Still
   * screen retries a subject request that failed, only while nothing has changed since (a sign-out,
   * a deletion or a permission change makes the stamp stale, so a stale account is never restored). */
  let wanted: { readonly account: string; readonly stamp: ReturnType<AnalyticsClient["stamp"]> } | null = null;
  const identifySubject = async (asked: string, options: TrackOptions, reserved?: number): Promise<void> => {
    if (!isAnalyticsId(asked) || !client.enabled) return;
    const account = asked.toLowerCase();
    // Unless this account's own subject is already confirmed, hold the client for this account
    // first, before any return below (a quiet start, no permission, a failed request): reporting as
    // anyone else (another account's subject, or nobody) stops at once, and what is recorded until
    // the subject is confirmed waits bound to this account, so a sign-out or another account never
    // receives it. A hold already in force for this same account cancels nothing, so its own work
    // in progress is kept.
    //
    // Fences. `ask` is reserved before any wait: anything asked after it (a sign-out, a deletion,
    // another account or identify, a stale start's read overtaken by a reset) supersedes this call,
    // which then holds nothing, requests nothing and confirms nothing; the later ask decides. `fence`
    // is the client's stamp taken synchronously as the hold is asked (after its own withdrawal), so a
    // cancellation (sharing off, a forget) also makes this call's request and confirmation stale,
    // even while the hold is still waiting its turn on the chain.
    const ask = reserved ?? client.reserveAccountAsk();
    if (!client.isLatestAsk(ask)) return;
    const current = () => client.isLatestAsk(ask) && client.isCurrent(fence);
    const before = await client.captureObservation();
    let known = before ? await cachedSubject(account, before.permission.origin) : null;
    // A local issuer is the authority for this device's identity: check the cached one against it
    // first, so an identity retired elsewhere (an account deleted, sharing stopped) is never reused.
    if (USAGE_ON_BY_DEFAULT_BUILD && deps.subjects?.local === true && before && known) {
      const live = await requestSubject(account, before);
      if (live !== known) {
        await forgetEntry({ account, origin: before.permission.origin, subject: known });
        known = null;
      }
    }
    const confirmedHere =
      before !== null && client.accountConfirmed && known !== null && (await client.signedInAs()) === known;
    if (!client.isLatestAsk(ask)) return;
    const holding = confirmedHere ? null : client.holdForAccount(account, ask);
    const fence = confirmedHere ? before.stamp : client.stamp();
    await holding;
    if (!current()) return;
    wanted = { account, stamp: fence };
    // Who reports here is decided under the permission in force; without one nothing is attributed.
    const observation = await client.captureObservation();
    if (!observation || !current()) return;
    let subject = await cachedSubject(account, observation.permission.origin);
    if (!subject && options.quiet && !(USAGE_ON_BY_DEFAULT_BUILD && deps.subjects?.local === true)) {
      // A background start never calls the server (its timing would mark a site visit): events
      // wait unattributed until an ordinary Still screen obtains the subject. But a request that a
      // Still screen already started for this same account and origin is awaited: this quiet ask
      // superseded that screen's own confirmation, so it confirms the subject in its place.
      const inflight = subjectRequests.get(`${account}:${observation.permission.origin}`);
      if (!inflight) return;
      const issued = await inflight;
      if (issued === null || issued === "stopped") return; // the screen's own call handles "stopped"
      subject = issued;
    }
    if (!subject) {
      if (!current()) return;
      const issued = await requestSubject(account, observation);
      if (issued === "stopped") {
        // Ends sharing here only. Never a device erasure: an account-wide deletion must not erase
        // this device's signed-out data (owner decision 61, account data only).
        if (await client.observationCurrent(observation)) {
          // Sharing was on here and the server retired this device's identity for the account:
          // the stop came from elsewhere (this device's own account-wide deletion stops sharing
          // here first, so it never reaches this point). Remembered for the settings page's line.
          await deps.local.set(STOPPED_ELSEWHERE_KEY, { account }).catch(() => undefined);
          await deps.subjects!.onStopped();
        }
        return;
      }
      if (!issued) return;
      subject = issued;
    }
    if (!(await client.observationCurrent(observation)) || !current()) return;
    await client.confirm(subject, { quiet: options.quiet, accountId: account });
  };

  return {
    async identify(userId, options = {}, ask) {
      if (deps.subjects) return identifySubject(userId, options, ask);
      // Without per-device subjects there is no identity to report under: never fall back to the
      // account id (owner decision 50). Stop reporting as anyone else (nobody included) at once;
      // signed-in events wait unattributed, bound to this account, and are dropped if the account
      // is let go of, so they are never reported under the anonymous id or another account either.
      void options;
      if (client.enabled && isAnalyticsId(userId)) await client.holdForAccount(userId, ask);
    },
    async forgetSubjects(reportingAs, account) {
      const named = [wanted?.account, account?.toLowerCase()].filter((a): a is string => !!a);
      wanted = null;
      try {
        const stored = readSubjects(await deps.local.get(SUBJECTS_KEY));
        const accounts = new Set(
          stored
            .filter((s) => named.includes(s.account) || (reportingAs !== null && s.subject === reportingAs))
            .map((s) => s.account),
        );
        if (accounts.size === 0) return;
        await deps.local.set(SUBJECTS_KEY, stored.filter((s) => !accounts.has(s.account)));
      } catch {
        /* best effort: the entry is local, bounded and never sent */
      }
    },
    // With per-device subjects the email is set when the subject is issued, so there is no separate
    // attach: an ordinary screen instead retries a subject request that has not succeeded yet.
    attach: deps.subjects
      ? async () => {
          const asked = wanted;
          if (!asked || client.accountConfirmed || !client.isCurrent(asked.stamp)) return;
          await identifySubject(asked.account, {});
        }
      : attach,
  };
}

export function createExtensionAnalyticsHost(
  deps: ExtensionAnalyticsHostDeps,
): ExtensionAnalyticsHost {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const client = new AnalyticsClient({
    config: deps.config,
    get surface() {
      return deps.surface;
    },
    get device() {
      return deps.device;
    },
    appVersion: deps.appVersion,
    store: deps.local,
    queueStore: deps.queueStore,
    identity: deps.identity,
    consent: () => (stopped ? Promise.resolve(false) : deps.consent()),
    permission: deps.permission
      ? () => (stopped ? Promise.resolve(null) : deps.permission!())
      : undefined,
    privacyPolicy: deps.privacyPolicy,
    envelope: deps.envelope,
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now,
    uuid,
    schedule(run, ms) {
      if (stopped) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopped) run();
      }, ms);
      timers.add(timer);
    },
    // Nobody is attributed until onStart (or a page) confirms the account.
    startsUnconfirmed: true,
  });
  const accounts = createAccountIdentifier({
    client,
    local: deps.local,
    consent: deps.consent,
    identifyOnServer: serverIdentifyFor(deps.envelope, deps.identifyOnServer),
    subjects: deps.subjects,
  });
  const identify = (userId: string, options?: TrackOptions, ask?: number) =>
    accounts.identify(userId, options, ask);
  // Read when the install is reported, not at creation: an extension host may learn its surface
  // from the browser after it starts (Firefox for Android), and consent waits for that answer.
  const blocksAtInstall = () =>
    deps.surface === "chrome" ||
    deps.surface === "firefox" ||
    deps.surface === "firefox-android";
  const isSafari =
    deps.surface === "safari-ios" || deps.surface === "safari-macos";
  // One bounded startup result that activity waits on. Only a start that actually established the
  // account confirms it (client.confirm); a start that never reports, or reports "unknown", leaves
  // the account unconfirmed, so nothing is sent and new events wait unattributed. Elapsed time is
  // never treated as a successful check.
  let startSettled!: () => void;
  const started = new Promise<void>((resolve) => (startSettled = resolve));
  let startResult: Promise<void> | null = null;
  const waitForStart = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (client.accountConfirmed) return Promise.resolve();
    return (startResult ??= new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, START_HOLD_LIMIT_MS);
      timers.add(timer);
      void started.then(() => {
        clearTimeout(timer);
        timers.delete(timer);
        resolve();
      });
    }));
  };
  const requestFlushIfNeeded = async (): Promise<void> => {
    // Nothing a flush could do (a hold waiting for its identity sends nothing): no alarm.
    if (await client.flushWorthwhile()) deps.requestQuietFlush?.();
  };

  const sharing = async (): Promise<UsageSharingState | null> => {
    if (!client.enabled) return null;
    const enabled = await client.canReport();
    const noticeNeeded =
      deps.noticeApplies &&
      (await deps.local.get(NOTICE_KEY).catch(() => true)) !== true;
    return { enabled, noticeNeeded };
  };

  // ── Account-wide erasure ("Delete shared data on all devices") ──
  // Dormant unless per-device subjects are wired too: pages are then answered null and hide it.
  const accountWide = deps.subjects && deps.accountErasure ? deps.accountErasure : null;
  const stoppedElsewhere = async (account: string): Promise<boolean> => {
    const marker = await deps.local.get(STOPPED_ELSEWHERE_KEY).catch(() => null);
    return !!marker && typeof marker === "object" && (marker as Record<string, unknown>).account === account;
  };
  const accountView = async (service: AccountErasureService, account: string): Promise<UiAccountErasureView> => ({
    withdrawal: await service.withdrawal(account),
    stoppedElsewhere: await stoppedElsewhere(account),
  });
  const clearStoppedElsewhere = (): Promise<void> =>
    deps.local.set(STOPPED_ELSEWHERE_KEY, null).catch(() => undefined);

  const handle = async (
    request: PageRequest,
    observation: ReturnType<AnalyticsClient["captureObservation"]>,
  ): Promise<unknown> => {
    if (stopped) return false;
    switch (request.action) {
      case "track": {
        const captured = await observation;
        if (!captured) return false;
        await waitForStart();
        if (!(await client.observationCurrent(captured))) return false;
        await client.trackUnchecked(request.name, request.props, {
          observation: captured,
        });
        // Any use counts toward the day, not only a background start (a worker can live overnight).
        await client.trackDaily(
          "active",
          "active",
          {},
          { observation: captured },
        );
        // A Still screen is an ordinary moment: finish a server email attach that a background
        // start deferred, or that failed earlier. It never changes the account (see attach).
        await accounts.attach(captured);
        // Also the moment to send or follow up a device erasure (never a background start).
        void deps.erasure?.kick();
        return true;
      }
      case "identify":
        // A page reports the signed-in account from its session: that confirms the account.
        await identify(request.userId);
        return true;
      case "reset": {
        // Who this device reports as, read before the reset lets the account go.
        const reportingAs = request.forgetAccount ? client.signedInAs() : null;
        await client.reset({ forgetAccount: request.forgetAccount });
        // A deletion also forgets which per-device subject the account used here.
        if (request.forgetAccount && deps.subjects) await accounts.forgetSubjects(await reportingAs, request.account);
        return true;
      }
      case "sharing":
        return sharing();
      case "setSharing": {
        // The permission that is ending, read before anything changes (device erasure needs its origin).
        const ending =
          !request.enabled && deps.erasure ? await deps.permission?.().catch(() => null) : null;
        client.permissionChanged();
        if (request.enabled && !deps.commitPermission) return false;
        if (deps.commitPermission) await deps.commitPermission(request.enabled);
        else await deps.storeConsent?.(false);
        if (!request.enabled) await client.clearQueue();
        // Only after the local stop: record the durable erasure obligation, then try to send it.
        // This is the person turning sharing off on this device, and only that: an account-wide
        // deletion must never reach this path (owner decision 61, account data only).
        if (ending?.state === "granted" && deps.erasure) {
          // An index that cannot be read is never taken as 0: erase every index the origin could
          // have used (ids it never used match no person, which is harmless).
          const index = await client.erasureIndex(ending.origin);
          if (await deps.erasure.record(ending, index ?? ANON_INDEX_LIMIT)) void deps.erasure.kick();
        }
        if (request.enabled && (await client.canReport())) {
          await client.track("analytics_choice_made", { choice: "share" });
          return true;
        }
        return false;
      }
      case "acknowledgeNotice":
        await deps.local.set(NOTICE_KEY, true).catch(() => undefined);
        return true;
      case "accountErasure": {
        if (!accountWide || !client.enabled) return null;
        const { account } = request;
        switch (request.op) {
          case "state":
            // The settings page asking is an ordinary Still screen (never a background start), and
            // the one place this is shown: resend an unsent request, follow a sent one, then answer.
            // (The track path cannot do it: with sharing off here it records nothing and stops early.)
            await accountWide.kick();
            return accountView(accountWide, account);
          case "start": {
            // 1. The local stop, first and with no network: sharing ends on this device, exactly as
            //    the switch turns it off, but WITHOUT a device erasure (no ledger entry, no device
            //    request). Owner decision 61: an account-wide deletion deletes account data only;
            //    this device's signed-out data stays until sharing is turned off on this device.
            client.permissionChanged();
            try {
              if (deps.commitPermission) await deps.commitPermission(false);
              else await deps.storeConsent?.(false);
            } catch {
              /* verified below */
            }
            await client.clearQueue();
            // The failure line says sharing stays off here, so nothing is sent unless it is off.
            if (await client.canReport()) return null;
            // This device's cached identity for the account goes too (the server retires it).
            await accounts.forgetSubjects(null, account);
            await clearStoppedElsewhere();
            // 2. The request, with this account's own session (a signed-in session is enough, D60).
            return { withdrawal: await accountWide.request(account), stoppedElsewhere: false };
          }
          case "retry":
            await accountWide.retry();
            return accountView(accountWide, account);
          case "acknowledge":
            await accountWide.acknowledge(account);
            if (await stoppedElsewhere(account)) await clearStoppedElsewhere();
            return true;
        }
      }
    }
  };

  return {
    client,
    identify,
    // Folded away in 2.x builds (build-basis.ts).
    ...(USAGE_ON_BY_DEFAULT_BUILD ? { forgetSubjects: (reportingAs: string | null) => accounts.forgetSubjects(reportingAs) } : {}),
    onInstalled(details, observation) {
      if (stopped) return;
      if (details.reason === "install") {
        const capturedAtInstall = observation ?? client.captureObservation();
        const asked = client.stamp();
        void (async () => {
          const captured = await capturedAtInstall;
          if (!captured || !(await client.observationCurrent(captured))) return;
          if (!(await client.canReport()) || !client.isCurrent(asked)) return;
          const id = await deps.identity();
          if (!(await client.canReport()) || !client.isCurrent(asked)) return;
          await client.trackOnce(
            "installed",
            "installed",
            {
              returning: id.returning,
            },
            { observation: captured },
          );
          if (blocksAtInstall())
            await client.trackOnce(
              "setup_completed",
              "setup_completed",
              {},
              { observation: captured },
            );
        })().catch(() => {});
      } else if (
        details.reason === "update" &&
        details.previousVersion !== deps.appVersion
      ) {
        if (!observation) {
          // Preserve the existing synchronous queue admission/order for ordinary callers.
          void client.trackUnchecked("updated", {
            from: details.previousVersion,
            to: deps.appVersion,
          });
          return;
        }
        void observation
          .then(async (captured) => {
            if (
              !captured ||
              stopped ||
              !(await client.observationCurrent(captured))
            )
              return;
            await client.trackUnchecked(
              "updated",
              {
                from: details.previousVersion,
                to: deps.appVersion,
              },
              { observation: captured },
            );
          })
          .catch(() => {});
      }
    },
    onStart(read) {
      if (stopped) return;
      // Reserved before the read settles: anything asked meanwhile (a sign-out, a deletion, another
      // account) supersedes this start, whose read may already be stale.
      // An unknown account (undefined) asks nothing, so it never supersedes a screen's identify.
      const ask = read === undefined ? null : client.reserveAccountAsk();
      void (async () => {
        // A value already known is acted on at once, as before (no extra turn of the event loop).
        const userId =
          read !== null && typeof read === "object" && typeof (read as PromiseLike<unknown>).then === "function"
            ? await Promise.resolve(read).catch(() => undefined)
            : (read as string | null | undefined);
        if (stopped || (ask !== null && !client.isLatestAsk(ask))) {
          // Superseded: the later ask decides the account. Nothing about it changes here.
        } else if (userId) {
          await identify(userId, QUIET, ask ?? undefined);
        } else if (userId === null) {
          // The account is gone (signed out elsewhere, deleted, expired). Its waiting events go with
          // it: if it was deleted, sending them would recreate the person the server just removed.
          const reportingAs = deps.subjects ? client.signedInAs() : null;
          await client.confirm(null, { forget: true, quiet: true });
          // Its cached per-device subject too (harmless if it was only a sign-out: the server
          // answers the same subject when that account signs in here again).
          if (deps.subjects) await accounts.forgetSubjects(await reportingAs);
        }
        // undefined: the account could not be read. It stays unconfirmed.
        await requestFlushIfNeeded();
      })()
        .catch(() => {})
        .finally(() => startSettled());
    },
    onActivity(observation = client.captureObservation()) {
      if (stopped) return;
      void (async () => {
        const captured = await observation;
        if (!captured) return;
        await waitForStart();
        if (!(await client.observationCurrent(captured))) return;
        // A running Safari extension is the only proof on iPhone that it was switched on.
        if (isSafari) {
          await client.trackOnce(
            "extension_enabled",
            "setup_step",
            { step: "extension_enabled" },
            { ...QUIET, observation: captured },
          );
          await client.trackOnce(
            "setup_completed",
            "setup_completed",
            {},
            { ...QUIET, observation: captured },
          );
        }
        await client.trackDaily(
          "active",
          "active",
          {},
          { ...QUIET, observation: captured },
        );
        await requestFlushIfNeeded();
      })().catch(() => {});
    },
    async flushWhenReady() {
      if (stopped) return;
      await waitForStart();
      await client.flush();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      client.permissionChanged();
      startSettled();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      void client.clearQueue(false).catch(() => {});
    },
    listener(message, sender, sendResponse, observation) {
      if (stopped) return false;
      if (typeof message !== "object" || message === null) return false;
      const m = message as Record<string, unknown>;
      if (m.kind !== ANALYTICS_MESSAGE_KIND || !deps.isTrustedPage(sender))
        return false;
      if (
        sender.incognito === true ||
        (sender.tab &&
          typeof sender.tab === "object" &&
          (sender.tab as { incognito?: unknown }).incognito === true)
      )
        return false;
      const request = parsePageRequest(m);
      if (!request) return false;
      if (
        (request.action === "setSharing" && !request.enabled) ||
        (request.action === "accountErasure" && request.op === "start" && accountWide)
      ) {
        client.permissionChanged();
        void client.clearQueue();
      }
      void handle(request, observation ?? client.captureObservation())
        .then(sendResponse, () => sendResponse(null))
        .catch(() => {});
      return true;
    },
  };
}

function parsePageRequest(m: Record<string, unknown>): PageRequest | null {
  switch (m.action) {
    case "track": {
      const event = canonicalEvent(m.name, m.props);
      return event && isAppClientEvent(event.name)
        ? { action: "track", name: event.name, props: event.props }
        : null;
    }
    case "identify":
      return typeof m.userId === "string"
        ? { action: "identify", userId: m.userId }
        : null;
    case "setSharing":
      return typeof m.enabled === "boolean"
        ? { action: "setSharing", enabled: m.enabled }
        : null;
    case "reset":
      return {
        action: "reset",
        forgetAccount: m.forgetAccount === true,
        ...(isAnalyticsId(m.account) ? { account: m.account.toLowerCase() } : {}),
      };
    case "sharing":
    case "acknowledgeNotice":
      return { action: m.action };
    case "accountErasure":
      return (m.op === "state" || m.op === "start" || m.op === "retry" || m.op === "acknowledge") &&
        isAnalyticsId(m.account)
        ? { action: "accountErasure", op: m.op, account: m.account.toLowerCase() }
        : null;
    default:
      return null;
  }
}

const WITHDRAWALS: readonly ErasureWithdrawal[] = ["none", "requested", "verifying", "deleted", "failed"];

function readAccountView(value: unknown): UiAccountErasureView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return WITHDRAWALS.includes(v.withdrawal as ErasureWithdrawal) && typeof v.stoppedElsewhere === "boolean"
    ? { withdrawal: v.withdrawal as ErasureWithdrawal, stoppedElsewhere: v.stoppedElsewhere }
    : null;
}

// ── Popup / options pages ─────────────────────────────────────────────────────────────────────

export type AnalyticsSend = (
  message: Record<string, unknown>,
) => Promise<unknown>;

export interface PageAnalyticsOptions {
  /** Transport to the background (runtime.sendMessage with ANALYTICS_MESSAGE_KIND added). */
  readonly send: AnalyticsSend;
  /** Where the page itself must change consent inside the tap (Firefox's permission prompt).
   * Resolves once the change is made or declined. */
  readonly changeConsent?: (enabled: boolean) => Promise<unknown>;
  /** False where this page shows no switch (the Safari popup: the Apple app owns it). */
  readonly showsSwitch?: boolean;
}

/** The page side of UiAnalytics: every call is a message to the background's client. */
export function createPageAnalytics(
  options: PageAnalyticsOptions,
): UiAnalytics {
  const { send } = options;
  const fire = (message: Record<string, unknown>): void => {
    void send(message).catch(() => {});
  };
  const page: UiAnalytics = {
    track: (name, props) => fire({ action: "track", name, props }),
    identify: (userId) => fire({ action: "identify", userId }),
    // Resolves once the background has let go of the account (deletion waits for it).
    reset: (options) =>
      send({
        action: "reset",
        forgetAccount: options?.forgetAccount === true,
        ...(options?.forgetAccount === true && options.account ? { account: options.account } : {}),
      }).then(
        () => undefined,
        () => undefined,
      ),
    acknowledgeNotice: () => fire({ action: "acknowledgeNotice" }),
  };
  if (options.showsSwitch === false) return page;
  return {
    ...page,
    async sharing() {
      const state = await send({ action: "sharing" }).catch(() => null);
      if (typeof state !== "object" || state === null) return null;
      const { enabled, noticeNeeded } = state as Record<string, unknown>;
      return typeof enabled === "boolean"
        ? { enabled, noticeNeeded: noticeNeeded === true }
        : null;
    },
    setSharing(enabled) {
      // Called synchronously from the tap: a permission prompt here still has the user gesture.
      const change = options.changeConsent
        ? options.changeConsent(enabled).catch(() => undefined)
        : Promise.resolve();
      return change.then(async () => {
        const result = await send({ action: "setSharing", enabled }).catch(
          () => null,
        );
        return typeof result === "boolean" ? result : !enabled;
      });
    },
    // Null from the background means the action is not offered in this build (dormant).
    accountErasure: {
      state: (account) =>
        send({ action: "accountErasure", op: "state", account }).then(readAccountView, () => null),
      start(account) {
        // Called synchronously from the confirming tap: where the page itself owns consent
        // (Firefox's permission), it is removed here first, inside the gesture. The background then
        // completes the local stop and checks it before anything is sent.
        const change = options.changeConsent
          ? options.changeConsent(false).catch(() => undefined)
          : Promise.resolve();
        return change.then(() =>
          send({ action: "accountErasure", op: "start", account }).then(readAccountView, () => null),
        );
      },
      retry: (account) =>
        send({ action: "accountErasure", op: "retry", account }).then(readAccountView, () => null),
      acknowledge: (account) =>
        send({ action: "accountErasure", op: "acknowledge", account }).then(
          () => undefined,
          () => undefined,
        ),
    },
  };
}
