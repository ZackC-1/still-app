import { assertEquals, assertRejects } from "@std/assert";
import { handleAnalyticsIdentify } from "../analytics-identify/handler.ts";
import { handleDeleteUser } from "../delete-user/handler.ts";
import { failureCategory } from "../_shared/auth.ts";
import { HttpPostHog, NO_PERSON_LOG, nothingToDelete, PostHogDeletionError } from "../_shared/posthog.ts";
import { CodedError } from "../_shared/coded-error.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { RevenueCatWebPurchaseLink } from "../_shared/web-billing.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import type { UserStore } from "../_shared/user-store.ts";

// The live delete-user path: what PostHog's current bulk_delete answers mean, and what reaches the
// function logs when something fails. PostHog is a scripted fake; nothing leaves the process.

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const A = "11111111-1111-1111-1111-111111111111";
const EMAIL = "person@example.com";
const KEY = "phx_secret_key_value";

/** PostHog's current 202 for distinct ids that match no person (posthog/api/person.py,
 * _queue_bulk_delete_persons, with resolve_persons_for_deletion returning no persons). */
const NO_PERSON = {
  persons_found: 0,
  persons_deleted: 0,
  persons_queued_for_deletion: 0,
  events_queued_for_deletion: false,
  recordings_queued_for_deletion: false,
  deletion_errors: [],
};
const QUEUED = {
  persons_found: 1,
  persons_deleted: 0,
  persons_queued_for_deletion: 1,
  events_queued_for_deletion: true,
  recordings_queued_for_deletion: false,
  deletion_errors: [],
};

const store: UserStore = {
  deleteUser: () => Promise.resolve(),
  getProfile: () => Promise.resolve(null),
  getEntitlement: () => Promise.resolve(null),
};

function req(jwt: string): Request {
  return new Request("http://x", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: "{}",
  });
}

function scripted(responses: ([number, unknown] | Error)[]) {
  const calls: unknown[] = [];
  const ph = new HttpPostHog(
    { apiHost: "https://us.posthog.com", projectId: "123", personalApiKey: KEY },
    (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      const next = responses.shift()!;
      if (next instanceof Error) return Promise.reject(next);
      const [status, body] = next;
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    },
  );
  return { ph, calls };
}

/** Capture every console channel while `run` executes. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: unknown[][] }> {
  const logs: unknown[][] = [];
  const channels = ["error", "warn", "log", "info", "debug"] as const;
  const originals = channels.map((name) => console[name]);
  for (const name of channels) console[name] = (...args: unknown[]) => void logs.push(args);
  try {
    return { result: await run(), logs };
  } finally {
    channels.forEach((name, i) => (console[name] = originals[i]!));
  }
}

function assertNoIdentifier(logs: unknown[][]) {
  const text = JSON.stringify(logs, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  for (const secret of [A, EMAIL, KEY, "us.posthog.com"]) {
    assertEquals(text.includes(secret), false, `log output contains ${secret}: ${text}`);
  }
}

async function deleteAccount(ph: HttpPostHog, over: Partial<UserStore> = {}) {
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleDeleteUser(req(jwt), {
    jwtSecret: SECRET,
    expected: TEST_EXPECTED_CLAIMS,
    store: { ...store, ...over },
    posthog: ph,
  });
  return { status: res.status, body: await res.json() };
}

Deno.test("an account that never shared usage has no PostHog person: PostHog's 202 with persons_found 0 is a completed deletion", async () => {
  const { ph, calls } = scripted([[202, NO_PERSON]]);
  const { result, logs } = await captureLogs(() => deleteAccount(ph));
  assertEquals(result, { status: 200, body: { deleted: true, analyticsDeleted: true } });
  assertEquals(calls, [{ distinct_ids: [A], delete_events: true }]); // no retry, no second request
  // Nothing to follow up, so no failure; one fixed, identifier-free line makes a run of zero
  // matches (a wrong project id) visible.
  assertEquals(logs, [[NO_PERSON_LOG]]);
});

Deno.test("a first attempt that deleted the person but reported a failed later step, then a retry that finds nobody, is done", async () => {
  const partial = { persons_found: 1, persons_deleted: 1, deletion_errors: [{ person_uuid: "p", step: "log_activity" }] };
  const { ph, calls } = scripted([[202, partial], [202, NO_PERSON]]);
  const { logs } = await captureLogs(() => ph.deletePerson(A));
  assertEquals(calls.length, 2);
  assertEquals(logs, [[NO_PERSON_LOG]]);
});

Deno.test("a first attempt with deletion errors that deleted nothing, then a 5xx retry, is a failure", async () => {
  const failed = { persons_found: 1, persons_deleted: 0, persons_queued_for_deletion: 0, deletion_errors: [{ person_uuid: "p", step: "delete" }] };
  const { ph, calls } = scripted([[202, failed], [503, {}]]);
  const { logs } = await captureLogs(() => assertRejects(() => ph.deletePerson(A), PostHogDeletionError, "http_5xx"));
  assertEquals(calls.length, 2);
  assertEquals(logs, []);
});

Deno.test("the older 400 answer for an unknown person, followed by the current persons_found 0, is also done", async () => {
  const { ph, calls } = scripted([[400, { detail: "no person" }], [202, NO_PERSON]]);
  await ph.deletePerson(A);
  assertEquals(calls, [{ distinct_ids: [A], delete_events: true }, { distinct_ids: [A], delete_events: false }]);
});

Deno.test("a found person is still deleted as before", async () => {
  const { ph, calls } = scripted([[202, QUEUED]]);
  assertEquals(await deleteAccount(ph), { status: 200, body: { deleted: true, analyticsDeleted: true } });
  assertEquals(calls.length, 1);
});

Deno.test("nothingToDelete is strict: only an explicit zero match with no errors and nothing deleted", () => {
  assertEquals(nothingToDelete(NO_PERSON), true);
  assertEquals(nothingToDelete({ persons_found: 0 }), true);
  assertEquals(nothingToDelete({ ...NO_PERSON, deletion_errors: [{ person_uuid: "x", step: "delete" }] }), false);
  assertEquals(nothingToDelete({ ...NO_PERSON, deletion_errors: "oops" }), false);
  assertEquals(nothingToDelete({ ...NO_PERSON, persons_found: 1 }), false);
  assertEquals(nothingToDelete({ ...NO_PERSON, persons_found: "0" }), false);
  assertEquals(nothingToDelete({ ...NO_PERSON, persons_queued_for_deletion: 1 }), false);
  assertEquals(nothingToDelete({ ...NO_PERSON, persons_deleted: 1 }), false);
  const { persons_found: _omitted, ...withoutCount } = NO_PERSON;
  assertEquals(nothingToDelete(withoutCount), false);
  assertEquals(nothingToDelete({}), false); // proves nothing
  assertEquals(nothingToDelete(null), false);
  assertEquals(nothingToDelete([]), false);
});

Deno.test("a PostHog 5xx is still a failure: not retried (as today), reported with a reason code only, account still deleted", async () => {
  // PostHog echoing the request back must not reach our logs either.
  const { ph, calls } = scripted([[503, { detail: `upstream failed for ${A} (${EMAIL})` }]]);
  const { result, logs } = await captureLogs(() => deleteAccount(ph));
  assertEquals(result, { status: 200, body: { deleted: true, analyticsDeleted: false } });
  assertEquals(calls.length, 1);
  assertEquals(logs, [["ANALYTICS DELETION FAILED", { reason: "http_5xx" }]]);
  assertNoIdentifier(logs);
  await assertRejects(() => scripted([[500, {}]]).ph.deletePerson(A), PostHogDeletionError, "http_5xx");
});

Deno.test("other failures keep their own reason codes and never become success", async () => {
  const errors = { persons_found: 1, persons_queued_for_deletion: 0, persons_deleted: 0, deletion_errors: [{ step: "delete" }] };
  await assertRejects(() => scripted([[202, errors], [202, errors]]).ph.deletePerson(A), PostHogDeletionError, "deletion_errors");
  await assertRejects(() => scripted([[202, {}], [202, {}]]).ph.deletePerson(A), PostHogDeletionError, "not_queued");
  await assertRejects(() => scripted([[403, {}]]).ph.deletePerson(A), PostHogDeletionError, "http_4xx");
  await assertRejects(() => scripted([[400, {}], [200, { unmatched_distinct_ids: [] }]]).ph.deletePerson(A), PostHogDeletionError, "events_not_queued");
  await assertRejects(
    () => scripted([new TypeError(`error sending request for url (https://us.posthog.com/api/projects/123/persons/bulk_delete/) ${A}`)]).ph.deletePerson(A),
    PostHogDeletionError,
    "network",
  );
});

Deno.test("a network failure is logged as a reason code, with no URL, account id or key", async () => {
  const { ph } = scripted([new TypeError(`connection reset: https://us.posthog.com ${A} ${KEY}`)]);
  const { result, logs } = await captureLogs(() => deleteAccount(ph));
  assertEquals(result.body, { deleted: true, analyticsDeleted: false });
  assertEquals(logs, [["ANALYTICS DELETION FAILED", { reason: "network" }]]);
  assertNoIdentifier(logs);
});

Deno.test("a failed auth deletion is logged by the shared gate as a category, never the error text", async () => {
  const pgError = Object.assign(
    new Error(`update or delete on table "users" violates foreign key; Key (id)=(${A}) is still referenced; ${EMAIL}`),
    { name: "PostgresError", code: "23503" },
  );
  const { ph, calls } = scripted([]);
  const { result, logs } = await captureLogs(() => deleteAccount(ph, { deleteUser: () => Promise.reject(pgError) }));
  assertEquals(result, { status: 500, body: { error: "internal" } });
  assertEquals(calls, []); // order unchanged: no analytics deletion when the account was not deleted
  assertEquals(logs, [["authenticated handler failed", { reason: "PostgresError:code_23503" }]]);
  assertNoIdentifier(logs);
});

Deno.test("analytics-identify failures are logged as a category, never the account id or email", async () => {
  const authError = Object.assign(new Error(`User ${A} <${EMAIL}> lookup failed`), { name: "AuthApiError", status: 500, code: "unexpected_failure" });
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { result, logs } = await captureLogs(async () => {
    const res = await handleAnalyticsIdentify(req(jwt), {
      jwtSecret: SECRET,
      expected: TEST_EXPECTED_CLAIMS,
      accounts: { account: () => Promise.reject(authError), markAnalyticsSeen: () => Promise.resolve() },
      posthog: { canIdentify: true, canDelete: false, setPersonEmail: () => Promise.resolve(), deletePerson: () => Promise.resolve() },
    });
    return res.status;
  });
  assertEquals(result, 500);
  assertEquals(logs, [["authenticated handler failed", { reason: "AuthApiError:status_500:code_unexpected_failure" }]]);
  assertNoIdentifier(logs);
});

Deno.test("failureCategory keeps only fixed-vocabulary fields", () => {
  assertEquals(failureCategory(new PostHogDeletionError("http_5xx")), "PostHogDeletionError:http_5xx");
  assertEquals(failureCategory(Object.assign(new Error(EMAIL), { code: A })), "Error");
  assertEquals(failureCategory(Object.assign(new Error("x"), { code: EMAIL, name: A, status: 9999 })), "unknown");
  assertEquals(failureCategory(Object.assign(new Error("x"), { code: "a1b2c3d4e5f60718293a4b5c6d7e8f90" })), "Error");
  assertEquals(failureCategory(`thrown ${A}`), "unknown");
  assertEquals(failureCategory(null), "unknown");
});

Deno.test("fixed-message server errors keep a stable code in the gate's log, and never their message", async () => {
  const cases: [Error, string][] = [
    [new CodedError("settings_unavailable", "Settings storage unavailable"), "CodedError:code_settings_unavailable"],
    [new CodedError("rate_limiter_unavailable", "Rate limiter unavailable"), "CodedError:code_rate_limiter_unavailable"],
    [new CodedError("missing_locked_settings", "Missing locked settings state"), "CodedError:code_missing_locked_settings"],
    [new CodedError("web_billing_unconfigured", "RevenueCat Web Billing is not configured"), "CodedError:code_web_billing_unconfigured"],
    [new CodedError("posthog_identify_failed", `PostHog identify failed: 503 ${A}`, 503), "CodedError:status_503:code_posthog_identify_failed"],
    [Object.assign(new Error(`JSON object requested, ${A}`), { code: "PGRST116" }), "Error:code_PGRST116"],
  ];
  for (const [thrown, expected] of cases) {
    const { result, logs } = await captureLogs(() => deleteAccount(scripted([]).ph, { deleteUser: () => Promise.reject(thrown) }));
    assertEquals(result.status, 500);
    assertEquals(logs, [["authenticated handler failed", { reason: expected }]]);
    assertNoIdentifier(logs);
    assertEquals(JSON.stringify(logs).includes(thrown.message), false);
  }
});

Deno.test("the fixed-message throw sites carry their codes", async () => {
  const identify = new HttpPostHog(
    { projectKey: "phc_x", host: "https://us.i.posthog.com" },
    () => Promise.resolve(new Response("{}", { status: 503 })),
  );
  const posthogError = await assertRejects(() => identify.setPersonEmail(A, EMAIL), CodedError);
  assertEquals([posthogError.code, posthogError.status], ["posthog_identify_failed", 503]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("{}", { status: 502 }));
  try {
    const rcError = await assertRejects(() => new HttpRevenueCatClient("sk_x").getSubscriber(A), CodedError);
    assertEquals([rcError.code, rcError.status], ["revenuecat_lookup_failed", 502]);
  } finally {
    globalThis.fetch = realFetch;
  }

  const billing = await assertRejects(() => new RevenueCatWebPurchaseLink("").createCheckout(A), CodedError);
  assertEquals(billing.code, "web_billing_unconfigured");
});
