// RevenueCat webhook event shapes + the UUID resolution that maps an event to the affected Supabase
// user(s). app_user_id is configured as the Supabase auth.users UUID (KTD5), so the canonical
// subject is whichever of the candidate ids is a valid UUID.

export interface RcWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly app_user_id?: string;
  readonly original_app_user_id?: string;
  readonly aliases?: string[];
  // TRANSFER events move an entitlement between ids; both sides must reconcile.
  readonly transferred_from?: string[];
  readonly transferred_to?: string[];
}

export interface RcWebhookBody {
  readonly event: RcWebhookEvent;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** The Supabase UUID(s) a webhook event affects. TRANSFER touches both sides; others, one subject. */
export function affectedUuids(event: RcWebhookEvent): string[] {
  if (event.type === "TRANSFER") {
    const both = [...(event.transferred_from ?? []), ...(event.transferred_to ?? [])];
    return [...new Set(both.filter(isUuid))];
  }
  const candidates = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])];
  const uuid = candidates.find(isUuid);
  return uuid ? [uuid] : [];
}
