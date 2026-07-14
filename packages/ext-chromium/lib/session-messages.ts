import type {
  CheckoutPendingRecord,
  ExtensionSession,
  ExtensionSessionState,
  RequestCodeOutcome,
  SessionReconcileOutcome,
} from "@still/core/sync";

// The popup/options <-> background protocol. Capabilities are declared once below: the registry
// derives the request union, response map, unavailable values, and exhaustive dispatcher from its
// keys. Content scripts keep their separate, low-privilege `{ kind: "reconcile" }` nudge.
export const SESSION_MESSAGE_KIND = "still:session";

interface Base {
  readonly kind: typeof SESSION_MESSAGE_KIND;
}

interface SessionCapability<Payload, Response> {
  readonly dispatch: (session: ExtensionSession, payload: Payload) => Promise<Response>;
  readonly unavailable: Response;
  readonly validates: (message: Record<string, unknown>) => boolean;
}

function defineSessionCapability<Payload, Response>(
  dispatch: (session: ExtensionSession, payload: Payload) => Promise<Response>,
  unavailable: Response,
  validates: (message: Record<string, unknown>) => boolean = () => true,
): SessionCapability<Payload, Response> {
  return { dispatch, unavailable, validates };
}

export const SESSION_PROTOCOL = {
  getState: defineSessionCapability(
    (session, _payload: Record<never, never>) => session.getState(),
    { userId: null, entitled: false, checkoutPending: null, pendingOtp: null } satisfies ExtensionSessionState,
  ),
  requestCode: defineSessionCapability(
    (session, payload: { readonly email: string }) => session.requestCode(payload.email),
    { kind: "send-failed" } satisfies RequestCodeOutcome,
    (message) => typeof message.email === "string",
  ),
  verifyCode: defineSessionCapability(
    (session, payload: { readonly email: string; readonly token: string }) =>
      session.verifyCode(payload.email, payload.token),
    { kind: "verify-failed" },
    (message) => typeof message.email === "string" && typeof message.token === "string",
  ),
  signOut: defineSessionCapability(
    (session, _payload: Record<never, never>) => session.signOut(),
    "signed-out",
  ),
  deleteAccount: defineSessionCapability(
    (session, _payload: Record<never, never>) => session.deleteAccount(),
    "delete-failed",
  ),
  reconcile: defineSessionCapability(
    (session, _payload: Record<never, never>) => session.reconcile(),
    "unknown" satisfies SessionReconcileOutcome,
  ),
  // A web restore is still a reconcile, but its caller maps the same outcome vocabulary to the
  // restore button's controller actions. Keep this wire action explicit for that UI contract.
  restore: defineSessionCapability(
    (session, _payload: Record<never, never>) => session.restore(),
    "unknown" satisfies SessionReconcileOutcome,
  ),
  createCheckout: defineSessionCapability(
    (session, _payload: Record<never, never>) => session.createCheckout(),
    { kind: "unavailable" },
  ),
  setPendingOtp: defineSessionCapability(
    async (session, payload: { readonly pending: { readonly email: string; readonly requestedAt: number } | null }) => {
      await session.setPendingOtp(payload.pending);
      return "ok" as const;
    },
    "ok",
    (message) => message.pending === null || isPendingOtp(message.pending),
  ),
  setPurchaseIntent: defineSessionCapability(
    async (session, payload: { readonly active: boolean }) => {
      await session.setPurchaseIntent(payload.active);
      return "ok" as const;
    },
    "ok",
    (message) => typeof message.active === "boolean",
  ),
  setCheckoutPending: defineSessionCapability(
    async (session, payload: { readonly pending: CheckoutPendingRecord | null }) => {
      await session.setCheckoutPending(payload.pending);
      return "ok" as const;
    },
    "ok",
    (message) => message.pending === null || isCheckoutPending(message.pending),
  ),
} as const;

type Protocol = typeof SESSION_PROTOCOL;
export type SessionAction = keyof Protocol;
type SessionPayload<A extends SessionAction> = Protocol[A] extends SessionCapability<infer Payload, unknown>
  ? Payload
  : never;
type SessionResponse<A extends SessionAction> = Protocol[A] extends SessionCapability<infer _Payload, infer Response>
  ? Response
  : never;

export type SessionRequest = {
  [A in SessionAction]: Base & { readonly action: A } & SessionPayload<A>;
}[SessionAction];

export type SessionResponses = { [A in SessionAction]: SessionResponse<A> };

const SESSION_ACTIONS = new Set<SessionAction>(Object.keys(SESSION_PROTOCOL) as SessionAction[]);

export function isSessionRequest(message: unknown): message is SessionRequest {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { kind?: unknown; action?: unknown; [key: string]: unknown };
  if (m.kind !== SESSION_MESSAGE_KIND || typeof m.action !== "string" || !SESSION_ACTIONS.has(m.action as SessionAction)) {
    return false;
  }
  return SESSION_PROTOCOL[m.action as SessionAction].validates(m);
}

function isPendingOtp(value: unknown): value is { readonly email: string; readonly requestedAt: number } {
  return typeof value === "object" && value !== null &&
    typeof (value as { email?: unknown }).email === "string" &&
    typeof (value as { requestedAt?: unknown }).requestedAt === "number";
}

function isCheckoutPending(value: unknown): value is CheckoutPendingRecord {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as { startedAt?: unknown; tabId?: unknown };
  return (pending.startedAt === undefined || typeof pending.startedAt === "number") &&
    (pending.tabId === undefined || typeof pending.tabId === "number");
}

/** The registry-owned fail-safe for a spine-less build, unreachable background, or torn handler. */
export function unavailableResponse<A extends SessionAction>(action: A): SessionResponses[A] {
  return SESSION_PROTOCOL[action].unavailable as SessionResponses[A];
}

/** Dispatch one already-validated request. The registry's key lookup is exhaustive by construction. */
export async function dispatchSession(
  session: ExtensionSession | null,
  request: SessionRequest,
): Promise<SessionResponses[SessionAction]> {
  if (session === null) return unavailableResponse(request.action);
  try {
    const capability = SESSION_PROTOCOL[request.action] as SessionCapability<unknown, SessionResponses[SessionAction]>;
    return await capability.dispatch(session, request);
  } catch {
    return unavailableResponse(request.action);
  }
}

export interface SessionMessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: unknown;
}

/** Popup/options pages (including embedded options) are privileged; page content scripts are not. */
export function isExtensionPageSender(
  sender: SessionMessageSender,
  runtimeId: string,
  extensionOrigin: string,
): boolean {
  return sender.id === runtimeId && typeof sender.url === "string" && sender.url.startsWith(extensionOrigin);
}

export type SessionMessageListener = (
  message: unknown,
  sender: SessionMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

/** Thin background listener wiring, extracted so the actual popup-to-background transport is testable. */
export function createSessionMessageRouter(
  session: ExtensionSession | null,
  runtimeId: string,
  extensionOrigin: string,
): SessionMessageListener {
  return (message, sender, sendResponse) => {
    if (!isSessionRequest(message) || !isExtensionPageSender(sender, runtimeId, extensionOrigin)) return false;
    void dispatchSession(session, message).then(sendResponse).catch(() => {});
    return true;
  };
}
