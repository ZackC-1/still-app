// Canonical listing port only. Actual parser/handler/ledger/issuer remain unchanged.
export * from "../../functions/_shared/revenuecat-access.ts";
export class HttpRevenueCatAccessClient {
  constructor(..._args: unknown[]) {}
  getRights(_holder: string, _environment: string) {
    return Promise.resolve({
      status: "verified" as const,
      rights: [],
      complete: true,
    });
  }
}
