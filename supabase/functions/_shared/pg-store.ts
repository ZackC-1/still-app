// Postgres-backed EntitlementStore. Connects as the narrow still_entitlement_writer role via a
// connection string whose password is a deploy secret (KTD5) — it can ONLY execute the two write
// RPCs, never read user data or use service_role power. Imported only by the function entrypoints
// (index.ts), never by the handler tests (which inject a mock store).

import postgres from "postgres";
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
