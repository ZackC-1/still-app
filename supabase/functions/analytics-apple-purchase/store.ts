import type postgres from "postgres";
import type { VerifiedAppleTransaction } from "../_shared/apple-access.ts";

export interface AppleAnalyticsScope {
  readonly originProof: string;
  readonly projectKeySha256: string;
  readonly holder: string | null;
  readonly anonIndex: number | null;
}
export interface AppleAnalyticsState {
  readonly transaction: VerifiedAppleTransaction | null;
  readonly saleId: string;
  readonly refundId: string;
  readonly purchasedAt: number | null;
  readonly refundedAt: number | null;
  readonly surface: "app-ios" | "app-macos";
  readonly appVersion: string;
}
export interface AppleAnalyticsStore {
  prepare(
    hash: string,
    scope: AppleAnalyticsScope,
    surface: string,
    version: string,
  ): Promise<boolean>;
  read(
    hash: string,
    scope: AppleAnalyticsScope,
  ): Promise<AppleAnalyticsState | null>;
  commit(
    hash: string,
    scope: AppleAnalyticsScope,
    tx: VerifiedAppleTransaction,
  ): Promise<AppleAnalyticsState | null>;
}
export class PgAppleAnalyticsStore implements AppleAnalyticsStore {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  private async one<T>(
    query: PromiseLike<readonly { value: T }[]>,
  ): Promise<T> {
    try {
      const rows = await query;
      if (rows.length !== 1) throw new Error();
      return rows[0].value;
    } catch {
      throw new Error("Apple analytics storage unavailable");
    }
  }
  prepare(
    hash: string,
    s: AppleAnalyticsScope,
    surface: string,
    version: string,
  ): Promise<boolean> {
    return this.one(
      this
        .sql`select private.apple_analytics_prepare(${hash},${s.originProof},${s.holder}::uuid,
      ${s.anonIndex}::integer,${s.projectKeySha256},${surface},${version}) as value`,
    );
  }
  read(
    hash: string,
    s: AppleAnalyticsScope,
  ): Promise<AppleAnalyticsState | null> {
    return this.one(
      this
        .sql`select private.apple_analytics_read(${hash},${s.originProof},${s.holder}::uuid,
      ${s.anonIndex}::integer,${s.projectKeySha256}) as value`,
    );
  }
  commit(
    hash: string,
    s: AppleAnalyticsScope,
    tx: VerifiedAppleTransaction,
  ): Promise<AppleAnalyticsState | null> {
    return this.one(
      this
        .sql`select private.apple_analytics_commit(${hash},${s.originProof},${s.holder}::uuid,
      ${s.anonIndex}::integer,${s.projectKeySha256},${
        this.sql.json(tx as unknown as postgres.JSONValue)
      }) as value`,
    );
  }
}
