import {
  isDeviceClass,
  isVersion,
  storeForSurface,
  validateEvent,
  type AnalyticsEventName,
  type AnalyticsEventProps,
  type AnalyticsDevice,
  type AnalyticsSurface,
} from "./events.js";
import { isAnalyticsId, type AnalyticsIdentity, type AnalyticsKeyValue } from "./identity.js";

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
// Four rules make it safe to use from several contexts at once. Every change here must keep them.
//
//   1. One operation at a time. Everything that reads or writes the account, the markers or the
//      queue runs inside `run()`, including a flush's network request and the opt-out attempt, so
//      no operation ever observes another half done. The only work outside it is synchronous and
//      happens the moment the caller asks, before anything is queued: forgetting an account, turning
//      sharing off and the opt-out bump the cancellation epoch and abort the request in flight. A
//      flush or opt-out remembers the epoch it was asked under, and no request starts under a
//      stale one: `post` refuses at its entry, synchronously, after every awaited read is done.
//      So one asked before that moment sends nothing when its turn comes, however long it waited.
//   2. An event's person is decided once and saved. When the account is confirmed, an event is
//      attributed as it is queued; before that it is queued with no person (`attributeLater`) and
//      attributed, in storage, by the confirmation itself. Nothing is ever attributed at send time,
//      so a retry always carries the person it was first given, and forgetting an account (it was
//      deleted) drops every event attributed to it. That drop is owed durably: the account is
//      recorded as forgotten before its events are dropped, the drop is verified, and until it is
//      verified `flush` sends nothing, so a queue store that refuses the write only delays the drop
//      to the next confirmation or flush, in this process or the next. A state store that cannot
//      be read is never taken as empty: every reader fails closed (nothing sent, nothing written),
//      so the record of what is owed can neither be overlooked nor overwritten.
//   3. Confirmation is one operation. `confirm()` installs the account (or lets it go), tries any
//      owed drop, attributes the waiting events, and only then marks the account confirmed, so
//      nothing can see "confirmed" together with a different account.
//   4. Nothing leaves before the account is confirmed. Hosts that start without knowing who is
//      signed in (`startsUnconfirmed`) send nothing until they confirm, and a timeout never counts
//      as confirmation.
//
// The install and person ids themselves (identity.ts) never change once created.

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
}

interface ClientState {
  /** The signed-in account this install currently reports as, or null. */
  readonly userId: string | null;
  /** The account a `$identify` has already been queued for, so it is sent once per sign-in. */
  readonly identifiedAs: string | null;
  /** Marker → local calendar day it last fired, for once-a-day events; `once:` markers → "done". */
  readonly daily: Readonly<Record<string, string>>;
  /** The anonymous id after a sign-out. The install's anchor was merged into the account that
   * signed out, so reusing it would keep attributing this device to that person; a fresh id per
   * sign-out, as posthog-js does, separates them. */
  readonly anonId: string | null;
  /** Accounts that were forgotten (deleted) whose waiting events have not yet verifiably been
   * dropped. Recorded before the drop, in the state store, because the queue lives in a different
   * store (IndexedDB in the extensions) that can refuse a write on its own; nothing is sent while
   * this is non-empty (rule 2). */
  readonly forgotten: readonly string[];
}

const EMPTY_STATE: ClientState = { userId: null, identifiedAs: null, daily: {}, anonId: null, forgotten: [] };

function parseState(value: unknown): ClientState {
  if (typeof value !== "object" || value === null) return EMPTY_STATE;
  const v = value as Record<string, unknown>;
  return {
    userId: typeof v.userId === "string" ? v.userId : null,
    identifiedAs: typeof v.identifiedAs === "string" ? v.identifiedAs : null,
    daily:
      typeof v.daily === "object" && v.daily !== null ? (v.daily as Record<string, string>) : {},
    anonId: typeof v.anonId === "string" ? v.anonId : null,
    forgotten: Array.isArray(v.forgotten) ? v.forgotten.filter((id): id is string => typeof id === "string") : [],
  };
}

function parseQueue(value: unknown): QueuedEvent[] {
  return Array.isArray(value) ? (value as QueuedEvent[]).slice(-MAX_QUEUE) : [];
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
 * `at` records an event with an earlier time: an install that happened while sharing was off.
 */
export interface TrackOptions {
  readonly quiet?: boolean;
  readonly at?: number;
}

/** Local midnight of the day containing `ms`, as an ISO timestamp. */
function localMidnightIso(ms: number): string {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

/** Who the host has established is signed in: an account id, or nobody. */
export type ConfirmedAccount = string | null;

export interface ConfirmOptions {
  /** The account that was signed in has gone (deleted, or its session ended elsewhere): abandon
   * any send under it and drop the events waiting under it, so nothing recreates a person the
   * server deleted. */
  readonly forget?: boolean;
  /** A background start: do not send now (see TrackOptions.quiet). */
  readonly quiet?: boolean;
}

export class AnalyticsClient {
  private readonly configured: boolean;
  private chain: Promise<unknown> = Promise.resolve();
  private flushScheduled = false;
  /** Bumped synchronously whenever sharing is switched off or an account is forgotten, so a flush
   * in progress stops before its next request and one still waiting its turn never starts (rule
   * 1's only exception). */
  private epoch = 0;
  /** Bumped (inside \`run\`) whenever the account changes. Work that reads the account and then
   * waits outside the client (the server attach) checks it before acting. */
  private generation = 0;
  /** Rule 4. Only \`confirm\` sets it, and only after installing the account (rule 3). */
  private confirmed: boolean;
  /** The request in flight, so switching sharing off can abandon it instead of waiting. */
  private inflight: AbortController | null = null;
  /** Set when an account change could not be saved: reporting stops for the life of this client
   * rather than risk sending under an account that should have been let go. */
  private blocked = false;

  constructor(private readonly deps: AnalyticsClientDeps) {
    // A malformed version (for example from a bad native reply) would ride along on every event;
    // refuse to run rather than send it.
    this.configured = analyticsConfigured(deps.config) && isVersion(deps.appVersion);
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
  trackUnchecked(name: unknown, props: unknown, options: TrackOptions = {}): Promise<void> {
    return this.run(async () => {
      if (!(await this.allowed())) return;
      const valid = validateEvent(name, props);
      if (!valid) return;
      await this.enqueue(name as string, valid, options);
    });
  }

  /** Queue an event at most once per local calendar day for `marker`. */
  trackDaily<E extends AnalyticsEventName>(
    marker: string,
    name: E,
    props: AnalyticsEventProps<E>,
    options: TrackOptions = {},
  ): Promise<void> {
    return this.trackMarked(marker, localDay(this.deps.now()), name, props, options);
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
    return this.run(async () => (await this.read())?.daily[`once:${marker}`] !== undefined);
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
   * mark the account confirmed and, unless quiet, send what is waiting. Never undone: confirmed
   * stays confirmed.
   *
   * With `forget`, the account is fenced the moment this is called, before anything waits its turn:
   * the request in flight is abandoned and every flush asked for before now sends nothing, so
   * nothing under the account can leave from here on, even if the host stops waiting for this
   * (account deletion waits a bounded time) and the server deletes the person meanwhile.
   */
  confirm(account: ConfirmedAccount, options: ConfirmOptions = {}): Promise<void> {
    if (options.forget) this.cancel();
    return this.run(async () => {
      if (!this.configured) return;
      if (account !== null && !isAnalyticsId(account)) return; // only Supabase UUIDs become accounts
      if (!(await this.installAccount(account, options))) return;
      await this.dropForgotten(); // tried here; `flush` is the gate that refuses to send until it is done
      await this.attributeWaiting();
      this.confirmed = true;
      if (account !== null && (await this.allowed())) {
        const identity = await this.identity();
        if (identity) await this.ensureIdentified(identity, options);
      }
      if (!options.quiet && (await this.readQueue()).length > 0) this.scheduleFlush();
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

  /** A snapshot of the account generation and consent epoch, for work that waits and then acts. */
  stamp(): { readonly generation: number; readonly epoch: number } {
    return { generation: this.generation, epoch: this.epoch };
  }

  /** Whether nothing about the account or sharing has changed since `stamp`. */
  isCurrent(stamp: { readonly generation: number; readonly epoch: number }): boolean {
    return stamp.generation === this.generation && stamp.epoch === this.epoch;
  }

  // ── Sending ──────────────────────────────────────────────────────────────────────────────────

  /** Send what is queued, once the account is confirmed. Keeps events on a network or server
   * failure so the next flush retries them, with the person they were given. */
  flush(): Promise<void> {
    // The epoch this flush was asked under. A cancellation between now and its turn (an account
    // forgotten, sharing switched off) means it must send nothing when it runs (rule 1).
    const epoch = this.epoch;
    return this.run(async () => {
      if (!this.confirmed || epoch !== this.epoch) return; // rule 4; rule 1
      if (!(await this.dropForgotten())) return; // rule 2: a forgotten account's events never leave
      for (;;) {
        const batch = (await this.readQueue()).filter((e) => !e.attributeLater).slice(0, BATCH_SIZE);
        if (batch.length === 0) return;
        // Sharing is re-read immediately before every request; `post` re-checks cancellation.
        if (!(await this.allowed())) return;
        if ((await this.post(batch, epoch)) === "retry") return;
        // Sent, or rejected as malformed (retrying a 400 forever would block the queue).
        const sent = new Set(batch.map((e) => e.uuid));
        // Storage that will not take the write would hand back the same batch forever.
        if (!(await this.writeQueue((await this.readQueue()).filter((e) => !sent.has(e.uuid))))) return;
        if ((await this.readQueue()).some((e) => sent.has(e.uuid))) return;
      }
    });
  }

  /** Drop everything waiting to be sent: the person turned analytics off. */
  clearQueue(): Promise<void> {
    this.cancel();
    return this.run(() => this.discardQueue());
  }

  /**
   * The person turned sharing off with Still's own switch (on to off). Stop at once: nothing
   * waiting is sent. Then, in the same operation, one short standalone attempt records only the
   * opt-out itself, under the confirmed account of that moment. Skipped if the account is not
   * confirmed.
   */
  sendOptOut(timeoutMs = 3_000): Promise<void> {
    this.cancel();
    const epoch = this.epoch; // an account forgotten before the request: nothing to record it under
    return this.run(async () => {
      await this.discardQueue();
      if (!this.configured || this.blocked || !this.confirmed) return;
      const identity = await this.identity();
      if (!identity) return;
      const state = await this.read();
      if (!state) return;
      const event: QueuedEvent = {
        event: "sharing_turned_off",
        uuid: this.deps.uuid(),
        timestamp: this.timestamp({}),
        properties: {
          ...this.envelope(state, identity),
          signed_in: state.userId !== null,
        },
      };
      const abort = typeof AbortController === "function" ? new AbortController() : null;
      const timer = setTimeout(() => abort?.abort(), timeoutMs);
      try {
        // The reads above took time; an account forgotten meanwhile must not be named (`post` checks).
        await this.post([event], epoch, abort?.signal);
      } finally {
        clearTimeout(timer);
      }
    });
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
  }

  private trackMarked<E extends AnalyticsEventName>(
    marker: string,
    value: string,
    name: E,
    props: AnalyticsEventProps<E>,
    options: TrackOptions,
  ): Promise<void> {
    return this.run(async () => {
      if (!(await this.allowed())) return;
      const valid = validateEvent(name, props);
      if (!valid) return;
      const state = await this.read();
      if (!state || state.daily[marker] === value) return;
      await this.write({ ...state, daily: { ...state.daily, [marker]: value } });
      await this.enqueue(name, valid, options);
    });
  }

  /** Install the account named by a confirmation. False when the change could not be saved. A
   * forgotten account is recorded as such here, durably, before its events are dropped
   * (`dropForgotten`), so the drop is owed even if this process ends first. */
  private async installAccount(account: ConfirmedAccount, options: ConfirmOptions): Promise<boolean> {
    const state = await this.read();
    if (!state) {
      // Who is signed in cannot be known, so nothing changes and the host confirms again later. A
      // forget that cannot be recorded stops this process for good: the next one is asked again.
      if (options.forget) this.blocked = true;
      return false;
    }
    if (account !== null) {
      if (state.userId === account) return true;
      this.generation += 1;
      const saved = await this.write({ ...state, userId: account, identifiedAs: null });
      if (!saved) this.blocked = true;
      return saved;
    }
    if (state.userId === null) return true; // nobody, as before: keep the same anonymous id
    this.generation += 1;
    const forgotten = options.forget && !state.forgotten.includes(state.userId)
      ? [...state.forgotten, state.userId]
      : state.forgotten;
    const saved = await this.write({ ...state, userId: null, identifiedAs: null, anonId: this.deps.uuid(), forgotten });
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

  /** Drop every queued event attributed to one of `gone`, and verify it. False when the queue store
   * refuses to give up the events or to be read (a refused read must not count as "nothing left"). */
  private async dropEventsOf(gone: ReadonlySet<string>): Promise<boolean> {
    const owned = (e: QueuedEvent) => typeof e.properties.distinct_id === "string" && gone.has(e.properties.distinct_id);
    const queue = await this.loadQueue();
    if (queue === null) return false;
    if (queue.some(owned) && !(await this.writeQueue(queue.filter((e) => !owned(e))))) return false;
    const remaining = await this.loadQueue();
    return remaining !== null && !remaining.some(owned);
  }

  /** Give every waiting unattributed event the person now installed, in storage (rule 2). */
  private async attributeWaiting(): Promise<void> {
    const queue = await this.readQueue();
    if (!queue.some((e) => e.attributeLater)) return;
    const identity = await this.identity();
    if (!identity) return;
    const state = await this.read();
    if (!state) return; // they keep waiting; the next confirmation tries again
    const signedIn = state.userId !== null;
    const distinctId = state.userId ?? this.anonymousId(state, identity);
    await this.writeQueue(
      queue.map((e) => {
        if (!e.attributeLater) return e;
        const $set = { ...(e.properties.$set as Record<string, unknown> | undefined) };
        if (e.event === "signed_out") $set.signed_in = false;
        return {
          event: e.event,
          uuid: e.uuid,
          timestamp: e.timestamp,
          properties: { ...e.properties, distinct_id: distinctId, signed_in: signedIn, $set },
        };
      }),
    );
  }

  /** Whether reporting may happen now. Fails closed, and when sharing turns out to be off (it can
   * be withdrawn outside Still: Firefox's add-on manager, the Apple app's switch) anything still
   * waiting is discarded. */
  private async allowed(): Promise<boolean> {
    if (!this.configured || this.blocked) return false;
    let consent: boolean;
    try {
      consent = await this.deps.consent();
    } catch {
      consent = false;
    }
    if (!consent) await this.discardQueue();
    return consent;
  }

  /** Empty the queue. A discarded `$identify` must be queued again later, so its marker goes too. */
  private async discardQueue(): Promise<void> {
    if ((await this.readQueue()).length > 0) await this.writeQueue([]);
    const state = await this.read();
    if (state && state.identifiedAs !== null) await this.write({ ...state, identifiedAs: null });
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

  /** False when the queue store refused the write. */
  private async writeQueue(queue: readonly QueuedEvent[]): Promise<boolean> {
    try {
      await this.queueStore.set(QUEUE_KEY, queue.slice(-MAX_QUEUE));
      return true;
    } catch {
      return false; // A failed write costs these events, never a working surface.
    }
  }

  private async push(event: QueuedEvent, options: TrackOptions = {}): Promise<void> {
    await this.writeQueue([...(await this.readQueue()), event]);
    if (!options.quiet) this.scheduleFlush();
  }

  private timestamp(options: TrackOptions): string {
    const at = options.at ?? this.deps.now();
    return options.quiet ? localMidnightIso(at) : new Date(at).toISOString();
  }

  /** The anonymous id this install reports under while signed out. */
  private anonymousId(state: ClientState, identity: AnalyticsIdentity): string {
    return state.anonId ?? identity.anchorId;
  }

  /** The properties every product event carries. */
  private envelope(state: ClientState, identity: AnalyticsIdentity): Record<string, unknown> {
    const { surface, appVersion } = this.deps;
    return {
      distinct_id: state.userId ?? this.anonymousId(state, identity),
      $device_id: identity.installId,
      $lib: "still",
      // Location is never derived from the connection (the privacy label declares none).
      $geoip_disable: true,
      surface,
      store: storeForSurface(surface),
      ...(isDeviceClass(this.deps.device) ? { device: this.deps.device } : {}),
      app_version: appVersion,
    };
  }

  /** Person properties refreshed by every event, so each profile shows every store a person
   * uses and the version they last ran there. */
  private personProperties(options: TrackOptions = {}): { $set: Record<string, unknown>; $set_once: Record<string, unknown> } {
    const { surface, appVersion } = this.deps;
    const store = storeForSurface(surface);
    return {
      $set: {
        [`uses_${surface.replace("-", "_")}`]: true,
        [`uses_store_${store}`]: true,
        [`last_version_${surface.replace("-", "_")}`]: appVersion,
        last_surface: surface,
        ...(isDeviceClass(this.deps.device) ? { last_device: this.deps.device } : {}),
      },
      $set_once: {
        first_surface: surface,
        first_store: store,
        // Same precision as the event itself: a quiet event's day, never its moment.
        first_seen: this.timestamp(options),
      },
    };
  }

  /** Queue the `$identify` that merges this install's anonymous id into the confirmed account. */
  private async ensureIdentified(identity: AnalyticsIdentity, options: TrackOptions = {}): Promise<void> {
    if (!this.confirmed) return;
    const state = await this.read();
    if (!state?.userId || state.identifiedAs === state.userId) return;
    const person = this.personProperties(options);
    await this.write({ ...state, identifiedAs: state.userId });
    await this.push({
      event: "$identify",
      uuid: this.deps.uuid(),
      timestamp: this.timestamp({ quiet: options.quiet }),
      properties: {
        distinct_id: state.userId,
        $anon_distinct_id: this.anonymousId(state, identity),
        $device_id: identity.installId,
        $lib: "still",
        $geoip_disable: true,
        $set: { ...person.$set, signed_in: true },
        $set_once: person.$set_once,
      },
    }, options);
  }

  private async enqueue(
    name: string,
    props: Record<string, boolean | string>,
    options: TrackOptions = {},
  ): Promise<void> {
    const identity = await this.identity();
    if (!identity) return;
    await this.ensureIdentified(identity, options);
    const state = await this.read();
    if (!state) return; // an event costs less than one recorded under the wrong person
    const person = this.personProperties(options);
    const { distinct_id: distinctId, ...common } = this.envelope(state, identity);
    if (!this.confirmed) {
      // No person yet: the confirmation gives it one, in storage, before it can be sent (rule 2).
      await this.push({
        event: name,
        uuid: this.deps.uuid(),
        timestamp: this.timestamp(options),
        attributeLater: true,
        properties: { ...props, ...common, $set: person.$set, $set_once: person.$set_once },
      }, options);
      return;
    }
    await this.push({
      event: name,
      uuid: this.deps.uuid(),
      timestamp: this.timestamp(options),
      properties: {
        ...props,
        distinct_id: distinctId,
        ...common,
        signed_in: state.userId !== null,
        $set: name === "signed_out" ? { ...person.$set, signed_in: false } : person.$set,
        $set_once: person.$set_once,
      },
    }, options);
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
  private async post(batch: readonly QueuedEvent[], epoch: number, signal?: AbortSignal): Promise<"done" | "retry"> {
    if (epoch !== this.epoch) return "retry";
    const host = this.deps.config.host!.trim().replace(/\/+$/, "");
    // Every request is bounded, and abandonable: switching sharing off aborts it (cancel), so a
    // stuck network can never hold the queue, the switch, or anything behind them.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (signal) signal.addEventListener("abort", () => controller?.abort(), { once: true });
    this.inflight = controller;
    const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
    const aborted = new Promise<never>((_, reject) =>
      controller?.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
    try {
      const response = await Promise.race([
        this.deps.fetch(`${host}/batch/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: this.deps.config.key!.trim(), batch }),
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
