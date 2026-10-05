// Storage port for the invitation ledger. Ports only: no host wiring lives here (U13-P2/P3 do it).
//
// The ledger lives in one per-installation LOCAL slot, never in synced storage and never in any
// request. Every operation is one serialized read-modify-write so parallel hosts (two popups, the
// options page) see each other's reservations. Browser hosts compose the existing serialized
// storage authority (the settings writer's `serializeLocalMutation`) with chrome.storage.local;
// Apple hosts use StillKit's InvitationLedgerStore over the App Group atomic store.
//
// An absent slot is created only by `ensure`. An unreadable slot is never overwritten: every
// operation reports "unreadable", shows no card and writes nothing.

import {
  createInvitationLedger, parseInvitationLedger, recordInvitationDirectControl, recordInvitationOpening, recordInvitationPurchase,
  adoptInvitationAnchor, PROPOSED_INVITATION_PARAMETERS,
  type InvitationDirectControl, type InvitationKind, type InvitationLedger, type InvitationOpening, type InvitationOwnerParameters,
  type InvitationPurchaseEvent, type InvitationReservation,
} from "./ledger.js";
import {
  arbitrateInvitation, commitInvitation, releaseInvitation, reserveInvitation,
  type InvitationArbitration, type InvitationContext,
} from "./arbiter.js";

/** Local-only storage key. Must never appear in a synced area or a settings snapshot. */
export const INVITATION_LEDGER_KEY = "still:invitationLedger";

export interface InvitationLedgerPort {
  /**
   * Run `body` inside one serialized transaction over the raw stored value (undefined when
   * absent). When `body` returns a ledger in `write`, persist it before resolving.
   */
  transaction<T>(body: (raw: unknown) => { readonly write: InvitationLedger | null; readonly result: T }): Promise<T>;
}

/** Compose an existing serialized authority with a local key-value area. */
export function serializedInvitationLedgerPort(options: {
  readonly serialize: <T>(body: () => Promise<T>) => Promise<T>;
  readonly read: () => Promise<unknown>;
  readonly write: (value: InvitationLedger) => Promise<void>;
}): InvitationLedgerPort {
  return {
    transaction: body => options.serialize(async () => {
      const { write, result } = body(await options.read());
      if (write) await options.write(structuredClone(write));
      return result;
    }),
  };
}

/** Test double and the base for hosts without their own queue: an in-memory serialized slot. */
export class InMemoryInvitationLedgerPort implements InvitationLedgerPort {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(public value: unknown = undefined) {}
  transaction<T>(body: (raw: unknown) => { readonly write: InvitationLedger | null; readonly result: T }): Promise<T> {
    const run = this.tail.then(async () => {
      await Promise.resolve();
      const { write, result } = body(structuredClone(this.value));
      if (write) this.value = structuredClone(write);
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export type InvitationStoreStatus = "ready" | "absent" | "unreadable";

export class InvitationLedgerStore {
  constructor(
    private readonly port: InvitationLedgerPort,
    private readonly parameters: InvitationOwnerParameters = PROPOSED_INVITATION_PARAMETERS,
  ) {}

  private run<T>(onLedger: (ledger: InvitationLedger) => { write: InvitationLedger | null; result: T }, fallback: (status: InvitationStoreStatus) => T): Promise<T> {
    return this.port.transaction(raw => {
      if (raw === undefined || raw === null) return { write: null, result: fallback("absent") };
      const ledger = parseInvitationLedger(raw);
      if (!ledger) return { write: null, result: fallback("unreadable") };
      return onLedger(ledger);
    });
  }
  private update(change: (ledger: InvitationLedger) => InvitationLedger): Promise<InvitationStoreStatus> {
    return this.run(ledger => {
      const next = change(ledger);
      return { write: next === ledger ? null : next, result: "ready" as const };
    }, status => status);
  }

  /** Create the ledger once for this installation; an existing or unreadable one is kept as is. */
  ensure(installation: string, anchorMs: number | null): Promise<InvitationStoreStatus> {
    return this.port.transaction(raw => {
      if (raw !== undefined && raw !== null) return { write: null, result: parseInvitationLedger(raw) ? "ready" : "unreadable" };
      const created = createInvitationLedger(installation, anchorMs);
      return { write: created, result: created ? "ready" : "absent" };
    });
  }
  adoptAnchor(anchorMs: number): Promise<InvitationStoreStatus> {
    return this.update(l => adoptInvitationAnchor(l, anchorMs));
  }
  recordOpening(input: InvitationOpening): Promise<InvitationStoreStatus> {
    return this.update(l => recordInvitationOpening(l, input));
  }
  recordDirectControl(input: InvitationDirectControl): Promise<InvitationStoreStatus> {
    return this.update(l => recordInvitationDirectControl(l, input, this.parameters));
  }
  recordPurchase(input: InvitationPurchaseEvent): Promise<InvitationStoreStatus> {
    return this.update(l => recordInvitationPurchase(l, input));
  }
  /** Read-only decision for this opening. An absent or unreadable ledger never offers a card. */
  arbitrate(context: InvitationContext): Promise<InvitationArbitration> {
    return this.run(
      ledger => ({ write: null, result: arbitrateInvitation(ledger, context, this.parameters) }),
      () => ({ kind: null, reason: "none" }),
    );
  }
  /** Reserve before rendering. Null means another host, state change or suppression won. */
  reserve(kind: InvitationKind, context: InvitationContext): Promise<InvitationReservation | null> {
    return this.run(ledger => {
      const r = reserveInvitation(ledger, kind, context, this.parameters);
      return r.ok ? { write: r.ledger, result: r.reservation } : { write: null, result: null };
    }, () => null);
  }
  /** Consume immediately before visibility. False means do not show the card. */
  commit(reservation: InvitationReservation, nowMs: number): Promise<boolean> {
    return this.run(ledger => {
      const next = commitInvitation(ledger, reservation, nowMs);
      return { write: next, result: next !== null };
    }, () => false);
  }
  /** Release only after a failure definitely before visibility. */
  release(reservation: InvitationReservation): Promise<boolean> {
    return this.run(ledger => {
      const next = releaseInvitation(ledger, reservation);
      return { write: next, result: next !== null };
    }, () => false);
  }
}
