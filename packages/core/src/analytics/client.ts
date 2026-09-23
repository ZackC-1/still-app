import {
  storeForSurface,
  validateEvent,
  type AnalyticsEventName,
  type AnalyticsEventProps,
  type AnalyticsSurface,
} from "./events.js";
import type { AnalyticsIdentity, AnalyticsKeyValue } from "./identity.js";

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
  readonly appVersion: string;
  /** Where the queue and the per-day markers persist. */
  readonly store: AnalyticsKeyValue;
  /** This install's ids (see identity.ts). Called once and memoised. */
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
  readonly queue: readonly QueuedEvent[];
  /** The signed-in account this install currently reports as, or null. */
  readonly userId: string | null;
  /** The account a `$identify` has already been queued for, so it is sent once per sign-in. */
  readonly identifiedAs: string | null;
  /** Marker → local calendar day it last fired, for once-a-day events; `once:` markers → "done". */
  readonly daily: Readonly<Record<string, string>>;
}

const EMPTY_STATE: ClientState = { queue: [], userId: null, identifiedAs: null, daily: {} };

function parseState(value: unknown): ClientState {
  if (typeof value !== "object" || value === null) return EMPTY_STATE;
  const v = value as Record<string, unknown>;
  return {
    queue: Array.isArray(v.queue) ? (v.queue as QueuedEvent[]).slice(-MAX_QUEUE) : [],
    userId: typeof v.userId === "string" ? v.userId : null,
    identifiedAs: typeof v.identifiedAs === "string" ? v.identifiedAs : null,
    daily:
      typeof v.daily === "object" && v.daily !== null ? (v.daily as Record<string, string>) : {},
  };
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

export class AnalyticsClient {
  private readonly configured: boolean;
  private chain: Promise<unknown> = Promise.resolve();
  private identityPromise: Promise<AnalyticsIdentity> | null = null;
  private flushScheduled = false;

  constructor(private readonly deps: AnalyticsClientDeps) {
    this.configured = analyticsConfigured(deps.config);
  }

  get enabled(): boolean {
    return this.configured;
  }

  /** Queue one event. Invalid events and events while analytics is off are dropped silently. */
  track<E extends AnalyticsEventName>(name: E, props: AnalyticsEventProps<E>): Promise<void> {
    return this.trackUnchecked(name, props);
  }

  /** `track` for input that arrived untyped (a runtime message); validated the same way. */
  trackUnchecked(name: unknown, props: unknown): Promise<void> {
    return this.run(async () => {
      if (!(await this.allowed())) return;
      const valid = validateEvent(name, props);
      if (!valid) return;
      await this.enqueue(name as string, valid);
    });
  }

  /** Queue an event at most once per local calendar day for `marker`. */
  trackDaily<E extends AnalyticsEventName>(
    marker: string,
    name: E,
    props: AnalyticsEventProps<E>,
  ): Promise<void> {
    return this.run(async () => {
      if (!(await this.allowed())) return;
      const valid = validateEvent(name, props);
      if (!valid) return;
      const state = await this.read();
      const today = localDay(this.deps.now());
      if (state.daily[marker] === today) return;
      await this.write({ ...state, daily: { ...state.daily, [marker]: today } });
      await this.enqueue(name, valid);
    });
  }

  /** Queue an event once in the life of this install for `marker` (setup milestones). */
  trackOnce<E extends AnalyticsEventName>(
    marker: string,
    name: E,
    props: AnalyticsEventProps<E>,
  ): Promise<void> {
    return this.run(async () => {
      if (!(await this.allowed())) return;
      const valid = validateEvent(name, props);
      if (!valid) return;
      const state = await this.read();
      const key = `once:${marker}`;
      if (state.daily[key] !== undefined) return;
      await this.write({ ...state, daily: { ...state.daily, [key]: "done" } });
      await this.enqueue(name, valid);
    });
  }

  /** Attribute this install to a signed-in account from now on. Idempotent per account. */
  identify(userId: string): Promise<void> {
    return this.run(async () => {
      if (!this.configured || !userId) return;
      const state = await this.read();
      if (state.userId !== userId) await this.write({ ...state, userId });
      if (await this.deps.consent()) await this.ensureIdentified();
    });
  }

  /** Stop attributing to the account (sign-out, deletion). Later events use the anonymous id. */
  reset(): Promise<void> {
    return this.run(async () => {
      if (!this.configured) return;
      const state = await this.read();
      await this.write({ ...state, userId: null, identifiedAs: null });
    });
  }

  /** Drop everything waiting to be sent: the person turned analytics off. */
  clearQueue(): Promise<void> {
    return this.run(async () => {
      const state = await this.read();
      if (state.queue.length > 0) await this.write({ ...state, queue: [] });
    });
  }

  /** Send what is queued. Keeps events on a network or server failure so the next flush retries. */
  flush(): Promise<void> {
    return this.run(async () => {
      if (!(await this.allowed())) return;
      for (;;) {
        const state = await this.read();
        const batch = state.queue.slice(0, BATCH_SIZE);
        if (batch.length === 0) return;
        const outcome = await this.post(batch);
        if (outcome === "retry") return;
        // Sent, or rejected as malformed (retrying a 400 forever would block the queue).
        const after = await this.read();
        const sent = new Set(batch.map((e) => e.uuid));
        await this.write({ ...after, queue: after.queue.filter((e) => !sent.has(e.uuid)) });
      }
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async allowed(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      return await this.deps.consent();
    } catch {
      return false;
    }
  }

  private identity(): Promise<AnalyticsIdentity> {
    this.identityPromise ??= this.deps.identity();
    return this.identityPromise;
  }

  private async read(): Promise<ClientState> {
    try {
      return parseState(await this.deps.store.get(STATE_KEY));
    } catch {
      return EMPTY_STATE;
    }
  }

  private async write(state: ClientState): Promise<void> {
    try {
      await this.deps.store.set(STATE_KEY, state);
    } catch {
      /* A failed write costs these events, never a working surface. */
    }
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
      },
      $set_once: {
        first_surface: surface,
        first_store: store,
        first_seen: new Date(this.deps.now()).toISOString(),
      },
    };
  }

  private async ensureIdentified(): Promise<void> {
    const state = await this.read();
    if (!state.userId || state.identifiedAs === state.userId) return;
    const identity = await this.identity();
    const person = this.personProperties();
    const event: QueuedEvent = {
      event: "$identify",
      uuid: this.deps.uuid(),
      timestamp: new Date(this.deps.now()).toISOString(),
      properties: {
        distinct_id: state.userId,
        $anon_distinct_id: identity.anchorId,
        $device_id: identity.installId,
        $lib: "still",
        $set: { ...person.$set, signed_in: true },
        $set_once: person.$set_once,
      },
    };
    await this.write({
      ...state,
      identifiedAs: state.userId,
      queue: [...state.queue, event].slice(-MAX_QUEUE),
    });
    this.scheduleFlush();
  }

  private async enqueue(name: string, props: Record<string, boolean | string>): Promise<void> {
    await this.ensureIdentified();
    const identity = await this.identity();
    const state = await this.read();
    const { surface, appVersion } = this.deps;
    const person = this.personProperties();
    const event: QueuedEvent = {
      event: name,
      uuid: this.deps.uuid(),
      timestamp: new Date(this.deps.now()).toISOString(),
      properties: {
        ...props,
        distinct_id: state.userId ?? identity.anchorId,
        $device_id: identity.installId,
        $lib: "still",
        surface,
        store: storeForSurface(surface),
        app_version: appVersion,
        signed_in: state.userId !== null,
        $set: name === "signed_out" ? { ...person.$set, signed_in: false } : person.$set,
        $set_once: person.$set_once,
      },
    };
    await this.write({ ...state, queue: [...state.queue, event].slice(-MAX_QUEUE) });
    this.scheduleFlush();
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
