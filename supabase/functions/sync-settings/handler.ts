import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { enforceRateLimit, type RateLimiter } from "../_shared/rate-limit.ts";
import { jsonResponse } from "../_shared/store.ts";
import { type SettingsStore, syncSettings } from "../_shared/settings-store.ts";
import { readSettingsOperationRequest } from "../../../packages/shared-types/src/settings-operation.ts";

export interface SyncSettingsDeps extends AuthDeps {
  readonly store: SettingsStore;
  readonly limiter: RateLimiter;
}
const MAX_BODY = 16384;
async function boundedJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("request-shape");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) throw new Error("request-size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function handleSyncSettings(
  req: Request,
  deps: SyncSettingsDeps,
): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (subject) => {
    const limited = await enforceRateLimit(
      deps.limiter,
      "settings-sync",
      subject,
      req,
      { maxPerUser: 120, maxPerIp: 600, windowSeconds: 60 },
    );
    if (limited) return limited;
    let body: unknown;
    try {
      body = await boundedJson(req);
    } catch {
      return jsonResponse(400, { error: "request-shape" });
    }
    const read = body !== null && typeof body === "object" &&
      !Array.isArray(body) && Object.keys(body).length === 2 &&
      (body as Record<string, unknown>).protocol === 2 &&
      (body as Record<string, unknown>).action === "read";
    const parsed = read ? null : readSettingsOperationRequest(body);
    if (parsed?.status === "invalid") {
      return jsonResponse(400, { error: parsed.reason });
    }
    try {
      const result = await syncSettings(
        deps.store,
        subject,
        parsed?.status === "parsed" ? parsed.request : null,
      );
      return jsonResponse(result.status === "ready" ? 200 : 409, result);
    } catch {
      return jsonResponse(503, { error: "settings-unavailable" });
    }
  });
}
