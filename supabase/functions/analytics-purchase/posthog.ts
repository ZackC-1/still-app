import type { PurchaseAnalyticsClaim } from "./store.ts";
import type { PostHogConfig } from "../_shared/posthog.ts";
/** Closed canonical event envelope; no payment, account, receipt or origin identifiers. */
export async function sendPurchaseAnalytics(
  config: PostHogConfig,
  claim: PurchaseAnalyticsClaim,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.projectKey?.trim() || !config.host?.trim() || signal.aborted)
    return false;
  const response = await fetchImpl(
    `${config.host.replace(/\/+$/, "")}/batch/`,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config.projectKey.trim(),
        batch: [
          {
            event: claim.event,
            uuid: claim.id,
            timestamp: claim.at,
            properties: {
              distinct_id: claim.subject,
              $lib: "still-server",
              $geoip_disable: true,
              surface: claim.surface,
              store: claim.surface === "chrome" ? "chrome" : "firefox",
              app_version: claim.appVersion,
              purchase_origin: "web",
              product: "still-pro-v3",
            },
          },
        ],
      }),
    },
  );
  await response.body?.cancel();
  return response.ok;
}
