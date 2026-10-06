import { PRODUCT_POLICY_SURFACES } from "@still/shared-types/product-policy";
import type { PolicyStorageArea } from "../product-policy-runtime.js";

// Shared helpers for the product policy runtime tests. Synthetic values only.

export const SUPABASE_URL = "https://project.example/rest/v1/?apikey=never-sent";
export const ENDPOINT = "https://project.example/functions/v1/product-policy";
export const BUILD = "3.0.0";

export function ratingBody(options: { revision?: number; master?: boolean; build?: string; environment?: string } = {}): string {
  const surfaces = PRODUCT_POLICY_SURFACES.map(surface => `"${surface}":true`).join(",");
  return `{"schema":1,"environment":"${options.environment ?? "production"}","revision":${options.revision ?? 5},` +
    `"master":${options.master ?? true},"surfaces":{${surfaces}},` +
    `"builds":[{"surface":"chrome_desktop","build":"${options.build ?? BUILD}"},{"surface":"firefox_desktop","build":"${options.build ?? BUILD}"}]}`;
}

export function salesBody(options: { revision?: number; salesEnabled?: boolean; web?: boolean; build?: string } = {}): string {
  return `{"schema":1,"environment":"production","revision":${options.revision ?? 5},"salesEnabled":${options.salesEnabled ?? true},` +
    `"channels":{"apple":{"enabled":true,"offer":"still-pro-v3"},"web":{"enabled":${options.web ?? true},"offer":"still-pro-v3"}},` +
    `"builds":[{"surface":"chrome_desktop","build":"${options.build ?? BUILD}"}]}`;
}

/** A chrome.storage.local stand-in that stores structured clones, like the real area. */
export function memoryArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  const writes: Record<string, unknown>[] = [];
  const state = { failSet: false, failGet: false };
  const area: PolicyStorageArea = {
    get: async key => {
      if (state.failGet) throw new Error("storage unavailable");
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    set: async items => {
      if (state.failSet) throw new Error("storage unavailable");
      writes.push(structuredClone(items));
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
  return { area, data, writes, state, dump: () => Object.fromEntries(data) };
}

export interface Call { readonly url: string; readonly init: RequestInit }

/** A fetch that answers from a script and records exactly what was asked. */
export function scriptedFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const ok = (body: string | Uint8Array<ArrayBuffer>) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

/** A monotonic test clock. */
export function clock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}
