/** Controlled observations only. The host owns durable admission and real effects. */
export interface InvitationIdentity {
  installation: string;
  opening: string;
  surface: string;
}
export interface InvitationIntentPort {
  identity: InvitationIdentity;
  verified: boolean;
  status: "ready" | "pending" | "unknown";
  request: () => void;
}
export interface PopupInvitationPresentation {
  identity: InvitationIdentity;
  kind: "rating" | "sync" | "link";
  verified: boolean;
  fresh: boolean;
  status: "ready" | "pending" | "consumed" | "unknown";
  ordinaryOpening: boolean;
  suppressed?:
    "setup" | "consent" | "error" | "purchase" | "restore" | "another-prompt";
  rating?: {
    allowance: {
      verified: boolean;
      fresh: boolean;
      global: boolean;
      surface: boolean;
    };
    eligibility: {
      verified: boolean;
      ageDays: number;
      distinctUseDays: number;
      laterOpening: boolean;
    };
    /** Already admitted at display, never inferred from a callback or an acceptance. */
    display: {
      verified: boolean;
      fresh: boolean;
      status: "admitted" | "pending" | "consumed" | "unknown";
      receiptId: string;
      identity: InvitationIdentity;
    };
  };
  accept?: InvitationIntentPort;
  dismiss?: InvitationIntentPort;
}

export function sameInvitationIdentity(
  a: InvitationIdentity,
  b: InvitationIdentity,
): boolean {
  return (
    a.installation === b.installation &&
    a.opening === b.opening &&
    a.surface === b.surface
  );
}

export function invitationVisible(
  p: PopupInvitationPresentation | undefined,
): p is PopupInvitationPresentation {
  if (
    !p ||
    !p.verified ||
    !p.fresh ||
    p.status !== "ready" ||
    !p.ordinaryOpening ||
    p.suppressed ||
    !p.identity.installation.trim() ||
    !p.identity.opening.trim() ||
    !p.identity.surface.trim()
  )
    return false;
  if (p.kind !== "rating") return true;
  const r = p.rating;
  return Boolean(
    r &&
    ["chrome", "firefox", "firefox-android"].includes(p.identity.surface) &&
    r.allowance.verified &&
    r.allowance.fresh &&
    r.allowance.global &&
    r.allowance.surface &&
    r.eligibility.verified &&
    Number.isFinite(r.eligibility.ageDays) &&
    r.eligibility.ageDays >= 7 &&
    Number.isInteger(r.eligibility.distinctUseDays) &&
    r.eligibility.distinctUseDays >= 3 &&
    r.eligibility.laterOpening &&
    r.display.verified &&
    r.display.fresh &&
    r.display.status === "admitted" &&
    r.display.receiptId.trim() &&
    sameInvitationIdentity(p.identity, r.display.identity),
  );
}

export function invitationPortReady(
  p: PopupInvitationPresentation,
  port: InvitationIntentPort | undefined,
): port is InvitationIntentPort {
  return Boolean(
    port &&
    port.verified &&
    port.status === "ready" &&
    typeof port.request === "function" &&
    sameInvitationIdentity(p.identity, port.identity),
  );
}
