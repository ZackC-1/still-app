import type postgres from "postgres";
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
