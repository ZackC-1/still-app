// Background owner of the sync invitation ledger (U13-P2).
//
// Every browser ledger transaction runs here, in the service worker's single serialized storage
// queue (the settings authority's `serializeLocalMutation`). The popup and options page send
// messages; they never open their own port over chrome.storage.local. Only extension pages may
// ask: a content script never reaches this handler.
//
// Nothing here produces analytics. The closed catalogue's sync prompt events are left to U18.

import {
  InvitationLedgerStore,
  INVITATION_LEDGER_KEY,
  localDayOrdinal,
  parseInvitationLedger,
  serializedInvitationLedgerPort,
  validInvitationId,
  type InvitationControl,
  type InvitationLedgerPort,
  type InvitationOwnerParameters,
  type InvitationReservation,
} from "../../core/src/invitations/index.js";

export const INVITATION_MESSAGE_KIND = "still:invitation";

/** Owner rulings for U13-P2: the global pause counts, and rating is not spaced from sync cards. */
// The pure annotations let configured store-style builds drop this module entirely.
export const SYNC_INVITATION_PARAMETERS: InvitationOwnerParameters = /* @__PURE__ */ Object.freeze({
  spaceRatingFromInvitations: false,
  countedControls: /* @__PURE__ */ Object.freeze(["site", "feature", "global"] as const),
});

export type InvitationRequest =
  | { kind: typeof INVITATION_MESSAGE_KIND; op: "present"; opening: string }
  | { kind: typeof INVITATION_MESSAGE_KIND; op: "commit"; reservation: InvitationReservation }
  | { kind: typeof INVITATION_MESSAGE_KIND; op: "control"; control: InvitationControl };

export type InvitationReply =
  | { status: "unavailable" }
  | { status: "present"; card: { installation: string; reservation: InvitationReservation } | null }
  | { status: "commit"; committed: boolean }
  | { status: "control" };

const CONTROLS: readonly InvitationControl[] = ["site", "feature", "global"];

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export function readInvitationRequest(message: unknown): InvitationRequest | null {
  if (!plain(message) || message.kind !== INVITATION_MESSAGE_KIND) return null;
  if (message.op === "present" && keysAre(message, ["kind", "op", "opening"]) && validInvitationId(message.opening))
    return { kind: INVITATION_MESSAGE_KIND, op: "present", opening: message.opening };
  if (message.op === "control" && keysAre(message, ["kind", "op", "control"]) && CONTROLS.includes(message.control as InvitationControl))
    return { kind: INVITATION_MESSAGE_KIND, op: "control", control: message.control as InvitationControl };
  if (message.op === "commit" && keysAre(message, ["kind", "op", "reservation"]) && plain(message.reservation)) {
    const r = message.reservation;
    if (keysAre(r, ["kind", "opening", "generation"]) && r.kind === "sync" && validInvitationId(r.opening) &&
        Number.isSafeInteger(r.generation) && (r.generation as number) >= 0)
      return { kind: INVITATION_MESSAGE_KIND, op: "commit", reservation: { kind: "sync", opening: r.opening, generation: r.generation as number } };
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
}

export function createInvitationHost(deps: InvitationBackgroundDeps) {
  const store = new InvitationLedgerStore(deps.port, SYNC_INVITATION_PARAMETERS);
  const safe = <T>(read: () => Promise<T>, fallback: T): Promise<T> => read().catch(() => fallback);

  async function ensure(): Promise<boolean> {
    return (await store.ensure(deps.newInstallationId(), null)) === "ready";
  }
  const installation = () =>
    deps.port.transaction(raw => ({ write: null, result: parseInvitationLedger(raw)?.installation ?? null }));

  async function handle(request: InvitationRequest): Promise<InvitationReply> {
    // Facts are read before the transaction: a transaction body is synchronous and holds the queue.
    if (request.op === "present") {
      const [finished, account] = await Promise.all([safe(deps.setupFinished, false), safe(deps.account, "unknown" as const)]);
      if (!(await ensure())) return { status: "present", card: null };
      const nowMs = deps.now();
      if ((await store.recordOpening({ opening: request.opening, ordinary: true, nowMs, localDay: localDayOrdinal(nowMs) })) !== "ready")
        return { status: "present", card: null };
      const reservation = await store.reserve("sync", {
        opening: request.opening,
        nowMs,
        syncApplicable: deps.signInAvailable && account === "signed-out",
        linkApplicable: false,
        suppressed: finished ? null : "setup",
      });
      const id = reservation ? await installation() : null;
      return { status: "present", card: reservation && id ? { installation: id, reservation } : null };
    }
    if (request.op === "commit") {
      return { status: "commit", committed: await store.commit(request.reservation, deps.now()) };
    }
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
