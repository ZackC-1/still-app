export * from "../../functions/_shared/revenuecat.ts";
export class HttpRevenueCatClient {
  constructor(..._args: unknown[]) {}
  getSubscriber(_holder: string) {
    return Promise.resolve({ entitlements: {} });
  }
}
