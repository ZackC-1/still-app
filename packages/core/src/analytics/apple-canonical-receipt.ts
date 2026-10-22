/** Server-authored facts only. These are never accepted by ordinary track()/message producers. */
export interface AppleCanonicalReceipt {
  readonly uuid: string;
  readonly event: "purchase_recorded" | "purchase_refunded";
  readonly timestamp: string;
  readonly properties: {
    readonly product: "still-pro-v3";
    readonly purchase_origin: "app_store" | "mac_app_store";
  };
}
export function readAppleCanonicalReceipt(
  value: unknown,
): AppleCanonicalReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "event,properties,timestamp,uuid" ||
    !["purchase_recorded", "purchase_refunded"].includes(v.event as string) ||
    typeof v.uuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v.uuid,
    ) ||
    typeof v.timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.timestamp) ||
    !Number.isFinite(Date.parse(v.timestamp)) ||
    !v.properties ||
    typeof v.properties !== "object" ||
    Array.isArray(v.properties)
  )
    return null;
  const p = v.properties as Record<string, unknown>;
  if (
    Object.keys(p).sort().join(",") !== "product,purchase_origin" ||
    p.product !== "still-pro-v3" ||
    !["app_store", "mac_app_store"].includes(p.purchase_origin as string)
  )
    return null;
  return value as AppleCanonicalReceipt;
}
