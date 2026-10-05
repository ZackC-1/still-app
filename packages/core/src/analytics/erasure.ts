import type { AnalyticsPermission } from "./consent.js";
import { ANON_INDEX_LIMIT, deriveAnonymousId, originProof } from "./derive.js";
import { isAnalyticsId, type AnalyticsKeyValue } from "./identity.js";

// Device-slice erasure on the device (U5-W2, D144). Turning "Share email and usage data" off on one
// device deletes what that device shared and nothing from the person's other devices.
//
// Order (the local stop always comes first and needs no network):
//   1. The host stops sharing locally (permission stopped, queue discarded and verified empty).
//   2. `record` writes a durable obligation to the erasure ledger, in the same store as the
//      permission: the stopped origin, its first anonymous id and the last anonymous index used.
//   3. `kick`, at an ordinary Still screen only (never a background start), sends
//      {action: "device", originProof, anonymousIds} to analytics-erasure, retries an unsent entry
//      at every later screen, and follows a sent one with status checks until it is deleted.
//
// What leaves the device: the origin proof (a one-way hash of the private origin) and the anonymous
// ids the device itself sent under. Never the origin, never an account id, never an email. No
// farewell event is sent. No account is needed.
//
// The states map onto the sharing card's approved withdrawal lines (v3.2 SharingSetting):
//   failed    "We couldn't send your deletion request. Sharing stays off on this device." + "Try again"
//   requested "Deletion requested. Your shared data hasn't been deleted yet."
//   verifying "Confirming deletion with our providers…"
//   deleted   "Your shared data has been deleted."
// Pending is never success: only the server's confirmed stage reads as deleted.

export const ERASURE_LEDGER_KEY = "still:analytics:erasures";
/** The newest entries are kept; an older entry is dropped only once it is deleted, or to make room. */
export const ERASURE_LEDGER_LIMIT = 8;
/** Longest one erasure request may take. */
export const ERASURE_REQUEST_LIMIT_MS = 15_000;

export type ErasureEntryState = "unsent" | "requested" | "verifying" | "deleted";
/** The sharing card's `withdrawal` prop (ui/v3/SharingCard.svelte). */
export type ErasureWithdrawal = "none" | "requested" | "verifying" | "deleted" | "failed";

export interface ErasureEntry {
  readonly origin: string;
  readonly firstAnonymousId: string;
  readonly anonIndex: number;
  readonly state: ErasureEntryState;
  /** An attempt to send it failed; cleared when the server accepts it. */
  readonly failed: boolean;
  /** The deleted outcome was shown; the entry then only keeps the origin's cleanup owned. */
  readonly shown: boolean;
  readonly requestedAt: number;
}

export type ErasureRequest =
  | { readonly action: "device"; readonly originProof: string; readonly anonymousIds: readonly string[] }
  | { readonly action: "status"; readonly originProof: string };

/** POST the body to analytics-erasure; resolve the parsed JSON of a 2xx reply, reject otherwise. */
export type ErasureTransport = (body: ErasureRequest, signal: AbortSignal) => Promise<unknown>;

export interface ErasureService {
  /** Durably record the obligation for a permission that has just been stopped. False when the
   * store refused or did not keep it (the stopped tombstone then keeps refusing a new Share). */
  record(permission: AnalyticsPermission, anonIndex: number): Promise<boolean>;
  /** Whether this origin's cleanup is durably owned here (consent.ts `cleanupOwned`). */
  owns(origin: string): Promise<boolean>;
  /** Send unsent entries and follow sent ones. Ordinary Still screens only. */
  kick(): Promise<void>;
  /** "Try again": the same as kick. */
  retry(): Promise<void>;
  /** The newest entry's state for the sharing card. */
  withdrawal(): Promise<ErasureWithdrawal>;
  /** The deleted line has been shown: stop showing it. */
  acknowledge(): Promise<void>;
}

const STATES: readonly ErasureEntryState[] = ["unsent", "requested", "verifying", "deleted"];

function readLedger(value: unknown): ErasureEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is ErasureEntry => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const e = v as Record<string, unknown>;
    return (
      isAnalyticsId(e.origin) &&
      isAnalyticsId(e.firstAnonymousId) &&
      Number.isSafeInteger(e.anonIndex) &&
      (e.anonIndex as number) >= 0 &&
      (e.anonIndex as number) <= ANON_INDEX_LIMIT &&
      STATES.includes(e.state as ErasureEntryState) &&
      typeof e.failed === "boolean" &&
      typeof e.shown === "boolean" &&
      Number.isFinite(e.requestedAt)
    );
  });
}

/** Keep the newest entries; make room by dropping the oldest deleted ones first. */
function bounded(entries: ErasureEntry[]): ErasureEntry[] {
  const kept = [...entries];
  while (kept.length > ERASURE_LEDGER_LIMIT) {
    const deleted = kept.findIndex((e) => e.state === "deleted");
    kept.splice(deleted >= 0 && deleted < kept.length - 1 ? deleted : 0, 1);
  }
  return kept;
}

function serverState(value: unknown): ErasureEntryState | "none" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = (value as Record<string, unknown>).state;
  return state === "none" || state === "requested" || state === "verifying" || state === "deleted" ? state : null;
}

export function createErasureService(deps: {
  readonly store: AnalyticsKeyValue;
  /** Absent on builds without a server: entries stay unsent and read as failed after a kick. */
  readonly transport?: ErasureTransport;
  readonly now?: () => number;
}): ErasureService {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(op: () => Promise<T>): Promise<T> => {
    const next = chain.then(op, op);
    chain = next.catch(() => undefined);
    return next;
  };
  const load = async (): Promise<ErasureEntry[] | null> => {
    try {
      return readLedger(await deps.store.get(ERASURE_LEDGER_KEY));
    } catch {
      return null;
    }
  };
  const save = async (entries: ErasureEntry[]): Promise<boolean> => {
    try {
      await deps.store.set(ERASURE_LEDGER_KEY, bounded(entries));
      return true;
    } catch {
      return false;
    }
  };
  const update = async (origin: string, change: (e: ErasureEntry) => ErasureEntry): Promise<void> => {
    const entries = await load();
    if (!entries) return;
    await save(entries.map((e) => (e.origin === origin ? change(e) : e)));
  };
  const send = async (body: ErasureRequest): Promise<unknown> => {
    if (!deps.transport) throw new Error("No erasure transport");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        deps.transport(body, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, ERASURE_REQUEST_LIMIT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const anonymousIds = async (entry: ErasureEntry): Promise<string[]> => {
    const later = await Promise.all(
      Array.from({ length: entry.anonIndex }, (_, k) => deriveAnonymousId(entry.origin, k + 1)),
    );
    return [...new Set([entry.firstAnonymousId.toLowerCase(), ...later])];
  };
  const advance = async (entry: ErasureEntry): Promise<void> => {
    if (entry.state === "deleted") return;
    const proof = await originProof(entry.origin);
    let state: ReturnType<typeof serverState>;
    try {
      state = serverState(
        entry.state === "unsent"
          ? await send({ action: "device", originProof: proof, anonymousIds: await anonymousIds(entry) })
          : await send({ action: "status", originProof: proof }),
      );
    } catch {
      state = null;
    }
    if (state === null) {
      // Not sent (offline, server down, refused): sharing stays off; retried at the next screen.
      if (entry.state === "unsent") await update(entry.origin, (e) => ({ ...e, failed: true }));
      return;
    }
    // A status of "none" means the server has no record: send the request again.
    const next: ErasureEntryState = state === "none" ? "unsent" : state;
    await update(entry.origin, (e) => ({ ...e, state: next, failed: false }));
  };

  const kick = (): Promise<void> =>
    run(async () => {
      const entries = await load();
      for (const entry of entries ?? []) await advance(entry);
    });

  return {
    record(permission, anonIndex) {
      return run(async () => {
        if (
          !isAnalyticsId(permission.origin) ||
          !isAnalyticsId(permission.provider.anonymousId) ||
          !Number.isSafeInteger(anonIndex) ||
          anonIndex < 0 ||
          anonIndex > ANON_INDEX_LIMIT
        )
          return false;
        const entries = await load();
        if (!entries) return false;
        const existing = entries.find((e) => e.origin === permission.origin);
        const entry: ErasureEntry = existing
          ? { ...existing, anonIndex: Math.max(existing.anonIndex, anonIndex) }
          : {
              origin: permission.origin,
              firstAnonymousId: permission.provider.anonymousId,
              anonIndex,
              state: "unsent",
              failed: false,
              shown: false,
              requestedAt: (deps.now ?? Date.now)(),
            };
        if (!(await save([...entries.filter((e) => e.origin !== permission.origin), entry]))) return false;
        // Durable means read back, not merely accepted.
        return !!(await load())?.some((e) => e.origin === entry.origin && e.anonIndex === entry.anonIndex);
      });
    },
    owns(origin) {
      return run(async () => !!(await load())?.some((e) => e.origin === origin));
    },
    kick,
    retry: kick,
    withdrawal() {
      return run(async () => {
        const newest = (await load())?.at(-1);
        if (!newest) return "none";
        switch (newest.state) {
          case "unsent":
            return newest.failed ? "failed" : "none";
          case "deleted":
            return newest.shown ? "none" : "deleted";
          default:
            return newest.state;
        }
      });
    },
    acknowledge() {
      return run(async () => {
        const entries = await load();
        if (!entries) return;
        await save(entries.map((e) => (e.state === "deleted" ? { ...e, shown: true } : e)));
      });
    },
  };
}
