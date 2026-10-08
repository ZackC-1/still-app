import type { FunctionInvokeOptions } from "@supabase/supabase-js";
import {
  backendRoutes,
  backendRouteEnvironmentMatches,
  readBackendRouteProfile,
  type BackendRouteProfile,
} from "@still/core/sync/backend-route-profile";

/** Compiled bundle configuration only. Invalid or incomplete QA configuration stays local. */
export function readAppleBackendProfile(
  profile: unknown,
  environment: unknown,
  modernSettings: boolean,
): BackendRouteProfile | null {
  const parsed = readBackendRouteProfile(profile);
  const packagedEnvironment = environment === undefined ? "production" : environment;
  return parsed && backendRouteEnvironmentMatches(parsed, packagedEnvironment) &&
    (parsed !== "shared-hosted-sandbox" || modernSettings) ? parsed : null;
}

/** Apple evidence bodies and current-account fences remain owned by the existing authority. */
export function createAppleFulfillmentTransport(
  profile: BackendRouteProfile,
  invoke: (name: string, options: FunctionInvokeOptions) =>
    Promise<{ data: unknown; error: unknown }>,
) {
  const routes = backendRoutes(profile);
  const request = async (name: string, body: FunctionInvokeOptions["body"]): Promise<unknown> => {
    const { data, error } = await invoke(name, { body, signal: AbortSignal.timeout(8_000) });
    if (error) throw error;
    return data;
  };
  return {
    verifyLocal: (body: FunctionInvokeOptions["body"]) => request(routes.verifyApple, body),
    fulfillLink: (body: FunctionInvokeOptions["body"]) => request(routes.linkApple, body),
  };
}
