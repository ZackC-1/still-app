import { assertEquals, assertRejects } from "@std/assert";
import { handleAnalyticsIdentify } from "../analytics-identify/handler.ts";
import { handleDeleteUser } from "../delete-user/handler.ts";
import { deletionAccepted, HttpPostHog, type PostHogPort } from "../_shared/posthog.ts";
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
    setPersonEmail: (userId, email, options) => (
      calls.push(`email:${userId}:${email}${options?.accountCreated ? ":created" : ""}`), Promise.resolve()
    ),
    deletePerson: (userId) => (calls.push(`delete:${userId}`), Promise.resolve()),
    ...over,
  };
  return { port, calls };
}

function accountsWith(records: Record<string, { email: string | null; createdAt: string | null; analyticsSeen: boolean }>) {
  const marked: string[] = [];
  return {
    marked,
    lookup: {
      account: (id: string) => Promise.resolve(records[id] ?? null),
      markAnalyticsSeen: (id: string) => {
        marked.push(id);
        if (records[id]) records[id] = { ...records[id]!, analyticsSeen: true };
        return Promise.resolve();
      },
    },
  };
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
    accounts: accountsWith({ [A]: { email: "a@b.co", createdAt: "2020-01-01T00:00:00Z", analyticsSeen: true } }).lookup,
    posthog: port,
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { identified: true, accountCreated: false });
  assertEquals(calls, [`email:${A}:a@b.co`]);
});

Deno.test("analytics-identify refuses an unauthenticated caller", async () => {
  const { port, calls } = fakePostHog();
  const res = await handleAnalyticsIdentify(req(null), {
    jwtSecret: SECRET,
    expected: TEST_EXPECTED_CLAIMS,
    accounts: accountsWith({ [A]: { email: "a@b.co", createdAt: null, analyticsSeen: true } }).lookup,
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
    accounts: accountsWith({ [A]: { email: "a@b.co", createdAt: null, analyticsSeen: true } }).lookup,
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

Deno.test("HttpPostHog deletes by distinct id with events", async () => {
  const sent: { url: string; auth: string | null; body: unknown }[] = [];
  const ph = new HttpPostHog(
    { apiHost: "https://us.posthog.com", projectId: "123", personalApiKey: "phx_secret" },
    (url, init) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  );
  assertEquals(ph.canIdentify, false);
  await ph.deletePerson(A);
  assertEquals(sent.length, 1);
  assertEquals(sent[0]!.url, "https://us.posthog.com/api/projects/123/persons/bulk_delete/");
  assertEquals(sent[0]!.auth, "Bearer phx_secret");
  assertEquals(sent[0]!.body, { distinct_ids: [A], delete_events: true });
});

function scripted(responses: [number, unknown][]) {
  const calls: unknown[] = [];
  const ph = new HttpPostHog(
    { apiHost: "https://us.posthog.com", projectId: "123", personalApiKey: "phx_secret" },
    (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      const [status, body] = responses.shift()!;
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    },
  );
  return { ph, calls };
}

Deno.test("a person who never shared usage counts as deleted only when PostHog confirms no match", async () => {
  const { ph, calls } = scripted([[400, { detail: "no person" }], [200, { unmatched_distinct_ids: [A] }]]);
  await ph.deletePerson(A);
  assertEquals(calls, [{ distinct_ids: [A], delete_events: true }, { distinct_ids: [A], delete_events: false }]);
});

Deno.test("any other 400 is a failure, never a silent success", async () => {
  await assertRejects(() => scripted([[400, { detail: "distinct_ids must be a list" }], [400, {}]]).ph.deletePerson(A));
  // Matched on the retry: the person is gone but its events were not queued for deletion.
  await assertRejects(() => scripted([[400, {}], [200, { unmatched_distinct_ids: [] }]]).ph.deletePerson(A));
  await assertRejects(() => scripted([[500, {}]]).ph.deletePerson(A));
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

Deno.test("a new account is counted once, by the server, however many times it signs in", async () => {
  const now = Date.parse("2026-09-23T18:00:00Z");
  const { port, calls } = fakePostHog();
  const accounts = accountsWith({ [A]: { email: "a@b.co", createdAt: "2026-09-23T17:50:00Z", analyticsSeen: false } });
  const jwt = await mintHs256({ sub: A }, SECRET);
  const deps = { jwtSecret: SECRET, expected: TEST_EXPECTED_CLAIMS, accounts: accounts.lookup, posthog: port, now: () => now };
  assertEquals(await (await handleAnalyticsIdentify(req(jwt), deps)).json(), { identified: true, accountCreated: true });
  assertEquals(await (await handleAnalyticsIdentify(req(jwt), deps)).json(), { identified: true, accountCreated: false });
  assertEquals(calls, [`email:${A}:a@b.co:created`, `email:${A}:a@b.co`]);
  assertEquals(accounts.marked, [A]);
});

Deno.test("an account from before analytics, or with a future or missing creation time, is not counted as new", async () => {
  const now = Date.parse("2026-09-23T18:00:00Z");
  for (const createdAt of ["2026-07-01T00:00:00Z", "2026-09-24T00:00:00Z", null]) {
    const { port, calls } = fakePostHog();
    const accounts = accountsWith({ [A]: { email: "a@b.co", createdAt, analyticsSeen: false } });
    const jwt = await mintHs256({ sub: A }, SECRET);
    await handleAnalyticsIdentify(req(jwt), { jwtSecret: SECRET, expected: TEST_EXPECTED_CLAIMS, accounts: accounts.lookup, posthog: port, now: () => now });
    assertEquals(calls, [`email:${A}:a@b.co`]);
    assertEquals(accounts.marked, [A]); // marked either way, so it can never count later
  }
});

Deno.test("deletionAccepted reads PostHog's 202 body", () => {
  assertEquals(deletionAccepted({ persons_found: 1, persons_queued_for_deletion: 1, events_queued_for_deletion: true, deletion_errors: [] }), true);
  assertEquals(deletionAccepted({ persons_found: 1, persons_queued_for_deletion: 0, persons_deleted: 0, deletion_errors: [{ step: "x" }] }), false);
  assertEquals(deletionAccepted({ persons_found: 1, persons_queued_for_deletion: 0, persons_deleted: 0 }), false);
  assertEquals(deletionAccepted({ persons_found: 1, persons_queued_for_deletion: 1, events_queued_for_deletion: false }), false);
  assertEquals(deletionAccepted({}), true);
});

Deno.test("a 202 with deletion_errors is retried once, then reported as a failure", async () => {
  const bad = { persons_found: 1, persons_queued_for_deletion: 0, persons_deleted: 0, deletion_errors: [{ step: "delete" }] };
  await assertRejects(() => scripted([[202, bad], [202, bad]]).ph.deletePerson(A));
  const good = { persons_found: 1, persons_queued_for_deletion: 1, events_queued_for_deletion: true, deletion_errors: [] };
  await scripted([[202, bad], [202, good]]).ph.deletePerson(A);
});
