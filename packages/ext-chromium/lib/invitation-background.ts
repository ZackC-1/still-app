// Background owner of the invitation ledger: the sync invitation (U13-P2) and the browser rating
// card (U13-P3) share this one handler, one ledger and one opening record per popup opening.
//
// Every browser ledger transaction runs here, in the service worker's single serialized storage
// queue (the settings authority's `serializeLocalMutation`). The popup and options page send
// messages; they never open their own port over chrome.storage.local. Only extension pages may
// ask: a content script never reaches this handler.
//
// Nothing here produces analytics. The closed catalogue's sync prompt events are left to U18, and
// the rating card has no events at all.
//
// Rules shared by both cards:
//   * One opening record. `present` records the popup opening once (its local day of use and the
//     first-run anchor), then the arbiter picks at most one card for it: sync before rating.
//   * At least 168 hours between ANY two invitations, sync or rating (BROWSER_INVITATION_PARAMETERS).
//   * The rating card's seven days count from the ledger's anchor: the later of the original-install
//     record's first-run time and the moment the ledger first learned it (newLedgerAnchor). No
//     known first-run time means rating never becomes due.
//   * A private (or unknown) window contributes nothing: no opening, no direct control, no anchor.
//   * Reserve here, commit from the popup immediately before the card renders. A rejected commit
//     shows nothing.
//   * The rating card also needs one fresh owner allowance for this opening (`rating.freshCheck`),
//     asked only when the ledger would offer it. A cached allowance never counts.

import {
  InvitationLedgerStore,
  INVITATION_LEDGER_KEY,
  parseInvitationLedger,
  serializedInvitationLedgerPort,
  validInvitationId,
  type InvitationControl,
  type InvitationKind,
  type InvitationLedgerPort,
  type InvitationOwnerParameters,
  type InvitationReservation,
} from "../../core/src/invitations/index.js";
import {
  newLedgerAnchor,
  recordRatingOpening,
  reserveRatingCard,
  type RatingAllowance,
  type RatingCardSurface,
} from "../../core/src/invitations/rating-allowance.js";

export const INVITATION_MESSAGE_KIND = "still:invitation";

/** Owner and coordinator rulings: the global pause counts (U13-P2), and the 168 hour spacing
 * applies between any two invitations, sync or rating (U13-P3). */
// The pure annotations let configured store-style builds drop this module entirely.
export const BROWSER_INVITATION_PARAMETERS: InvitationOwnerParameters = /* @__PURE__ */ Object.freeze({
  spaceRatingFromInvitations: true,
  countedControls: /* @__PURE__ */ Object.freeze(["site", "feature", "global"] as const),
});

/** A fact the popup already knows that would hide the card: a pending, failed or cautioned
 * sign-in/account state ("error"), or its own setup state ("setup"). */
export type InvitationHold = "setup" | "error";
const HOLDS: readonly InvitationHold[] = ["setup", "error"];

export type InvitationRequest =
  | {
      kind: typeof INVITATION_MESSAGE_KIND; op: "present"; opening: string; hold?: InvitationHold;
      /** Present and false only for a private (or unknown) window: the opening counts for nothing. */
      ordinary?: false;
    }
  | { kind: typeof INVITATION_MESSAGE_KIND; op: "commit"; reservation: InvitationReservation }
  | {
      kind: typeof INVITATION_MESSAGE_KIND; op: "control"; control: InvitationControl;
      /** Present and false only for a private (or unknown) window: the control counts for nothing. */
      ordinary?: false;
    };

export type InvitationReply =
  | { status: "unavailable" }
  | { status: "present"; card: { installation: string; reservation: InvitationReservation } | null }
  | { status: "commit"; committed: boolean }
  | { status: "control" };

const CONTROLS: readonly InvitationControl[] = ["site", "feature", "global"];
/** Cards a browser popup may commit. The link card is Apple-only. */
const COMMITTABLE: readonly InvitationKind[] = ["sync", "rating"];

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export function readInvitationRequest(message: unknown): InvitationRequest | null {
  if (!plain(message) || message.kind !== INVITATION_MESSAGE_KIND) return null;
  if (message.op === "present" && validInvitationId(message.opening)) {
    // Exactly kind, op and opening, plus optionally a named hold and optionally `ordinary: false`.
    const hasHold = Object.hasOwn(message, "hold"), hasOrdinary = Object.hasOwn(message, "ordinary");
    const keys = ["kind", "op", "opening", ...(hasHold ? ["hold"] : []), ...(hasOrdinary ? ["ordinary"] : [])];
    if (keysAre(message, keys) && (!hasHold || HOLDS.includes(message.hold as InvitationHold)) &&
        (!hasOrdinary || message.ordinary === false))
      return {
        kind: INVITATION_MESSAGE_KIND, op: "present", opening: message.opening,
        ...(hasHold ? { hold: message.hold as InvitationHold } : {}),
        ...(hasOrdinary ? { ordinary: false as const } : {}),
      };
  }
  if (message.op === "control" && CONTROLS.includes(message.control as InvitationControl)) {
    // Exactly kind, op and control, plus optionally `ordinary: false`.
    const hasOrdinary = Object.hasOwn(message, "ordinary");
    if (keysAre(message, ["kind", "op", "control", ...(hasOrdinary ? ["ordinary"] : [])]) && (!hasOrdinary || message.ordinary === false))
      return {
        kind: INVITATION_MESSAGE_KIND, op: "control", control: message.control as InvitationControl,
        ...(hasOrdinary ? { ordinary: false as const } : {}),
      };
  }
  if (message.op === "commit" && keysAre(message, ["kind", "op", "reservation"]) && plain(message.reservation)) {
    const r = message.reservation;
    if (keysAre(r, ["kind", "opening", "generation"]) && COMMITTABLE.includes(r.kind as InvitationKind) &&
        validInvitationId(r.opening) && Number.isSafeInteger(r.generation) && (r.generation as number) >= 0)
      return {
        kind: INVITATION_MESSAGE_KIND, op: "commit",
        reservation: { kind: r.kind as InvitationKind, opening: r.opening, generation: r.generation as number },
      };
  }
  return null;
}

export interface InvitationBackgroundDeps {
  readonly port: InvitationLedgerPort;
  /** True only when first-run is finished: Still has access to its four declared sites. */
  readonly setupFinished: () => Promise<boolean>;
  /** "unknown" is treated as signed in: it never counts and never shows a card. */
  readonly account: () => Promise<"signed-out" | "signed-in" | "unknown">;
  /** This build can actually sign someone in (the background session exists). */
  readonly signInAvailable: boolean;
  readonly now: () => number;
  readonly newInstallationId: () => string;
  /** The original-install record's first-run time (UTC ms), or null while unknown (which pauses
   * rating). Read only; never written here. */
  readonly firstRunAt?: () => Promise<number | null>;
  /** The rating card, where this build offers it. Absent: no rating card. */
  readonly rating?: {
    /** The popup surface this build is ("chrome" or "firefox"; never Safari). */
    readonly surface: RatingCardSurface;
    /** One fresh online allowance for this build's policy surface (Firefox for Android is
     * firefox_android). Anything but a fresh On is Off. */
    readonly freshCheck: () => Promise<RatingAllowance>;
  };
}

/**
 * How long the rating card's fresh allowance may take inside one `present` (U13-P3 time budget).
 * The popup gives `present` INVITATION_REPLY_TIMEOUT_MS (5 s). The background first reads the
 * account (at most ACCOUNT_READ_LIMIT_MS, 3 s, in parallel with the setup and first-run reads),
 * then a few local ledger transactions, then this allowance: 3 s + 1.5 s leaves half a second for
 * storage. A slower answer is simply Off for this opening, so a card never arrives after the popup
 * stopped waiting. The popup's own budget stays 5 s for every message, including the commit.
 */
export const BROWSER_RATING_ALLOWANCE_MS = 1_500;

export function createInvitationHost(deps: InvitationBackgroundDeps) {
  const store = new InvitationLedgerStore(deps.port, BROWSER_INVITATION_PARAMETERS);
  const safe = <T>(read: () => Promise<T>, fallback: T): Promise<T> => read().catch(() => fallback);
  const anchor = async (): Promise<number | null> => {
    const at = deps.firstRunAt ? await safe(deps.firstRunAt, null) : null;
    return typeof at === "number" && Number.isFinite(at) && at >= 0 && Number.isSafeInteger(Math.floor(at)) ? Math.floor(at) : null;
  };

  /** Create the ledger once (anchored no earlier than now), and fill a newly known anchor later. */
  async function ensure(): Promise<boolean> {
    const at = await anchor();
    if ((await store.ensure(deps.newInstallationId(), newLedgerAnchor(at, deps.now()))) !== "ready") return false;
    return at === null || (await store.adoptAnchor(newLedgerAnchor(at, deps.now())!)) === "ready";
  }
  const installation = () =>
    deps.port.transaction(raw => ({ write: null, result: parseInvitationLedger(raw)?.installation ?? null }));

  async function handle(request: InvitationRequest): Promise<InvitationReply> {
    // Facts are read before the transaction: a transaction body is synchronous and holds the queue.
    if (request.op === "present") {
      // A private window, or one whose privacy is unknown, counts for nothing: the ledger is not
      // read, created or written, no allowance is asked and no card is reserved.
      if (request.ordinary === false) return { status: "present", card: null };
      const [finished, account, at] = await Promise.all([
        safe(deps.setupFinished, false), safe(deps.account, "unknown" as const), anchor(),
      ]);
      const nowMs = deps.now();
      // The one opening record for this popup opening: ledger, anchor and day of use together.
      const opened = await recordRatingOpening(store, {
        installation: deps.newInstallationId(), anchorMs: at, opening: request.opening,
        ordinary: true, nowMs,
      });
      if (opened !== "ready") return { status: "present", card: null };
      const context = {
        opening: request.opening,
        nowMs,
        // An unknown account may be signed out: a due sync card still outranks rating, and shows
        // only when the account is known to be signed out.
        syncApplicable: deps.signInAvailable && account !== "signed-in",
        linkApplicable: false,
        suppressed: finished ? (request.hold ?? null) : ("setup" as const),
      };
      const decision = await store.arbitrate(context);
      let reservation: InvitationReservation | null = null;
      if (decision.kind === "sync" && account === "signed-out") {
        reservation = await store.reserve("sync", context);
      } else if (decision.kind === "rating" && deps.rating) {
        const rated = await reserveRatingCard(
          {
            store, freshCheck: deps.rating.freshCheck, now: deps.now, hostSurface: deps.rating.surface,
            timeoutMs: BROWSER_RATING_ALLOWANCE_MS,
          },
          { ...context, surface: deps.rating.surface },
        );
        reservation = rated.reserved ? rated.reservation : null;
      }
      const id = reservation ? await installation() : null;
      return { status: "present", card: reservation && id ? { installation: id, reservation } : null };
    }
    if (request.op === "commit") {
      return { status: "commit", committed: await store.commit(request.reservation, deps.now()) };
    }
    // A control made in a private (or unknown) window counts for nothing: the ledger is not
    // created, anchored or written.
    if (request.ordinary === false) return { status: "control" };
    const [finished, account] = await Promise.all([safe(deps.setupFinished, false), safe(deps.account, "unknown" as const)]);
    if (await ensure())
      await store.recordDirectControl({
        control: request.control,
        source: "direct",
        outcome: "succeeded",
        signedIn: account !== "signed-out",
        ready: finished,
      });
    return { status: "control" };
  }

  /** A runtime.onMessage listener for extension pages only. */
  function listener(extensionId: string, extensionOrigin: string) {
    return (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void): boolean => {
      const request = readInvitationRequest(message);
      if (!request) return false;
      if (sender.id !== extensionId || typeof sender.url !== "string" || !sender.url.startsWith(extensionOrigin)) return false;
      void handle(request).then(reply, () => reply({ status: "unavailable" } satisfies InvitationReply));
      return true;
    };
  }
  return { handle, listener };
}

/** The ledger slot over chrome.storage.local, serialized by the background's single queue. */
export function chromeInvitationLedgerPort(
  serialize: <T>(body: () => Promise<T>) => Promise<T>,
  area: Pick<chrome.storage.LocalStorageArea, "get" | "set">,
): InvitationLedgerPort {
  return serializedInvitationLedgerPort({
    serialize,
    read: async () => (await area.get(INVITATION_LEDGER_KEY))[INVITATION_LEDGER_KEY],
    write: async value => {
      await area.set({ [INVITATION_LEDGER_KEY]: value });
    },
  });
}

/** Site access for every declared host: Chrome grants it at install, Firefox asks once. */
export function declaredHostsGranted(
  permissions: Pick<typeof chrome.permissions, "contains">,
  manifest: object,
): Promise<boolean> {
  const hosts = (manifest as { host_permissions?: unknown }).host_permissions;
  const origins = Array.isArray(hosts)
    ? hosts.filter((o): o is string => typeof o === "string")
    : [];
  if (origins.length === 0) return Promise.resolve(false);
  return permissions.contains({ origins });
}

/**
 * The sign-in state as the background session reports it. Anything that is not a clean read is
 * "unknown": an offline refresh with an expired token returns `{ session: null, error }` for a
 * person who is in fact signed in, so an error, a rejection and a timeout must never read as
 * signed out. Unknown never counts a control and never shows a card.
 */
/** The longest the background waits for the sign-in state (see BROWSER_RATING_ALLOWANCE_MS). */
export const ACCOUNT_READ_LIMIT_MS = 3_000;

export async function readAccountState(
  auth: { getSession(): Promise<{ data: { session: unknown }; error?: unknown }> },
  timeoutMs = ACCOUNT_READ_LIMIT_MS,
): Promise<"signed-out" | "signed-in" | "unknown"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      auth.getSession().then(
        ({ data, error }): "signed-out" | "signed-in" | "unknown" => (error ? "unknown" : data.session ? "signed-in" : "signed-out"),
        () => "unknown" as const,
      ),
      new Promise<"unknown">(resolve => { timer = setTimeout(() => resolve("unknown"), timeoutMs); }),
    ]);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
