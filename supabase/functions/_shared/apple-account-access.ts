import type { AccessEnvironment } from "@still/shared-types";
import type { AppleAccessVerifier } from "./apple-access.ts";
import type { AppleAccountAccessStore } from "./apple-access-store.ts";
import type { AccountRight } from "./access-issuer.ts";
export interface CurrentAppleAccountAccess { readonly ready: boolean; readonly rights: readonly AccountRight[]; }
export interface AppleAccountAccessRefresher {
  refresh(holder: string, environment: AccessEnvironment): Promise<boolean | CurrentAppleAccountAccess>;
}

/** Refresh only already-explicitly-linked Apple rows. Never associates RevenueCat identity or
 * accepts a browser-supplied Apple ID. Failure is unknown; canonical refund updates the same row. */
export class VerifiedAppleAccountRefresher implements AppleAccountAccessRefresher {
  constructor(private readonly store: AppleAccountAccessStore, private readonly verifier: AppleAccessVerifier) {}
  async refresh(holder: string, environment: AccessEnvironment): Promise<CurrentAppleAccountAccess> {
    // Account reconciliation's 20s observation starts before its bounded RevenueCat lookup.
    // One 8s Apple budget leaves room for final SQL/signing and cannot be restarted per row.
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<null>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(null); }, 8_000);
    });
    const within = <T>(action: () => Promise<T>): Promise<T | null> =>
      expired ? Promise.resolve(null) : Promise.race([action(), expiry]);
    try {
      const transactions = await within(() => this.store.linkedTransactions(holder, environment));
      if (!transactions) return { ready: false, rights: [] };
      const results = await Promise.all(transactions.map(async tx => {
        try {
          const token = await within(() => this.store.begin(tx));
          if (!token) return { ready: false };
          const current = await within(() => this.verifier.refresh(tx));
          if (!current || current.key !== tx.key || current.environment !== environment ||
            current.bundleId !== tx.bundleId || current.productId !== tx.productId ||
            current.originalTransactionId !== tx.originalTransactionId || current.localOnly) return { ready: false };
          const result = await within(() => this.store.commit(current, token));
          if (!result) return { ready: false };
          if (result.status === "revoked") return { ready: true };
          if (result.status !== "verified" || result.issuer_time !== result.right.verified_at ||
            !await within(() => this.store.confirm(current, token, result.right))) return { ready: false };
          return { ready: true, right: { ...result.right, holder } };
        } catch { return { ready: false }; }
      }));
      return { ready: results.every(result => result.ready), rights: results.flatMap(result => result.right ? [result.right] : []) };
    } catch { return { ready: false, rights: [] }; }
    finally { clearTimeout(timer); }
  }
}
