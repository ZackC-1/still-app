import { assertEquals } from "@std/assert";
import { handleAnalyticsIdentify } from "../analytics-identify/handler.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import type { RateLimiter } from "../_shared/rate-limit.ts";
import { PgRateLimiter } from "../_shared/pg-store.ts";

const SECRET = "synthetic-identify-limiter-secret-not-a-credential";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
function fixture(limiter?: RateLimiter | null) {
  const calls: string[] = [];
  return { calls, deps: {
    jwtSecret: SECRET, expected: TEST_EXPECTED_CLAIMS, limiter,
    accounts: {
      account: (id: string) => { calls.push(`account:${id}`); return Promise.resolve({ email: "synthetic@example.invalid", createdAt: null, analyticsSeen: false }); },
      markAnalyticsSeen: (id: string) => { calls.push(`mark:${id}`); return Promise.resolve(); },
    },
    posthog: {
      canIdentify: true, canDelete: false,
      setPersonEmail: (id: string) => { calls.push(`send:${id}`); return Promise.resolve(); },
      deletePerson: () => Promise.resolve(),
    },
  } };
}
async function request(body: unknown = {}, ip = "198.51.100.1", user = USER) {
  const token = await mintHs256({ sub: user }, SECRET);
  return new Request("https://audit.invalid", { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "cf-connecting-ip": ip,
  }, body: JSON.stringify(body) });
}

Deno.test("all legacy identify shapes obey the account limit before any privileged work", async () => {
  const keys: string[] = [];
  const { deps, calls } = fixture({ consume(key) { keys.push(key); return Promise.resolve(42); } });
  for (const body of [{}, { userId: OTHER, email: "attacker@example.invalid" }, [], null]) {
    const response = await handleAnalyticsIdentify(await request(body), deps);
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("retry-after"), "42");
    assertEquals((await response.json()).retry_after, 42);
  }
  assertEquals(keys, Array(4).fill(`analytics-identify:user:${USER}`));
  assertEquals(calls, []);
});

Deno.test("legacy identify uses the verified identity and one IPv6 network window", async () => {
  const keys: string[] = [];
  const { deps, calls } = fixture({ consume(key) { keys.push(key); return Promise.resolve(key.includes(":ip:") ? 17 : 0); } });
  for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::abcd"]) {
    assertEquals((await handleAnalyticsIdentify(await request({ userId: OTHER }, ip), deps)).status, 429);
  }
  assertEquals(keys, [
    `analytics-identify:user:${USER}`, "analytics-identify:ip:2001:db8:1:2::/64",
    `analytics-identify:user:${USER}`, "analytics-identify:ip:2001:db8:1:2::/64",
  ]);
  assertEquals(calls, []);
});

Deno.test("legacy identify exhausted real request budget blocks repeated sends", async () => {
  const counts = new Map<string, number>();
  const { deps, calls } = fixture({ consume(key, max) {
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    return Promise.resolve(count > max ? 60 : 0);
  } });
  const statuses: number[] = [];
  for (let i = 0; i < 32; i++) statuses.push((await handleAnalyticsIdentify(await request(), deps)).status);
  assertEquals(statuses, [...Array(30).fill(200), 429, 429]);
  assertEquals(calls.filter(c => c.startsWith("send:")).length, 30);
  assertEquals(counts.get("analytics-identify:ip:198.51.100.1"), 30);
});

Deno.test("missing or broken legacy limiter fails closed without account or provider calls", async () => {
  for (const limiter of [undefined, null, { consume: () => Promise.reject(new Error("synthetic outage")) }]) {
    const { deps, calls } = fixture(limiter);
    const response = await handleAnalyticsIdentify(await request(), deps);
    assertEquals(response.status >= 500, true);
    assertEquals(calls, []);
  }
});

Deno.test("unconfigured analytics stays a no-op and unauthenticated requests spend no budget", async () => {
  let limits = 0;
  const { deps, calls } = fixture({ consume() { limits++; return Promise.resolve(0); } });
  const noAnalytics = { ...deps, posthog: { ...deps.posthog, canIdentify: false }, limiter: null };
  assertEquals(await (await handleAnalyticsIdentify(await request(), noAnalytics)).json(), { identified: false });
  assertEquals((await handleAnalyticsIdentify(new Request("https://audit.invalid", { method: "POST", body: "{}" }), deps)).status, 401);
  assertEquals(limits, 0);
  assertEquals(calls, []);
});

Deno.test("production identify entrypoint wires the narrow limiter without per-device setup", async () => {
  const originalGet = Deno.env.get;
  const originalServe = Deno.serve;
  const originalConsume = PgRateLimiter.prototype.consume;
  const originalFetch = globalThis.fetch;
  const keys: string[] = [];
  let providerCalls = 0;
  let dispatch!: (req: Request) => Response | Promise<Response>;
  const config: Record<string, string> = {
    SUPABASE_URL: "https://audit.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-placeholder",
    SUPABASE_JWT_SECRET: SECRET,
    ENTITLEMENT_WRITER_DB_URL: "postgres://still_entitlement_writer:synthetic@127.0.0.1:1/postgres",
    POSTHOG_PROJECT_KEY: "synthetic-project-placeholder",
    POSTHOG_HOST: "https://analytics.invalid",
  };
  try {
    Deno.env.get = (name) => config[name];
    Deno.serve = ((handler: typeof dispatch) => { dispatch = handler; return {} as never; }) as unknown as typeof Deno.serve;
    PgRateLimiter.prototype.consume = (key) => { keys.push(key); return Promise.resolve(29); };
    globalThis.fetch = (() => { providerCalls++; return Promise.reject(new Error("unexpected provider call")); }) as typeof fetch;
    await import("../analytics-identify/index.ts");
    const token = await mintHs256({ sub: USER, iss: "https://audit.invalid/auth/v1" }, SECRET);
    const response = await dispatch(new Request("https://audit.invalid/functions/v1/analytics-identify", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}",
    }));
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("retry-after"), "29");
    assertEquals(keys, [`analytics-identify:user:${USER}`]);
    assertEquals(providerCalls, 0);
  } finally {
    Deno.env.get = originalGet;
    Deno.serve = originalServe;
    PgRateLimiter.prototype.consume = originalConsume;
    globalThis.fetch = originalFetch;
  }
});
