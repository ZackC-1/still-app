import type postgres from "postgres";
import { isUuid } from "../_shared/types.ts";

export interface PurchaseAnalyticsClaim {
  readonly operation: string;
  readonly token: string;
  readonly subject: string;
  readonly event: "purchase_recorded" | "purchase_refunded";
  readonly id: string;
  readonly at: string;
  readonly surface: "chrome" | "firefox";
  readonly appVersion: string;
}
export interface PurchaseAnalyticsStore {
  claim(
    account: string,
    origin: string,
  ): Promise<PurchaseAnalyticsClaim | null>;
  current(
    account: string,
    origin: string,
    claim: PurchaseAnalyticsClaim,
  ): Promise<boolean>;
  finish(claim: PurchaseAnalyticsClaim, delivered: boolean): Promise<boolean>;
}
const keys = [
  "operation",
  "token",
  "subject",
  "event",
  "id",
  "at",
  "surface",
  "appVersion",
];
export function readPurchaseAnalyticsClaim(
  value: unknown,
): PurchaseAnalyticsClaim | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid purchase analytics claim");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(v, k)) ||
    ![v.operation, v.token, v.subject, v.id].every(
      (id) => typeof id === "string" && isUuid(id),
    ) ||
    !["purchase_recorded", "purchase_refunded"].includes(v.event as string) ||
    !["chrome", "firefox"].includes(v.surface as string) ||
    typeof v.appVersion !== "string" ||
    !/^\d+(\.\d+){1,3}$/.test(v.appVersion) ||
    typeof v.at !== "string" ||
    !Number.isFinite(Date.parse(v.at))
  ) {
    throw new Error("Invalid purchase analytics claim");
  }
  return {
    ...v,
    at: new Date(v.at).toISOString(),
  } as unknown as PurchaseAnalyticsClaim;
}
export class PgPurchaseAnalyticsStore implements PurchaseAnalyticsStore {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  private async one(
    query: () => PromiseLike<readonly { value: unknown }[]>,
  ): Promise<unknown> {
    try {
      const rows = await query();
      if (rows.length !== 1 || !Object.hasOwn(rows[0], "value"))
        throw new Error();
      return rows[0].value;
    } catch {
      throw new Error("Purchase analytics storage unavailable");
    }
  }
  async claim(
    account: string,
    origin: string,
  ): Promise<PurchaseAnalyticsClaim | null> {
    return readPurchaseAnalyticsClaim(
      await this.one(
        () =>
          this
            .sql`select private.analytics_claim_purchase(${account}::uuid,${origin}) as value`,
      ),
    );
  }
  async current(
    account: string,
    origin: string,
    claim: PurchaseAnalyticsClaim,
  ): Promise<boolean> {
    return (
      (await this.one(
        () =>
          this
            .sql`select private.analytics_purchase_current(${account}::uuid,${origin},${claim.operation}::uuid,${claim.token}::uuid) as value`,
      )) === true
    );
  }
  async finish(
    claim: PurchaseAnalyticsClaim,
    delivered: boolean,
  ): Promise<boolean> {
    return (
      (await this.one(
        () =>
          this
            .sql`select private.analytics_finish_purchase(${claim.operation}::uuid,${claim.token}::uuid,${delivered}) as value`,
      )) === true
    );
  }
}
