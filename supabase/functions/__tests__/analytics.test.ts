import { assertEquals, assertRejects } from "@std/assert";
import { handleAnalyticsIdentify } from "../analytics-identify/handler.ts";
import { handleDeleteUser } from "../delete-user/handler.ts";
import { HttpPostHog, type PostHogPort } from "../_shared/posthog.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import type { UserStore } from "../_shared/user-store.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const A = "11111111-1111-1111-1111-111111111111";

function req(jwt: string | null, body: unknown = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) });
}

function fakePostHog(over: Partial<PostHogPort> = {}) {
  const calls: string[] = [];
  const port: PostHogPort = {
    canIdentify: true,
    canDelete: true,
    setPersonEmail: (userId, email) => (calls.push(`email:${userId}:${email}`), Promise.resolve()),
    deletePerson: (userId) => (calls.push(`delete:${userId}`), Promise.resolve()),
    ...over,
  };
  return { port, calls };
}

const store: UserStore = {
  deleteUser: () => Promise.resolve(),
  getProfile: () => Promise.resolve(null),
  getEntitlement: () => Promise.resolve(null),
};

Deno.test("analytics-identify sets the verified account's own email, ignoring the body", async () => {
  const { port, calls } = fakePostHog();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleAnalyticsIdentify(req(jwt, { userId: "someone-else", email: "x@evil" }), {
    jwtSecret: SECRET,
    expected: TEST_EXPECTED_CLAIMS,
    accounts: { emailFor: (id) => Promise.resolve(id === A ? "a@b.co" : null) },
    posthog: port,
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { identified: true });
  assertEquals(calls, [`email:${A}:a@b.co`]);
});

Deno.test("analytics-identify refuses an unauthenticated caller", async () => {
  const { port, calls } = fakePostHog();
  const res = await handleAnalyticsIdentify(req(null), {
    jwtSecret: SECRET,
    expected: TEST_EXPECTED_CLAIMS,
    accounts: { emailFor: () => Promise.resolve("a@b.co") },
    posthog: port,
  });
  assertEquals(res.status, 401);
  assertEquals(calls, []);
});

Deno.test("analytics-identify is a quiet no-op when PostHog is not configured", async () => {
  const { port, calls } = fakePostHog({ canIdentify: false });
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleAnalyticsIdentify(req(jwt), {
    jwtSecret: SECRET,
    expected: TEST_EXPECTED_CLAIMS,
    accounts: { emailFor: () => Promise.resolve("a@b.co") },
    posthog: port,
  });
  assertEquals(await res.json(), { identified: false });
  assertEquals(calls, []);
});

Deno.test("delete-user deletes the PostHog person after the account", async () => {
  const { port, calls } = fakePostHog();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleDeleteUser(req(jwt), { jwtSecret: SECRET, expected: TEST_EXPECTED_CLAIMS, store, posthog: port });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, analyticsDeleted: true });
  assertEquals(calls, [`delete:${A}`]);
});

Deno.test("a PostHog outage never fails an account deletion, and is reported", async () => {
  const { port } = fakePostHog({ deletePerson: () => Promise.reject(new Error("503")) });
  const jwt = await mintHs256({ sub: A }, SECRET);
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const res = await handleDeleteUser(req(jwt), { jwtSecret: SECRET, expected: TEST_EXPECTED_CLAIMS, store, posthog: port });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { deleted: true, analyticsDeleted: false });
  } finally {
    console.error = original;
  }
  assertEquals(errors.length, 1);
});

Deno.test("HttpPostHog posts the email as a $set on the account's distinct id", async () => {
  const sent: { url: string; body: unknown }[] = [];
  const ph = new HttpPostHog(
    { projectKey: "phc_x", host: "https://us.i.posthog.com/" },
    (url, init) => (sent.push({ url: String(url), body: JSON.parse(String(init?.body)) }), Promise.resolve(new Response("{}"))),
  );
  await ph.setPersonEmail(A, "a@b.co");
  assertEquals(sent[0]!.url, "https://us.i.posthog.com/batch/");
  const body = sent[0]!.body as { api_key: string; batch: { event: string; properties: Record<string, unknown> }[] };
  assertEquals(body.api_key, "phc_x");
  assertEquals(body.batch[0]!.event, "$set");
  assertEquals(body.batch[0]!.properties.distinct_id, A);
  assertEquals(body.batch[0]!.properties.$set, { email: "a@b.co" });
});

Deno.test("HttpPostHog deletes by distinct id with events, and treats 'no such person' as done", async () => {
  const sent: { url: string; auth: string | null; body: unknown }[] = [];
  let status = 200;
  let text = "{}";
  const ph = new HttpPostHog(
    { apiHost: "https://us.posthog.com", projectId: "123", personalApiKey: "phx_secret" },
    (url, init) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(text, { status }));
    },
  );
  assertEquals(ph.canIdentify, false);
  await ph.deletePerson(A);
  assertEquals(sent[0]!.url, "https://us.posthog.com/api/projects/123/persons/bulk_delete/");
  assertEquals(sent[0]!.auth, "Bearer phx_secret");
  assertEquals(sent[0]!.body, { distinct_ids: [A], delete_events: true });
  status = 400;
  text = '{"detail":"distinct_ids matched no person"}';
  await ph.deletePerson(A);
  status = 500;
  await assertRejects(() => ph.deletePerson(A));
});

Deno.test("HttpPostHog without deletion config deletes nothing", async () => {
  let called = false;
  const ph = new HttpPostHog({ projectKey: "phc_x", host: "https://us.i.posthog.com" }, () => {
    called = true;
    return Promise.resolve(new Response("{}"));
  });
  assertEquals(ph.canDelete, false);
  await ph.deletePerson(A);
  assertEquals(called, false);
});
