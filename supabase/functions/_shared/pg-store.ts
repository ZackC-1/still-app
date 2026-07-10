// Postgres-backed EntitlementStore + RateLimiter. Connect as the narrow still_entitlement_writer
// role via a connection string whose password is a deploy secret (KTD5) — the role can ONLY
// execute its granted RPCs (entitlement writes + rate-limit consume), never read user data or use
// service_role power. Imported only by the function entrypoints (index.ts), never by the handler
// tests (which inject mocks).

import postgres from "postgres";
import type { RateLimiter } from "./rate-limit.ts";
import type { EntitlementStore } from "./store.ts";

export class PgEntitlementStore implements EntitlementStore {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, { prepare: false });
  }

  async recordEvent(eventId: string, appUserId: string, payload: unknown): Promise<boolean> {
    // Pass the payload as a JSON string cast to jsonb — avoids depending on the driver's JSONValue type.
    const rows = await this.sql<{ inserted: boolean }[]>`
      select public.record_revenuecat_event(${eventId}, ${appUserId}, ${JSON.stringify(payload)}::jsonb) as inserted
    `;
    return rows[0]?.inserted ?? false;
  }

  async setEntitlement(
    userId: string,
    stillSync: boolean,
    source: string,
    revenueCatSubscriberId: string | null,
  ): Promise<void> {
    await this.sql`
      select public.set_entitlement(${userId}::uuid, ${stillSync}, ${source}, ${revenueCatSubscriberId})
    `;
  }
}

/** Postgres-backed fixed-window rate limiter (the consume_rate_limit RPC, same narrow role). */
export class PgRateLimiter implements RateLimiter {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, { prepare: false });
  }

  async consume(bucketKey: string, maxRequests: number, windowSeconds: number): Promise<number> {
    const rows = await this.sql<{ wait: number }[]>`
      select public.consume_rate_limit(${bucketKey}, ${maxRequests}, ${windowSeconds}) as wait
    `;
    return rows[0]?.wait ?? 0;
  }
}
