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

export const STATE_KEY = "still:analytics:state";
export const QUEUE_KEY = "still:analytics:queue";
/** Oldest events are dropped beyond this, so an install that is offline for weeks stays small. */
export const MAX_QUEUE = 300;
/** Events per request. */
export const BATCH_SIZE = 50;
/** How long after the last event to wait before sending, so a burst goes out as one request. */
export const FLUSH_DELAY_MS = 1_500;

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
}

interface QueuedEvent {
  readonly event: string;
  readonly uuid: string;
  readonly timestamp: string;
  readonly properties: Record<string, unknown>;
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
}

const EMPTY_STATE: ClientState = { userId: null, identifiedAs: null, daily: {}, anonId: null };

function parseState(value: unknown): ClientState {
  if (typeof value !== "object" || value === null) return EMPTY_STATE;
  const v = value as Record<string, unknown>;
  return {
    userId: typeof v.userId === "string" ? v.userId : null,
    identifiedAs: typeof v.identifiedAs === "string" ? v.identifiedAs : null,
    daily:
      typeof v.daily === "object" && v.daily !== null ? (v.daily as Record<string, string>) : {},
    anonId: typeof v.anonId === "string" ? v.anonId : null,
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

export class AnalyticsClient {
  private readonly configured: boolean;
  private chain: Promise<unknown> = Promise.resolve();
  private flushScheduled = false;
  /** Bumped (synchronously) whenever sharing is switched off, so a flush already running stops
   * before its next request instead of finishing the queue. */
  private epoch = 0;
  /** Set when an identity reset could not be saved: reporting stops for the life of this client
   * rather than risk sending under an account that should have been let go. */
  private blocked = false;

  constructor(private readonly deps: AnalyticsClientDeps) {
    // A malformed version (for example from a bad native reply) would ride along on every event;
    // refuse to run rather than send it.
    this.configured = analyticsConfigured(deps.config) && isVersion(deps.appVersion);
  }

  get enabled(): boolean {
    return this.configured;
  }

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

  /** Whether a once-marker has already fired (a host deciding whether to keep a pending record). */
  async hasTrackedOnce(marker: string): Promise<boolean> {
    return (await this.read()).daily[`once:${marker}`] !== undefined;
  }

  /** Attribute this install to a signed-in account from now on. Idempotent per account. */
  identify(userId: string, options: TrackOptions = {}): Promise<void> {
    return this.run(async () => {
      // Account ids are Supabase UUIDs; anything else never becomes a distinct id.
      if (!this.configured || !isAnalyticsId(userId)) return;
      const state = await this.read();
      if (state.userId !== userId) await this.write({ ...state, userId });
      if (!(await this.allowed())) return;
      const identity = await this.identity();
      if (identity) await this.ensureIdentified(identity, options);
    });
  }

  /** Whether this install currently reports as a signed-in account. */
  async signedInAs(): Promise<string | null> {
    return (await this.read()).userId;
  }

  /**
   * Stop attributing to the account (sign-out, deletion). Later events use a fresh anonymous id.
   * With `forgetAccount` (the account was deleted), events still waiting under it are dropped, so
   * nothing recreates the person the server just deleted.
   */
  reset(options: { readonly forgetAccount?: boolean; readonly onlyIfSignedIn?: boolean } = {}): Promise<void> {
    return this.run(async () => {
      if (!this.configured) return;
      const state = await this.read();
      // A start that finds no session: let go of an account only if one is attached, so a person who
      // was never signed in keeps one anonymous id instead of a new one every start.
      if (options.onlyIfSignedIn && !state.userId) return;
      if (options.forgetAccount && state.userId) {
        const gone = state.userId;
        const queue = await this.readQueue();
        const kept = queue.filter((e) => e.properties.distinct_id !== gone);
        if (kept.length !== queue.length) await this.writeQueue(kept);
      }
      const saved = await this.write({ ...state, userId: null, identifiedAs: null, anonId: this.deps.uuid() });
      if (!saved) this.blocked = true;
    });
  }

  /** Drop everything waiting to be sent: the person turned analytics off. */
  clearQueue(): Promise<void> {
    this.epoch += 1; // stop a running flush before its next request, without waiting for it
    return this.run(() => this.discardQueue());
  }

  /** Send what is queued. Keeps events on a network or server failure so the next flush retries. */
  flush(): Promise<void> {
    return this.run(async () => {
      const epoch = this.epoch;
      for (;;) {
        // Consent is re-read before every request: sharing can be switched off mid-flush.
        if (epoch !== this.epoch || !(await this.allowed())) return;
        const queue = await this.readQueue();
        const batch = queue.slice(0, BATCH_SIZE);
        if (batch.length === 0) return;
        const outcome = await this.post(batch);
        if (outcome === "retry") return;
        // Sent, or rejected as malformed (retrying a 400 forever would block the queue).
        const sent = new Set(batch.map((e) => e.uuid));
        const remaining = (await this.readQueue()).filter((e) => !sent.has(e.uuid));
        await this.writeQueue(remaining);
        // Storage that will not take the write would hand back the same batch forever.
        const after = await this.readQueue();
        if (after.some((e) => sent.has(e.uuid))) return;
      }
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

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
      if (state.daily[marker] === value) return;
      await this.write({ ...state, daily: { ...state.daily, [marker]: value } });
      await this.enqueue(name, valid, options);
    });
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
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

  /** Empty the queue. A discarded `$identify` must be sent again later, so the marker goes too. */
  private async discardQueue(): Promise<void> {
    if ((await this.readQueue()).length > 0) await this.writeQueue([]);
    const state = await this.read();
    if (state.identifiedAs !== null) await this.write({ ...state, identifiedAs: null });
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

  private async read(): Promise<ClientState> {
    try {
      return parseState(await this.deps.store.get(STATE_KEY));
    } catch {
      return EMPTY_STATE;
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

  private async readQueue(): Promise<QueuedEvent[]> {
    try {
      return parseQueue(await this.queueStore.get(QUEUE_KEY));
    } catch {
      return [];
    }
  }

  private async writeQueue(queue: readonly QueuedEvent[]): Promise<void> {
    try {
      await this.queueStore.set(QUEUE_KEY, queue.slice(-MAX_QUEUE));
    } catch {
      /* as above */
    }
  }

  private async push(event: QueuedEvent, options: TrackOptions = {}): Promise<void> {
    await this.writeQueue([...(await this.readQueue()), event]);
    if (!options.quiet) this.scheduleFlush();
  }

  private timestamp(options: TrackOptions): string {
    if (options.at !== undefined) {
      return options.quiet ? localMidnightIso(options.at) : new Date(options.at).toISOString();
    }
    return options.quiet ? localMidnightIso(this.deps.now()) : new Date(this.deps.now()).toISOString();
  }

  /** The anonymous id this install reports under while signed out. */
  private anonymousId(state: ClientState, identity: AnalyticsIdentity): string {
    return state.anonId ?? identity.anchorId;
  }

  /** Person properties refreshed by every event, so each profile shows every store a person
   * uses and the version they last ran there. */
  private personProperties(): { $set: Record<string, unknown>; $set_once: Record<string, unknown> } {
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
        first_seen: new Date(this.deps.now()).toISOString(),
      },
    };
  }

  /** Merge an earlier anonymous id of this install into its current anchor, once. */
  private async ensureAliased(identity: AnalyticsIdentity, options: TrackOptions = {}): Promise<void> {
    const earlier = identity.aliasOf;
    if (!earlier || !isAnalyticsId(earlier) || earlier === identity.anchorId) return;
    const state = await this.read();
    const marker = `once:alias:${earlier}`;
    if (state.daily[marker] !== undefined) return;
    await this.write({ ...state, daily: { ...state.daily, [marker]: "done" } });
    await this.push({
      event: "$create_alias",
      uuid: this.deps.uuid(),
      timestamp: this.timestamp({ quiet: options.quiet }),
      properties: { distinct_id: identity.anchorId, alias: earlier, $lib: "still", $geoip_disable: true },
    }, options);
  }

  private async ensureIdentified(identity: AnalyticsIdentity, options: TrackOptions = {}): Promise<void> {
    const state = await this.read();
    if (!state.userId || state.identifiedAs === state.userId) return;
    const person = this.personProperties();
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
    await this.ensureAliased(identity, options);
    await this.ensureIdentified(identity, options);
    const state = await this.read();
    const { surface, appVersion } = this.deps;
    const person = this.personProperties();
    await this.push({
      event: name,
      uuid: this.deps.uuid(),
      timestamp: this.timestamp(options),
      properties: {
        ...props,
        distinct_id: state.userId ?? this.anonymousId(state, identity),
        $device_id: identity.installId,
        $lib: "still",
        // Location is never derived from the connection (the privacy label declares none).
        $geoip_disable: true,
        surface,
        store: storeForSurface(surface),
        ...(isDeviceClass(this.deps.device) ? { device: this.deps.device } : {}),
        app_version: appVersion,
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

  private async post(batch: readonly QueuedEvent[]): Promise<"done" | "retry"> {
    const host = this.deps.config.host!.trim().replace(/\/+$/, "");
    try {
      const response = await this.deps.fetch(`${host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.deps.config.key!.trim(), batch }),
      });
      if (response.ok) return "done";
      // A request PostHog will never accept: drop it rather than block everything behind it.
      if (response.status === 400 || response.status === 413) return "done";
      return "retry";
    } catch {
      return "retry";
    }
  }
}
