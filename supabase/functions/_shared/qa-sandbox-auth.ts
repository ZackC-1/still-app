import type postgres from "postgres";
import { HttpConfirmedAppleAccounts, type ConfirmedAppleAccountPort } from "./apple-fulfillment.ts";
import { isUuid } from "./types.ts";

/** Positive QA admission is separate from Auth; never substitute it for account confirmation. */
export interface QaSandboxMembership { enabled(holder: string): Promise<boolean>; }

export class PgQaSandboxMembership implements QaSandboxMembership {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  async enabled(holder: string): Promise<boolean> {
    try {
      if (!isUuid(holder)) throw new Error("Invalid QA subject");
      const rows = await this.sql<{ enabled: unknown }[]>`select public.qa_sandbox_account_enabled(${holder}::uuid) as enabled`;
      if (rows.length !== 1 || typeof rows[0]?.enabled !== "boolean") throw new Error("Invalid QA admission result");
      return rows[0].enabled;
    } catch {
      throw Object.assign(new Error("QA membership unavailable"), { code: "qa_membership_unavailable" });
    }
  }
}

/** A preflight only; SQL rechecks membership/confirmed Auth atomically before positive commits. */
export class QaSandboxAccountAuthority {
  constructor(readonly accounts: ConfirmedAppleAccountPort, readonly membership: QaSandboxMembership) {}
  async canGrant(token: string, holder: string): Promise<boolean> {
    if (!token || !isUuid(holder)) return false;
    try { return await this.accounts.confirmed(token, holder) && await this.membership.enabled(holder); }
    catch { return false; }
  }
}

/** Reuse the shared project's live Auth verifier. This supplies no new identity or DB privilege. */
export function createQaSandboxAccountAuthority(
  config: { readonly supabaseUrl: string; readonly publicApiKey: string },
  membership: QaSandboxMembership,
): QaSandboxAccountAuthority {
  return new QaSandboxAccountAuthority(new HttpConfirmedAppleAccounts(config.supabaseUrl, config.publicApiKey), membership);
}
