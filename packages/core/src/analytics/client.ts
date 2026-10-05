import {
  isDeviceClass,
  isVersion,
  storeForSurface,
  validateEvent,
  canonicalEvent,
  isAppClientEvent,
  ANALYTICS_SURFACES,
  ANALYTICS_OS,
  ANALYTICS_BUILD_CHANNELS,
  ANALYTICS_PLANS,
  type AnalyticsEventName,
  type AnalyticsEventProps,
  type AnalyticsDevice,
  type AnalyticsSurface,
} from "./events.js";
import {
  isAnalyticsId,
  type AnalyticsIdentity,
  type AnalyticsKeyValue,
} from "./identity.js";
import {
  privacyPolicyReady,
  readAnalyticsPermission,
  samePermission,
  type AnalyticsPermission,
  type AnalyticsPrivacyPolicy,
} from "./consent.js";
import { ANON_INDEX_LIMIT, deriveAnonymousId } from "./derive.js";

// Still's own PostHog client. It exists instead of posthog-js for three reasons:
//
//   * Browser-extension stores refuse remotely hosted code, and posthog-js loads parts of itself
//     (the recorder, surveys, the toolbar) from PostHog's servers at runtime.
//   * posthog-js records pages automatically. Still runs next to YouTube and Instagram, so an SDK
//     that captures page views by default is the wrong starting point for a product that promises
//     never to record browsing history.
//   * It has to run in an MV3 service worker, which has no DOM and no localStorage.
//
// So this client does one thing: it queues events from the fixed schema in `events.ts`, persists the
// queue so a sleeping worker or a closed popup loses nothing, and posts batches to PostHog's
// `/batch/` endpoint. Nothing is queued or sent while the person has analytics turned off, and an
// unconfigured build (no key) sends nothing at all.
//
// One operation chain owns queue/account writes. Request-time stamps and abort signals fence
// asynchronous work immediately when permission or the confirmed account changes. A failed
// cross-store purge remains durable debt until the raw queue is verifiably empty, including after
// restart. No request leaves before the host confirms the account; timeouts are never confirmation.
//
// Fresh combined permission and all required capability evidence gate observation, identity,
// admission, optional email attach and transport. Each permission origin owns independent provider
// IDs; functional installation/shared-anchor IDs are never merged into provider history. Earlier
// account generations stay ineligible even if the same account returns. Pre-consent history,
// arbitrary person updates, aliases and farewell events are never emitted.

export const STATE_KEY = "still:analytics:state";
export const QUEUE_KEY = "still:analytics:queue";
/** Oldest events are dropped beyond this, so an install that is offline for weeks stays small. */
export const MAX_QUEUE = 300;
/** Events per request. */
export const BATCH_SIZE = 50;
/** How long after the last event to wait before sending, so a burst goes out as one request. */
export const FLUSH_DELAY_MS = 1_500;
/** Longest one request may take; a stuck network must never hold the queue. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Late-arrival fence: an event older than this when its send comes is dropped, never sent. An
 * offline device must not deliver history after a deletion could have run (U5-W2). */
export const MAX_EVENT_AGE_MS = 30 * 86_400_000;

export interface AnalyticsConfig {
  /** PostHog project API key (public by design: it can only send events). */
  readonly key?: string;
  /** PostHog ingestion host, e.g. https://us.i.posthog.com. */
  readonly host?: string;
}

export interface AnalyticsClientDeps {
  readonly config: AnalyticsConfig;
  readonly surface: AnalyticsSurface;
  /** Phone, tablet or desktop. A value that is not one of those is not sent. */
  readonly device?: AnalyticsDevice;
  readonly appVersion: string;
  /** Where the account, markers and anonymous id persist (small, rarely written). */
  readonly store: AnalyticsKeyValue;
  /** Where queued events wait. Defaults to `store`. The browser extensions pass IndexedDB storage
   * private to the background (idb.ts), so the pages Still runs on never receive storage-change
   * broadcasts carrying the queue. */
  readonly queueStore?: AnalyticsKeyValue;
  /** This install's ids (see identity.ts). Read for every event, so a host can change them
   * (the Safari extension follows the app's record); hosts cache it themselves. */
  readonly identity: () => Promise<AnalyticsIdentity>;
  /** Whether this person currently allows analytics. Checked on every track and flush. */
  readonly consent: () => Promise<boolean>;
  /** Fresh combined permission from the same per-device authority. Legacy boolean On is insufficient. */
  readonly permission?: () => Promise<unknown>;
  /** Actual approved disclosure/capability evidence. Missing evidence holds optional collection. */
  readonly privacyPolicy?: AnalyticsPrivacyPolicy;
  /** Packaged/proven context only. No user-agent, geometry or provider-boolean inference. */
  readonly envelope?: {
    readonly os?: (typeof ANALYTICS_OS)[number];
    readonly build_channel?: (typeof ANALYTICS_BUILD_CHANNELS)[number];
    readonly rule_version?: string;
    readonly plan?: (typeof ANALYTICS_PLANS)[number];
  };
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly uuid: () => string;
  /** Timer seam; defaults to setTimeout. */
  readonly schedule?: (run: () => void, ms: number) => void;
  /**
   * Start with the account unconfirmed (the extension and Apple hosts): until the host calls
   * `confirm`, events are queued without a person and nothing is sent (rules 2 and 4 above).
   */
  readonly startsUnconfirmed?: boolean;
}

interface QueuedEvent {
  readonly event: string;
  readonly uuid: string;
  readonly timestamp: string;
  readonly properties: Record<string, unknown>;
  /**
   * Recorded before the host confirmed who is signed in: no person yet. The confirmation gives it
   * one, in storage, before it can ever be sent (rule 2). Never sent while set.
   */
  readonly attributeLater?: boolean;
  /** Private admission authority; never included in the provider envelope. */
  readonly permission?: AnalyticsPermission;
  readonly accountGeneration?: number;
}

interface ClientState {
  /** The signed-in account this install currently reports as, or null. */
  readonly userId: string | null;
  /** Legacy alias marker, cleared during migration and never emitted. */
  readonly identifiedAs: string | null;
  /** Marker → local calendar day it last fired, for once-a-day events; `once:` markers → "done". */
  readonly daily: Readonly<Record<string, string>>;
  /** The anonymous id after a sign-out: a new id per sign-out, so the device is never attributed
   * to the person who signed out. Derived from the permission origin at `anonIndex` (derive.ts), so
   * the device can always name every anonymous id it used when it asks for erasure. */
  readonly anonId: string | null;
  /** Index of `anonId` under the current permission origin: 0 at Share, +1 per sign-out. */
  readonly anonIndex: number;
  /** The account behind the confirmed provider identity, when the host named it. Never sent: a
   * queued event whose person is this account id is refused at send. */
  readonly accountRef: string | null;
  /** Accounts that were forgotten (deleted) whose waiting events have not yet verifiably been
   * dropped. Recorded before the drop, in the state store, because the queue lives in a different
   * store (IndexedDB in the extensions) that can refuse a write on its own; nothing is sent while
   * this is non-empty (rule 2). */
  readonly forgotten: readonly string[];
  readonly permission: AnalyticsPermission | null;
  readonly stopPending: boolean;
  readonly accountGeneration: number;
  readonly stoppedOrigin: string | null;
}

const EMPTY_STATE: ClientState = {
  userId: null,
  identifiedAs: null,
  daily: {},
  anonId: null,
  anonIndex: 0,
  accountRef: null,
  forgotten: [],
  permission: null,
  stopPending: false,
  accountGeneration: 0,
  stoppedOrigin: null,
};

function parseState(value: unknown): ClientState {
  if (typeof value !== "object" || value === null) return EMPTY_STATE;
  const v = value as Record<string, unknown>;
  return {
    userId: typeof v.userId === "string" ? v.userId : null,
    identifiedAs: typeof v.identifiedAs === "string" ? v.identifiedAs : null,
    daily: typeof v.daily === "object" && v.daily !== null ? (v.daily as Record<string, string>) : {},
    anonId: typeof v.anonId === "string" ? v.anonId : null,
    anonIndex:
      Number.isSafeInteger(v.anonIndex) && (v.anonIndex as number) >= 0 && (v.anonIndex as number) <= ANON_INDEX_LIMIT
        ? (v.anonIndex as number)
        : 0,
    accountRef: isAnalyticsId(v.accountRef) ? v.accountRef : null,
    forgotten: Array.isArray(v.forgotten) ? v.forgotten.filter((id): id is string => typeof id === "string") : [],
    permission: readAnalyticsPermission(v.permission),
    stopPending: v.stopPending === true,
    stoppedOrigin: isAnalyticsId(v.stoppedOrigin) ? v.stoppedOrigin : null,
    accountGeneration:
      Number.isSafeInteger(v.accountGeneration) && (v.accountGeneration as number) >= 0
        ? (v.accountGeneration as number)
        : 0,
  };
}

function parseQueue(value: unknown): QueuedEvent[] {
  return Array.isArray(value)
    ? value
        .slice(-MAX_QUEUE)
        .filter(
          (v): v is QueuedEvent =>
            v !== null &&
            typeof v === "object" &&
            !Array.isArray(v) &&
            typeof v.event === "string" &&
            typeof v.uuid === "string" &&
            typeof v.timestamp === "string" &&
            v.properties !== null &&
            typeof v.properties === "object" &&
            !Array.isArray(v.properties),
        )
    : [];
}

/** True when a build carries a usable PostHog configuration. */
export function analyticsConfigured(config: AnalyticsConfig): boolean {
  const key = config.key?.trim();
  const host = config.host?.trim();
  if (!key || !host) return false;
  try {
    return new URL(host).protocol === "https:";
  } catch {
    return false;
  }
}

/** The person's local calendar day, `YYYY-MM-DD`. */
function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * How an event is recorded.
 *
 * `quiet` is for events that happen when a background wakes, which is usually because the person
 * just opened YouTube, Instagram, Facebook or TikTok. A precise timestamp, or sending right then,
 * would say when they visited one of those sites. So a quiet event carries only its local day
 * (midnight), and it does not trigger a send: it waits for the next ordinary send (the person opening
 * Still) or the host's randomly timed flush.
 *
 * Legacy `at` input is ignored: an earlier pre-consent action cannot be reconstructed.
 */
export interface TrackOptions {
  readonly quiet?: boolean;
  readonly at?: number;
  /** Derived work retains the permission and account that observed the originating action. */
  readonly observation?: AnalyticsObservation;
}

export interface AnalyticsObservation {
  readonly stamp: { readonly generation: number; readonly epoch: number };
  readonly permission: AnalyticsPermission;
}

/** Local midnight of the day containing `ms`, as an ISO timestamp. */
function localMidnightIso(ms: number): string {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

/** Who the host has established is signed in: an account id, or nobody. */
export type ConfirmedAccount = string | null;

interface Confirmation {
  readonly account: ConfirmedAccount;
  readonly options: ConfirmOptions;
}

export interface ConfirmOptions {
  /** The account that was signed in has gone (deleted, or its session ended elsewhere): abandon
   * any send under it and drop the events waiting under it, so nothing recreates a person the
   * server deleted. */
  readonly forget?: boolean;
  /** A background start: do not send now (see TrackOptions.quiet). */
  readonly quiet?: boolean;
  /** The account UUID behind a confirmed per-device subject (U5-W2). Never sent: a confirmation
   * whose identity equals it is refused, and so is any queued event attributed to it. */
  readonly accountId?: string;
}

export class AnalyticsClient {
  private readonly configured: boolean;
  private chain: Promise<unknown> = Promise.resolve();
  private flushScheduled = false;
  /** Bumped synchronously whenever sharing is switched off or an account is forgotten, so a flush
   * in progress stops before its next request and one still waiting its turn never starts (rule
   * 1's only exception). */
  private epoch = 0;
  /** Bumped when the host asks to confirm a different account than it last asked for, even if
   * storage later refuses it. Work that waits outside the client (the server attach) must not act
   * on an earlier confirmation; asking for the same account again changes nothing it relies on. */
  private generation = 0;
  private lastAsked: ConfirmedAccount | undefined;
  /** Rule 4. Only \`confirm\` sets it, and only after installing the account (rule 3). */
  private confirmed: boolean;
  /** Latest ask to reach the operation chain, retained until installation AND attribution succeed. */
  private pending: Confirmation | null = null;
  /** A newer account answer cannot replace a forget that has not reached durable state yet. */
  private forgetPending = false;
  /** The request in flight, so switching sharing off can abandon it instead of waiting. */
  private inflight: AbortController | null = null;
  /** Set when an account change could not be saved: reporting stops for the life of this client
   * rather than risk sending under an account that should have been let go. */
  private blocked = false;
  private permission: AnalyticsPermission | null = null;
  private scopeAbort = new AbortController();

  constructor(private readonly deps: AnalyticsClientDeps) {
    // A malformed version (for example from a bad native reply) would ride along on every event;
    // refuse to run rather than send it.
    this.configured =
      analyticsConfigured(deps.config) &&
      isVersion(deps.appVersion) &&
      (ANALYTICS_SURFACES as readonly string[]).includes(deps.surface);
    this.confirmed = !deps.startsUnconfirmed;
  }

  get enabled(): boolean {
    return this.configured;
  }

  get accountConfirmed(): boolean {
    return this.confirmed;
  }

  // ── Recording ────────────────────────────────────────────────────────────────────────────────

  /** Queue one event. Invalid events and events while analytics is off are dropped silently. */
  track<E extends AnalyticsEventName>(
    name: E,
    props: AnalyticsEventProps<E>,
    options: TrackOptions = {},
  ): Promise<void> {
    return this.trackUnchecked(name, props, options);
  }

  /** `track` for input that arrived untyped (a runtime message); validated the same way. */
  trackUnchecked(
    name: unknown,
    props: unknown,
    options: TrackOptions = {},
  ): Promise<void> {
    const requested = options.observation?.stamp ?? this.stamp();
    const admission = options.observation
      ? Promise.resolve(options.observation.permission)
      : this.readPermission();
    const event = canonicalEvent(name, props);
    return this.run(async () => {
      const permission = await admission;
      if (
        !event ||
        !isAppClientEvent(event.name) ||
        !permission ||
        !this.isCurrent(requested) ||
        !(await this.allowed(permission))
      )
        return;
      await this.enqueue(
        event.name,
        event.props,
        options,
        requested,
        permission,
      );
    });
  }

  /** Queue an event at most once per local calendar day for `marker`. */
  trackDaily<E extends AnalyticsEventName>(
    marker: string,
    name: E,
    props: AnalyticsEventProps<E>,
    options: TrackOptions = {},
  ): Promise<void> {
    return this.trackMarked(
      marker,
      localDay(this.deps.now()),
      name,
      props,
      options,
    );
  }

  /** Queue an event once in the life of this install for `marker` (setup milestones). */
  trackOnce<E extends AnalyticsEventName>(
    marker: string,
    name: E,
    props: AnalyticsEventProps<E>,
    options: TrackOptions = {},
  ): Promise<void> {
    return this.trackMarked(`once:${marker}`, "done", name, props, options);
  }

  /** Whether a once-marker has already fired (a host deciding whether to keep a pending record).
   * Unreadable state answers no, so the host keeps its record and asks again later. */
  hasTrackedOnce(marker: string): Promise<boolean> {
    return this.run(
      async () => (await this.read())?.daily[`once:${marker}`] !== undefined,
    );
  }

  /** How many events are waiting (a host deciding whether a later flush is needed). */
  queuedCount(): Promise<number> {
    return this.run(async () => (await this.readQueue()).length);
  }

  // ── The account (rule 3) ─────────────────────────────────────────────────────────────────────

  /**
   * The host has established who is signed in (`userId`), or that nobody is (`null`). In one
   * operation: install that account (or let the previous one go, with a fresh anonymous id), drop
   * what a forgotten account still owns, give every waiting unattributed event its person, then
   * mark the account confirmed and, unless quiet, send what is waiting. Undone only by a later
   * confirmation that cannot be installed: then nothing is attributed or sent until one succeeds.
   *
   * With `forget`, the account is fenced the moment this is called, before anything waits its turn:
   * the request in flight is abandoned and every flush asked for before now sends nothing, so
   * nothing under the account can leave from here on, even if the host stops waiting for this
   * (account deletion waits a bounded time) and the server deletes the person meanwhile.
   */
  confirm(
    account: ConfirmedAccount,
    options: ConfirmOptions = {},
  ): Promise<void> {
    if (!this.configured || (account !== null && !isAnalyticsId(account)))
      return Promise.resolve();
    // A per-device subject is never the account id (owner decision 50).
    if (
      account !== null &&
      options.accountId !== undefined &&
      (!isAnalyticsId(options.accountId) || account.toLowerCase() === options.accountId.toLowerCase())
    )
      return Promise.resolve();
    if (options.forget) this.cancel();
    if (account !== this.lastAsked) {
      this.cancel();
      this.generation += 1;
      this.lastAsked = account;
    }
    this.confirmed = false;
    return this.run(async () => {
      this.confirmed = false;
      this.pending = { account, options };
      this.forgetPending ||= options.forget === true;
      await this.establish();
    });
  }

  /** The body of a confirmation; also how `flush` retries the host's latest ask (`retrying`). */
  private async establish(retrying = false): Promise<void> {
    if (!this.pending) return;
    const { account, options } = this.pending;
    if (!options.forget && !(await this.allowed())) return;
    if (this.forgetPending) {
      // Persist the old account's drop before installing any newer account. Once recorded, the
      // existing durable `forgotten` list owns recovery, including after a restart.
      if (!(await this.installAccount(null, { forget: true }))) return;
      this.forgetPending = false;
    }
    if (!(await this.installAccount(account, options))) return;
    await this.dropForgotten(); // tried here; `flush` is the gate that refuses to send until it is done
    if (!(await this.allowed())) return;
    if (!(await this.attributeWaiting())) return;
    this.pending = null;
    this.confirmed = true;
    if (!retrying && !options.quiet && (await this.readQueue()).length > 0) this.scheduleFlush();
  }

  /**
   * The host knows who is signed in has changed but cannot name the provider identity yet (a
   * per-device subject not issued yet): stop attributing to the previous identity at once. Work
   * asked before now is fenced, nothing is sent, and waiting events stay unattributed until a
   * later `confirm`.
   */
  withdrawConfirmation(): Promise<void> {
    this.cancel();
    this.generation += 1;
    this.lastAsked = undefined;
    this.confirmed = false;
    return this.run(async () => {
      this.confirmed = false;
      this.pending = null;
    });
  }

  /** A sign-in: shorthand for `confirm(userId)`. */
  identify(userId: string, options: TrackOptions = {}): Promise<void> {
    return this.confirm(userId, { quiet: options.quiet });
  }

  /** A sign-out (or, with `forgetAccount`, an account deletion): shorthand for `confirm(null)`. */
  reset(options: { readonly forgetAccount?: boolean } = {}): Promise<void> {
    return this.confirm(null, { forget: options.forgetAccount });
  }

  /** The account this install reports as, or null (also when the state cannot be read: work that
   * needs the account, such as the server attach, then does nothing). */
  signedInAs(): Promise<string | null> {
    return this.run(async () => (await this.read())?.userId ?? null);
  }

  /** For the device-erasure service only, never the envelope: the last anonymous id index used
   * under `origin`, or null when this client's state belongs to another origin or is unreadable. */
  erasureIndex(origin: string): Promise<number | null> {
    return this.run(async () => {
      const state = await this.read();
      if (!state) return null;
      return state.permission?.origin === origin || state.stoppedOrigin === origin ? state.anonIndex : null;
    });
  }

  /** A snapshot of the account generation and consent epoch, for work that waits and then acts. */
  stamp(): { readonly generation: number; readonly epoch: number } {
    return { generation: this.generation, epoch: this.epoch };
  }

  /** Whether nothing about the account or sharing has changed since `stamp`. */
  isCurrent(stamp: {
    readonly generation: number;
    readonly epoch: number;
  }): boolean {
    return stamp.generation === this.generation && stamp.epoch === this.epoch;
  }

  /** Optional server work shares the same synchronous revocation/account fence as batching. */
  cancellationSignal(): AbortSignal {
    return this.scopeAbort.signal;
  }

  // ── Sending ──────────────────────────────────────────────────────────────────────────────────

  /** Capture eligibility at observation time, before any native/startup wait. */
  async captureObservation(): Promise<{
    readonly stamp: ReturnType<AnalyticsClient["stamp"]>;
    readonly permission: AnalyticsPermission;
  } | null> {
    const stamp = this.stamp();
    const permission = await this.readPermission();
    return permission && this.isCurrent(stamp) ? { stamp, permission } : null;
  }
  async observationCurrent(
    observation: Awaited<ReturnType<AnalyticsClient["captureObservation"]>>,
  ): Promise<boolean> {
    return (
      !!observation &&
      this.isCurrent(observation.stamp) &&
      samePermission(observation.permission, await this.readPermission()) &&
      this.isCurrent(observation.stamp)
    );
  }

  /** Send what is queued, once the account is confirmed. Keeps events on a network or server
   * failure so the next flush retries them, with the person they were given. */
  flush(observation?: AnalyticsObservation): Promise<void> {
    // The epoch this flush was asked under. A cancellation between now and its turn (an account
    // forgotten, sharing switched off) means it must send nothing when it runs (rule 1).
    const epoch = observation?.stamp.epoch ?? this.epoch;
    return this.run(async () => {
      if (
        epoch !== this.epoch ||
        (observation && !this.isCurrent(observation.stamp))
      )
        return; // cancelled work must not change attribution either
      // A confirmation that failed on storage is tried again here, so reporting resumes on its own
      // once the store recovers, without waiting for the host to confirm again (rule 3).
      if (!this.confirmed) await this.establish(true);
      if (!this.confirmed || epoch !== this.epoch) return; // rule 4; rule 1
      if (!(await this.dropForgotten())) return; // rule 2: a forgotten account's events never leave
      for (;;) {
        if (!(await this.allowed(observation?.permission))) return;
        const state = await this.read();
        if (!state) return;
        const queue = await this.retireObsolete(state.accountGeneration);
        if (!queue || epoch !== this.epoch) return;
        const batch = queue
          .filter(
            (e) =>
              !e.attributeLater &&
              e.accountGeneration === state.accountGeneration &&
              samePermission(e.permission ?? null, this.permission),
          )
          .slice(0, BATCH_SIZE);
        if (batch.length === 0) return;
        // Sharing is re-read immediately before every request; `post` re-checks cancellation.
        if (!(await this.allowed())) return;
        if ((await this.post(batch, epoch)) === "retry") return;
        // Sent, or rejected as malformed (retrying a 400 forever would block the queue).
        const sent = new Set(batch.map((e) => e.uuid));
        // Storage that will not take the write would hand back the same batch forever.
        const remaining = await this.loadQueue();
        if (remaining === null || !(await this.writeQueue(remaining.filter((e) => !sent.has(e.uuid))))) return;
        if ((await this.readQueue()).some((e) => sent.has(e.uuid))) return;
      }
    });
  }

  /** Drop everything waiting to be sent: the person turned analytics off. */
  clearQueue(retireOrigin = true): Promise<void> {
    this.cancel();
    return this.run(() => this.discardQueue(retireOrigin));
  }

  /** A choice/context change fences already waiting work synchronously, before persistence. */
  permissionChanged(): void {
    this.cancel();
    this.permission = null;
  }

  /** Existing trusted server-attach seam uses the same permission/capability boundary. */
  canReport(): Promise<boolean> {
    return this.run(() => this.allowed());
  }

  /** Compatibility with older hosts: withdrawal only stops and clears, with no farewell. */
  sendOptOut(_timeoutMs = 3_000): Promise<void> {
    // Compatibility with old hosts: stop and clear only; withdrawal never authorizes a farewell.
    return this.clearQueue();
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Synchronous: stop a running flush before its next request, abandon its request, and fence
   * every flush and opt-out asked for before this moment (they check the epoch at their turn). */
  private cancel(): void {
    this.epoch += 1;
    this.inflight?.abort();
    this.scopeAbort.abort();
    this.scopeAbort = new AbortController();
  }

  private trackMarked<E extends AnalyticsEventName>(
    marker: string,
    value: string,
    name: E,
    props: AnalyticsEventProps<E>,
    options: TrackOptions,
  ): Promise<void> {
    const requested = options.observation?.stamp ?? this.stamp();
    const admission = options.observation
      ? Promise.resolve(options.observation.permission)
      : this.readPermission();
    const event = canonicalEvent(name, props);
    return this.run(async () => {
      const permission = await admission;
      if (
        !event ||
        !isAppClientEvent(event.name) ||
        !permission ||
        !this.isCurrent(requested) ||
        !(await this.allowed(permission))
      )
        return;
      const state = await this.read();
      if (!state || state.daily[marker] === value) return;
      // The event first, the marker only once it is safely queued: a marker must never stand for
      // an event that was lost, and a host clears its own record (a pending install) on the marker.
      if (
        !(await this.enqueue(
          event.name,
          event.props,
          options,
          requested,
          permission,
        ))
      )
        return;
      // Re-read rather than overwrite newer lifecycle or erasure state with the marker snapshot.
      const latest = await this.read();
      if (latest && this.isCurrent(requested) && (await this.allowed(permission)))
        await this.write({
          ...latest,
          daily: { ...latest.daily, [marker]: value },
        });
    });
  }

  /** Install the account named by a confirmation. False when the change could not be saved. A
   * forgotten account is recorded as such here, durably, before its events are dropped
   * (`dropForgotten`), so the drop is owed even if this process ends first. */
  private async installAccount(
    account: ConfirmedAccount,
    options: ConfirmOptions,
  ): Promise<boolean> {
    const state = await this.read();
    // Who is signed in cannot be known: nothing changes, the confirmation stands withdrawn, and the
    // ask (a forget included: its sends are already fenced) is tried again before the next send.
    if (!state) return false;
    if (state.userId !== account && state.accountGeneration === Number.MAX_SAFE_INTEGER) {
      this.blocked = true;
      return false;
    }
    if (account !== null) {
      const accountRef = options.accountId?.toLowerCase() ?? null;
      if (state.userId === account && state.accountRef === accountRef) return true;
      const saved = await this.saveAccount({
        ...state,
        userId: account,
        accountRef,
        identifiedAs: null,
        accountGeneration: state.userId === account ? state.accountGeneration : state.accountGeneration + 1,
      });
      if (!saved) this.blocked = true;
      return saved;
    }
    if (state.userId === null) return true; // nobody, as before: keep the same anonymous id
    const forgotten =
      options.forget && !state.forgotten.includes(state.userId) ? [...state.forgotten, state.userId] : state.forgotten;
    // The next derived anonymous id under this permission's origin. Past the last index the
    // device stops reporting rather than reuse or invent an id it could not later erase.
    const anonIndex = state.permission ? state.anonIndex + 1 : 0;
    if (anonIndex > ANON_INDEX_LIMIT) {
      this.blocked = true;
      if (options.forget) await this.dropEventsOf(new Set(forgotten));
      return false;
    }
    let anonId: string | null;
    try {
      anonId = state.permission ? await deriveAnonymousId(state.permission.origin, anonIndex) : null;
    } catch {
      this.blocked = true;
      return false;
    }
    const saved = await this.saveAccount({
      ...state,
      userId: null,
      accountRef: null,
      identifiedAs: null,
      anonId,
      anonIndex,
      forgotten,
      accountGeneration: state.accountGeneration + 1,
    });
    if (!saved) {
      this.blocked = true;
      // The forget could not be recorded, so drop what can be dropped now: this process sends
      // nothing more, and the next one should find as little of the account as possible.
      if (options.forget) await this.dropEventsOf(new Set(forgotten));
    }
    return saved;
  }

  /**
   * Drop every event still attributed to a forgotten account, and verify the queue no longer holds
   * one, before anything may be sent (rule 2). False when the queue store refuses to give up the
   * events or to be read: the accounts stay recorded as forgotten and this runs again at the next
   * confirmation or flush, in this process or the next, and nothing is sent until it succeeds.
   */
  private async dropForgotten(): Promise<boolean> {
    const state = await this.read();
    if (!state) return false; // what is owed cannot be known: nothing leaves
    if (state.forgotten.length === 0) return true;
    if (!(await this.dropEventsOf(new Set(state.forgotten)))) return false;
    // Verified gone. If this write fails the drop simply runs again later and finds nothing.
    await this.write({ ...state, forgotten: [] });
    return true;
  }

  /** An acknowledged write is insufficient when storage silently fails to retain it. */
  private async saveAccount(next: ClientState): Promise<boolean> {
    if (!(await this.write(next))) return false;
    const stored = await this.read();
    return (
      !!stored &&
      stored.userId === next.userId &&
      stored.accountRef === next.accountRef &&
      stored.accountGeneration === next.accountGeneration &&
      stored.anonId === next.anonId &&
      stored.anonIndex === next.anonIndex &&
      stored.stoppedOrigin === next.stoppedOrigin &&
      JSON.stringify(stored.forgotten) === JSON.stringify(next.forgotten)
    );
  }

  /** Drop every queued event attributed to one of `gone`, and verify it. False when the queue store
   * refuses to give up the events or to be read (a refused read must not count as "nothing left"). */
  private async dropEventsOf(gone: ReadonlySet<string>): Promise<boolean> {
    const keep = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const e = value as Record<string, unknown>;
      if (
        !e.properties ||
        typeof e.properties !== "object" ||
        Array.isArray(e.properties)
      )
        return false;
      const id = (e.properties as Record<string, unknown>).distinct_id;
      if (isAnalyticsId(id)) return !gone.has(id);
      // Keep classifiable unconfirmed work; malformed ownership is never proof of erasure.
      return e.attributeLater === true && parseQueue([value]).length === 1;
    };
    const queue = await this.loadRawQueue();
    if (queue === null) return false;
    if (
      queue.some((e) => !keep(e)) &&
      !(await this.writeQueue(queue.filter(keep)))
    )
      return false;
    const remaining = await this.loadRawQueue();
    return remaining !== null && remaining.every(keep);
  }

  /** Already-attributed events cannot acquire a later account; verify their durable retirement. */
  private async retireObsolete(
    generation: number,
  ): Promise<QueuedEvent[] | null> {
    const queue = await this.loadQueue();
    if (!queue) return null;
    const obsolete = (e: QueuedEvent) =>
      !e.attributeLater && e.accountGeneration !== generation;
    if (!queue.some(obsolete)) return queue;
    if (!(await this.writeQueue(queue.filter((e) => !obsolete(e)))))
      return null;
    const remaining = await this.loadQueue();
    return remaining && !remaining.some(obsolete) ? remaining : null;
  }

  /** Give every waiting unattributed event the person now installed, in storage (rule 2). */
  private async attributeWaiting(): Promise<boolean> {
    const stamp = this.stamp();
    const permission = this.permission;
    if (!permission || !(await this.allowed(permission))) return false;
    const queue = await this.loadQueue();
    if (queue === null) return false;
    if (!queue.some((e) => e.attributeLater)) return true;
    const identity = await this.identity();
    if (!identity) return false;
    const state = await this.read();
    if (!state || !this.isCurrent(stamp) || !(await this.allowed(permission))) return false;
    const signedIn = state.userId !== null;
    const distinctId = state.userId ?? this.anonymousId(state, identity);
    if (
      !(await this.writeQueue(
        queue.map((e) => {
          if (!e.attributeLater) return e;
          return {
            event: e.event,
            uuid: e.uuid,
            timestamp: e.timestamp,
            permission: e.permission,
            accountGeneration: state.accountGeneration,
            properties: {
              ...e.properties,
              distinct_id: distinctId,
              signed_in: signedIn,
            },
          };
        }),
      ))
    )
      return false;
    const remaining = await this.loadQueue();
    return (
      remaining !== null &&
      !remaining.some((e) => e.attributeLater) &&
      this.isCurrent(stamp) &&
      (await this.allowed(permission))
    );
  }

  /** Whether reporting may happen now. Fails closed, and when sharing turns out to be off (it can
   * be withdrawn outside Still: Firefox's add-on manager, the Apple app's switch) anything still
   * waiting is discarded. */
  private async readPermission(): Promise<AnalyticsPermission | null> {
    return (await this.readAuthority()).granted;
  }

  private async readAuthority(): Promise<{
    raw: AnalyticsPermission | null;
    granted: AnalyticsPermission | null;
  }> {
    try {
      const [value, enabled] = await Promise.all([
        this.deps.permission?.(),
        this.deps.consent().catch(() => false),
      ]);
      const permission = readAnalyticsPermission(value);
      return {
        raw: permission,
        granted:
          privacyPolicyReady(this.deps.privacyPolicy) &&
          enabled === true &&
          permission?.state === "granted" &&
          permission.version === this.deps.privacyPolicy?.permissionVersion
            ? permission
            : null,
      };
    } catch {
      return { raw: null, granted: null };
    }
  }

  private async allowed(expected?: AnalyticsPermission): Promise<boolean> {
    if (!this.configured || this.blocked) return false;
    const stamp = this.stamp();
    const authority = await this.readAuthority();
    const permission = authority.granted;
    if (!this.isCurrent(stamp)) return false;
    if (!permission) {
      this.cancel();
      this.permission = null;
      await this.discardQueue(authority.raw ?? false);
      return false;
    }
    if (expected && !samePermission(expected, permission)) return false;
    const state = await this.read();
    if (!state || !this.isCurrent(stamp)) return false;
    if (state.stoppedOrigin === permission.origin) {
      await this.discardQueue();
      return false;
    }
    if (state.stopPending || !samePermission(state.permission, permission)) {
      // Retire legacy/previous-permission waiting data before installing a fresh lifecycle.
      if (!(await this.write({ ...state, stopPending: true }))) {
        this.blocked = true;
        return false;
      }
      if (!(await this.writeQueue([])) || !(await this.queueCleared())) return false;
      if (!this.isCurrent(stamp) || !samePermission(permission, await this.readPermission())) return false;
      if (
        !(await this.write({
          ...state,
          permission,
          stopPending: false,
          identifiedAs: null,
          daily: {},
          anonId: permission.provider.anonymousId,
          anonIndex: 0,
        }))
      )
        return false;
      const installed = await this.read();
      if (!installed || installed.stopPending || !samePermission(installed.permission, permission)) return false;
    }
    this.permission = permission;
    return this.isCurrent(stamp);
  }

  /** Verify raw queue removal and retain minimal stopped-origin authority. */
  private async discardQueue(
    retire: boolean | AnalyticsPermission = true,
  ): Promise<void> {
    const state = await this.read();
    const waiting = await this.loadRawQueue(true);
    const endedOrigin =
      retire === true
        ? state?.permission?.origin
        : typeof retire === "object"
          ? retire.state === "stopped"
            ? retire.origin
            : state?.permission && !samePermission(retire, state.permission)
              ? state.permission.origin
              : null
          : null;
    const stoppedOrigin = endedOrigin ?? state?.stoppedOrigin;
    // Undecided installs do not allocate optional state, identity or an empty backlog.
    if (
      state &&
      !state.permission &&
      !state.stopPending &&
      state.userId === null &&
      state.identifiedAs === null &&
      state.forgotten.length === 0 &&
      waiting?.length === 0
    )
      return;
    if (
      !state ||
      !(await this.write({
        ...state,
        stopPending: true,
        identifiedAs: null,
        stoppedOrigin: stoppedOrigin ?? null,
      }))
    ) {
      this.blocked = true;
      return;
    }
    if (!(await this.writeQueue([])) || !(await this.queueCleared())) return;
    await this.write({
      ...state,
      permission: endedOrigin ? null : state.permission,
      stopPending: false,
      identifiedAs: null,
      stoppedOrigin: stoppedOrigin ?? null,
    });
  }

  /** This install's ids, refusing anything that is not a Still id. */
  private async identity(): Promise<AnalyticsIdentity | null> {
    try {
      const identity = await this.deps.identity();
      if (!isAnalyticsId(identity.installId) || !isAnalyticsId(identity.anchorId)) return null;
      return identity;
    } catch {
      return null;
    }
  }

  /** The state, or null when the store refuses to answer. Never an empty state in its place: a
   * reader that took "unreadable" for "nothing there" would send what is owed a drop, and a writer
   * that built on it would erase the account and the record of that debt. */
  private async read(): Promise<ClientState | null> {
    try {
      return parseState(await this.deps.store.get(STATE_KEY));
    } catch {
      return null;
    }
  }

  private async write(state: ClientState): Promise<boolean> {
    try {
      await this.deps.store.set(STATE_KEY, state);
      return true;
    } catch {
      return false; // A failed write costs these events, never a working surface.
    }
  }

  private get queueStore(): AnalyticsKeyValue {
    return this.deps.queueStore ?? this.deps.store;
  }

  /** The queue, or null when the queue store refuses to answer (a drop must not count that as empty). */
  private async loadQueue(): Promise<QueuedEvent[] | null> {
    try {
      return parseQueue(await this.queueStore.get(QUEUE_KEY));
    } catch {
      return null;
    }
  }

  private async readQueue(): Promise<QueuedEvent[]> {
    return (await this.loadQueue()) ?? [];
  }

  /** Erasure verification examines the raw store; malformed entries must not look deleted. */
  private async queueCleared(): Promise<boolean> {
    try {
      const value = await this.queueStore.get(QUEUE_KEY);
      return Array.isArray(value) && value.length === 0;
    } catch {
      return false;
    }
  }

  /** False when the queue store refused the write. */
  private async writeQueue(queue: readonly unknown[]): Promise<boolean> {
    try {
      await this.queueStore.set(QUEUE_KEY, queue.slice(-MAX_QUEUE));
      return true;
    } catch {
      return false; // A failed write costs these events, never a working surface.
    }
  }

  /** Inspect all raw records. Only allocation preflight accepts missing-key null as empty;
   * erasure verification must not take it as proof that a purge was persisted. */
  private async loadRawQueue(allocationPreflight = false): Promise<unknown[] | null> {
    try {
      const value = await this.queueStore.get(QUEUE_KEY);
      return value === undefined || (allocationPreflight && value === null)
        ? []
        : Array.isArray(value)
          ? value
          : [value];
    } catch {
      return null;
    }
  }

  /** Queue one event. False when the queue store refused it. */
  private async push(
    event: QueuedEvent,
    options: TrackOptions = {},
  ): Promise<boolean> {
    const stamp = this.stamp();
    const permission = this.permission;
    if (!permission) return false;
    const state = await this.read();
    if (!state) return false;
    const queue = await this.loadQueue();
    if (
      queue === null ||
      !this.isCurrent(stamp) ||
      !(await this.allowed(permission)) ||
      !(await this.writeQueue([
        ...queue,
        { ...event, permission, accountGeneration: state.accountGeneration },
      ]))
    )
      return false;
    if (
      !(await this.loadQueue())?.some(
        (stored) => stored.uuid === event.uuid && samePermission(stored.permission ?? null, permission),
      )
    )
      return false;
    if (!options.quiet) this.scheduleFlush();
    return true;
  }

  private timestamp(options: TrackOptions): string {
    // Earlier install/setup evidence is not an eligible post-consent action.
    const at = this.deps.now();
    return options.quiet ? localMidnightIso(at) : new Date(at).toISOString();
  }

  /** The anonymous id this install reports under while signed out. */
  private anonymousId(state: ClientState, identity: AnalyticsIdentity): string {
    return state.anonId ?? identity.anchorId;
  }

  /** The properties every product event carries. */
  private envelope(
    state: ClientState,
    identity: AnalyticsIdentity,
  ): Record<string, unknown> {
    const { surface, appVersion } = this.deps;
    return {
      distinct_id: state.userId ?? this.anonymousId(state, identity),
      $device_id: this.permission!.provider.deviceId,
      $lib: "still",
      // Location is never derived from the connection (the privacy label declares none).
      $geoip_disable: true,
      surface,
      store: storeForSurface(surface),
      ...(isDeviceClass(this.deps.device) ? { device: this.deps.device } : {}),
      app_version: appVersion,
      ...(this.deps.envelope?.os && ANALYTICS_OS.includes(this.deps.envelope.os) ? { os: this.deps.envelope.os } : {}),
      ...(this.deps.envelope?.build_channel && ANALYTICS_BUILD_CHANNELS.includes(this.deps.envelope.build_channel)
        ? { build_channel: this.deps.envelope.build_channel }
        : {}),
      ...(isVersion(this.deps.envelope?.rule_version) ? { rule_version: this.deps.envelope!.rule_version } : {}),
      ...(this.deps.envelope?.plan && ANALYTICS_PLANS.includes(this.deps.envelope.plan)
        ? { plan: this.deps.envelope.plan }
        : {}),
    };
  }

  /** Queue one product event. False when it could not be queued (nothing was recorded). */
  private async enqueue(
    name: string,
    props: Record<string, boolean | string>,
    options: TrackOptions = {},
    requested = this.stamp(),
    permission = this.permission,
  ): Promise<boolean> {
    if (!permission || !this.isCurrent(requested) || !(await this.allowed(permission))) return false;
    const identity = await this.identity();
    if (!identity || !this.isCurrent(requested) || !(await this.allowed(permission))) return false;
    const state = await this.read();
    if (
      !state ||
      !this.isCurrent(requested) ||
      !(await this.allowed(permission))
    )
      return false;
    const { distinct_id: distinctId, ...common } = this.envelope(
      state,
      identity,
    );
    if (!this.confirmed) {
      // No person yet: the confirmation gives it one, in storage, before it can be sent (rule 2).
      return this.push(
        {
          event: name,
          uuid: this.deps.uuid(),
          timestamp: this.timestamp(options),
          attributeLater: true,
          properties: { ...props, ...common },
        },
        options,
      );
    }
    return this.push(
      {
        event: name,
        uuid: this.deps.uuid(),
        timestamp: this.timestamp(options),
        properties: {
          ...props,
          distinct_id: distinctId,
          ...common,
          signed_in: state.userId !== null,
        },
      },
      options,
    );
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const schedule = this.deps.schedule ?? ((run, ms) => void setTimeout(run, ms));
    schedule(() => {
      this.flushScheduled = false;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** One request, for a caller that was asked under `epoch`. Refused, synchronously and before
   * anything else, when a cancellation has overtaken that caller since: this is the last check
   * before the network, after every awaited read a caller does (rule 1). */
  private async post(
    batch: readonly QueuedEvent[],
    epoch: number,
  ): Promise<"done" | "retry"> {
    const permission = this.permission;
    if (epoch !== this.epoch || !permission || !(await this.allowed(permission)) || epoch !== this.epoch)
      return "retry";
    const state = await this.read();
    if (!state || epoch !== this.epoch) return "retry";
    const oldest = this.deps.now() - MAX_EVENT_AGE_MS;
    const outbound = batch.flatMap((event) => {
      if (!samePermission(event.permission ?? null, permission) || !isAppClientEvent(event.event)) return [];
      const props = event.properties;
      const envelopeKeys = [
        "distinct_id",
        "$device_id",
        "$lib",
        "$geoip_disable",
        "surface",
        "store",
        "device",
        "app_version",
        "signed_in",
        "os",
        "build_channel",
        "rule_version",
        "plan",
      ];
      const specific = Object.fromEntries(
        Object.entries(props).filter(([key]) => !envelopeKeys.includes(key)),
      );
      if (
        !validateEvent(event.event, specific) ||
        !isAnalyticsId(event.uuid) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          event.timestamp,
        ) ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        Date.parse(event.timestamp) < oldest ||
        !isAnalyticsId(props.distinct_id) ||
        (state.accountRef !== null && String(props.distinct_id).toLowerCase() === state.accountRef) ||
        !isAnalyticsId(props.$device_id) ||
        props.$device_id !== permission.provider.deviceId ||
        props.distinct_id !== (state.userId ?? state.anonId ?? permission.provider.anonymousId) ||
        props.signed_in !== (state.userId !== null) ||
        props.$lib !== "still" ||
        props.$geoip_disable !== true ||
        props.surface !== this.deps.surface ||
        props.store !== storeForSurface(this.deps.surface) ||
        !isVersion(props.app_version) ||
        (props.device !== undefined && !isDeviceClass(props.device)) ||
        (props.signed_in !== undefined && typeof props.signed_in !== "boolean") ||
        (props.os !== undefined && !(ANALYTICS_OS as readonly unknown[]).includes(props.os)) ||
        (props.build_channel !== undefined &&
          !(ANALYTICS_BUILD_CHANNELS as readonly unknown[]).includes(
            props.build_channel,
          )) ||
        (props.rule_version !== undefined && !isVersion(props.rule_version)) ||
        (props.plan !== undefined && !(ANALYTICS_PLANS as readonly unknown[]).includes(props.plan))
      )
        return [];
      // Strip all private permission/origin data; validate persisted records again at actual send.
      return [
        {
          event: event.event,
          uuid: event.uuid,
          timestamp: event.timestamp,
          properties: props,
        },
      ];
    });
    if (outbound.length === 0) return "done";
    if (!samePermission(permission, await this.readPermission()) || epoch !== this.epoch) return "retry";
    const host = this.deps.config.host!.trim().replace(/\/+$/, "");
    // Every request is bounded, and abandonable: switching sharing off aborts it (cancel), so a
    // stuck network can never hold the queue, the switch, or anything behind them.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    this.inflight = controller;
    const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
    const aborted = new Promise<never>((_, reject) =>
      controller?.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      ),
    );
    try {
      const response = await Promise.race([
        this.deps.fetch(`${host}/batch/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: this.deps.config.key!.trim(),
            batch: outbound,
          }),
          signal: controller?.signal,
        }),
        aborted,
      ]);
      if (response.ok) return "done";
      // A request PostHog will never accept: drop it rather than block everything behind it.
      if (response.status === 400 || response.status === 413) return "done";
      return "retry";
    } catch {
      return "retry";
    } finally {
      clearTimeout(timer);
      if (this.inflight === controller) this.inflight = null;
    }
  }
}
