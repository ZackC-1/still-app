// Postgres-backed EntitlementStore + RateLimiter. Connect as the narrow still_entitlement_writer
// role via a connection string whose password is a deploy secret (KTD5) — the role can ONLY
// execute its granted RPCs (entitlement writes, event claim/complete/release, rate-limit consume),
// never read user data or use service_role power. Both classes share ONE postgres client
// (createWriterSql) so a function needing both holds a single connection pool. Imported only by the
// function entrypoints (index.ts), never by the handler tests (which inject mocks).

import postgres from "postgres";
import type { RateLimiter } from "./rate-limit.ts";
import {
  type ClaimResult,
  type EntitlementStore,
  type EventClaimStatus,
  MissingUserError,
} from "./store.ts";

type Sql = ReturnType<typeof postgres>;

/** Build the shared narrow-writer-role client. `prepare: false` for the Supabase transaction pooler. */
export function createWriterSql(connectionString: string): Sql {
  return postgres(connectionString, { prepare: false });
}

export class PgEntitlementStore implements EntitlementStore {
  constructor(private readonly sql: Sql) {}

  async claimEvent(eventId: string, appUserId: string, payload: unknown): Promise<ClaimResult> {
    // Pass the payload as a JSON string cast to jsonb — avoids depending on the driver's JSONValue type.
    const rows = await this.sql<{ claim_status: EventClaimStatus; claim_token: string | null }[]>`
      select claim_status, claim_token
      from public.claim_revenuecat_event(${eventId}, ${appUserId}, ${JSON.stringify(payload)}::jsonb)
    `;
    const row = rows[0];
    // A missing/unknown result reads as a live concurrent claim → 5xx → the sender retries.
    if (!row) return { status: "in_flight", token: null };
    return { status: row.claim_status, token: row.claim_token };
  }

  async completeEvent(eventId: string, token: string): Promise<void> {
    await this.sql`select public.complete_revenuecat_event(${eventId}, ${token}::uuid)`;
  }

  async releaseEvent(eventId: string, token: string): Promise<void> {
    await this.sql`select public.release_revenuecat_event(${eventId}, ${token}::uuid)`;
  }

  async setEntitlement(
    userId: string,
    stillSync: boolean,
    source: string,
    revenueCatSubscriberId: string | null,
  ): Promise<void> {
    try {
      await this.sql`
        select public.set_entitlement(${userId}::uuid, ${stillSync}, ${source}, ${revenueCatSubscriberId})
      `;
    } catch (error) {
      // A foreign-key violation on entitlements.user_id → auth.users means the subject was
      // account-deleted (e.g. the losing side of a TRANSFER) — surface it as the typed skip
      // class (R19) so the webhook can continue with the surviving UUIDs. Everything else
      // rethrows untouched: no other store failure may lose its retriability.
      if (isMissingUserFkViolation(error)) throw new MissingUserError(userId, { cause: error });
      throw error;
    }
  }
}

/**
 * True ONLY for the driver error representing the missing-auth-user FK violation. The postgres
 * driver surfaces the server's error fields on the thrown PostgresError — `code` is the SQLSTATE
 * (23503 = foreign_key_violation) and `constraint_name` comes from the wire protocol. The match
 * is deliberately exact (SQLSTATE + constraint) so other FK violations, outages, and permission
 * failures keep the fail-and-release retry path.
 */
function isMissingUserFkViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const fields = error as { code?: unknown; constraint_name?: unknown };
  return fields.code === "23503" && fields.constraint_name === "entitlements_user_id_fkey";
}

/** Postgres-backed fixed-window rate limiter (the consume_rate_limit RPC, same narrow role/client). */
export class PgRateLimiter implements RateLimiter {
  constructor(private readonly sql: Sql) {}

  async consume(bucketKey: string, maxRequests: number, windowSeconds: number): Promise<number> {
    const rows = await this.sql<{ wait: number }[]>`
      select public.consume_rate_limit(${bucketKey}, ${maxRequests}, ${windowSeconds}) as wait
    `;
    return rows[0]?.wait ?? 0;
  }
}
