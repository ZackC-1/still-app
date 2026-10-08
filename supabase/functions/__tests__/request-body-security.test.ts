import { assertEquals } from "@std/assert";
import { handleAnalyticsErasure } from "../analytics-erasure/handler.ts";
import { handleAnalyticsIdentify } from "../analytics-identify/handler.ts";
import { handleReviewSignin } from "../review-signin/handler.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";

const SECRET = "synthetic-body-reader-test-secret-not-a-credential";
const USER = "11111111-1111-4111-8111-111111111111";

async function handlers() {
  const token = await mintHs256({ sub: USER }, SECRET);
  const calls: string[] = [];
  const routes = [
    (req: Request) => handleAnalyticsIdentify(req, {
      jwtSecret: SECRET, expected: TEST_EXPECTED_CLAIMS,
      accounts: {
        account: () => { calls.push("account"); return Promise.resolve({ email: "synthetic@example.invalid", createdAt: null, analyticsSeen: true }); },
        markAnalyticsSeen: () => { calls.push("mark"); return Promise.resolve(); },
      },
      posthog: {
        canIdentify: true, canDelete: false,
        setPersonEmail: () => { calls.push("identify"); return Promise.resolve(); },
        deletePerson: () => Promise.resolve(),
      },
    }),
    (req: Request) => handleAnalyticsErasure(req, {
      store: null, limiter: null, workerToken: "", posthog: {} as never,
    }),
    (req: Request) => handleReviewSignin(req, {
      config: { reviewEmail: "", reviewCode: "" },
      limiter: { consume: () => { calls.push("limit"); return Promise.resolve(0); } },
      admin: {} as never,
    }),
  ];
  return { routes, calls, token };
}

function request(body: BodyInit, token: string, signal?: AbortSignal) {
  return new Request("https://audit.invalid", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body, signal,
  });
}

Deno.test("public JSON routes reject oversized chunks before account or provider work", async () => {
  const { routes, calls, token } = await handlers();
  for (const route of routes) {
    const body = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new TextEncoder().encode(" ".repeat(1025) + '{"action":"request","email":"x"}'));
      c.close();
    } });
    assertEquals((await route(request(body, token))).status, 400);
  }
  assertEquals(calls, []);
});

Deno.test("identify measures UTF-8 bytes and refuses oversized legacy input", async () => {
  const { routes, calls, token } = await handlers();
  const body = JSON.stringify({ ignored: "é".repeat(600) }); // <1024 characters, >1024 bytes.
  assertEquals((await routes[0]!(request(body, token))).status, 400);
  assertEquals(calls, []);
});

Deno.test("errored and malformed UTF-8 bodies never fall through to legacy identify", async () => {
  const { routes, calls, token } = await handlers();
  const errored = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("transport")); } });
  assertEquals((await routes[0]!(request(errored, token))).status, 400);
  assertEquals((await routes[0]!(request(new Uint8Array([0xff, 0xfe]), token))).status, 400);
  assertEquals(calls, []);
});

Deno.test("aborted incomplete bodies are refused by each route", async () => {
  const { routes, calls, token } = await handlers();
  for (const route of routes) {
    const abort = new AbortController();
    let control!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { control = c; c.enqueue(new TextEncoder().encode("{")); } });
    const pending = route(request(body, token, abort.signal));
    abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending.then(r => r.status), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); })]);
      if (result === null) { control.close(); await pending.catch(() => {}); }
      assertEquals(result, 400);
    } finally { clearTimeout(timer); }
  }
  assertEquals(calls, []);
});

Deno.test("public erasure read does not wait for a producer's cancellation promise", async () => {
  const { routes, token } = await handlers();
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(1025)); },
    cancel() { return new Promise<void>(() => {}); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      routes[1]!(request(body, token)).then(r => r.status),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); }),
    ]);
    assertEquals(result, 400);
    assertEquals(body.locked, false);
  } finally { clearTimeout(timer); }
});

Deno.test("unfinished public bodies expire even when the caller never closes the stream", async () => {
  const { routes, calls, token } = await handlers();
  const outcomes = await Promise.all(routes.map(async route => {
    let control!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { control = c; c.enqueue(new TextEncoder().encode("{")); } });
    const pending = route(request(body, token));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending.then(r => r.status), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2500); })]);
      if (result === null) { control.close(); await pending.catch(() => {}); }
      return result;
    } finally { clearTimeout(timer); }
  }));
  assertEquals(outcomes, [400, 400, 400]);
  assertEquals(calls, []);
});
