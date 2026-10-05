// Per-device analytics identities and device erasure (U5-W2 part 1): handlers, worker and the
// PostHog adapter, against an in-memory store and a fake PostHog. No network, no database.
import { assert, assertEquals } from "@std/assert";
import { handleAnalyticsErasure } from "../analytics-erasure/handler.ts";
import { batchJobs, runErasureWorker } from "../analytics-erasure/worker.ts";
import { handleAnalyticsIdentify } from "../analytics-identify/handler.ts";
import {
  type ClaimedErasureJob,
  deviceErasureState,
  type ErasureJobRef,
  type ErasureOutcome,
  type ErasureStage,
  type ErasureStore,
  type RecordedOutcome,
  type SubjectIssue,
} from "../_shared/erasure-store.ts";
import {
  classifyBulkDelete,
  combineOutcomes,
  HttpPostHogErasure,
  type PostHogErasurePort,
  type PostHogSubjectPort,
  subjectEventId,
} from "../_shared/posthog-erasure.ts";
import { accountCreatedEventId, type PostHogPort } from "../_shared/posthog.ts";
import { limiterAddress, type RateLimiter } from "../_shared/rate-limit.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import {
  anonymousIdFromKey,
  fromHex,
  proofFromKey,
  toHex,
} from "../../../packages/core/src/analytics/derive.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const A = "11111111-1111-4111-8111-111111111111";
const WORKER_TOKEN = ["worker", "invocation", "token"].join("-");
// Two synthetic devices: their erasure keys, built at runtime, and the proofs derived from them.
const KEY_1 = toHex(new Uint8Array(32).map((_, i) => i + 1));
const KEY_2 = toHex(new Uint8Array(32).map((_, i) => 200 - i));
const PROOF_1 = await proofFromKey(fromHex(KEY_1));
const PROOF_2 = await proofFromKey(fromHex(KEY_2));

/** Mirrors 0017's semantics closely enough for the handlers: one subject per (account, device);
 * erasure derives every target from the key and retires that device's subjects. The SQL itself is
 * proven by supabase/tests/analytics_erasure_migration_test.ts. */
class FakeStore implements ErasureStore {
  readonly calls: string[] = [];
  subjects: { subject: string; user: string; proof: string; retired: boolean }[] = [];
  jobs: { job: string; proof: string; stage: ErasureStage; targets: string[]; lease: string | null }[] = [];
  retireAfterIssue = false;
  dailyLimitReached = false;
  private seq = 0;
  private id() {
    return `00000000-0000-4000-9000-${String(++this.seq).padStart(12, "0")}`;
  }
  issueSubject(user: string, proof: string): Promise<SubjectIssue> {
    this.calls.push(`issue:${user}`);
    if (this.jobs.some((j) => j.proof === proof)) return Promise.resolve({ state: "stopped" });
    let row = this.subjects.find((s) => s.user === user && s.proof === proof);
    if (row?.retired) return Promise.resolve({ state: "stopped" });
    if (!row && this.dailyLimitReached) return Promise.resolve({ state: "limited" });
    if (!row) this.subjects.push(row = { subject: this.id(), user, proof, retired: false });
    if (this.retireAfterIssue) row.retired = true;
    return Promise.resolve({ state: "active", subject: row.subject });
  }
  subjectActive(subject: string): Promise<boolean> {
    this.calls.push(`active:${subject}`);
    return Promise.resolve(this.subjects.some((s) => s.subject === subject && !s.retired));
  }
  async beginDeviceErasure(key: string, anonIndex: number): Promise<ErasureJobRef> {
    this.calls.push(`begin:${anonIndex}`);
    const bytes = fromHex(key);
    const proof = await proofFromKey(bytes);
    const ids = await Promise.all(Array.from({ length: anonIndex + 1 }, (_, k) => anonymousIdFromKey(bytes, k)));
    for (const s of this.subjects) if (s.proof === proof) s.retired = true;
    let job = this.jobs.find((j) => j.proof === proof);
    if (!job) this.jobs.push(job = { job: this.id(), proof, stage: "stop_recorded", targets: [], lease: null });
    const own = this.subjects.filter((s) => s.proof === proof).map((s) => s.subject);
    job.targets = [...new Set([...job.targets, ...ids, ...own])];
    return { job: job.job, stage: job.stage };
  }
  async erasureStatus(key: string): Promise<ErasureJobRef | null> {
    const proof = await proofFromKey(fromHex(key));
    const job = this.jobs.find((j) => j.proof === proof);
    return job ? { job: job.job, stage: job.stage } : null;
  }
  claimWork(limit: number): Promise<ClaimedErasureJob[]> {
    const due = this.jobs.filter((j) => j.stage !== "complete" && !j.lease).slice(0, limit);
    return Promise.resolve(due.map((j) => {
      j.lease = this.id();
      return { job: j.job, stage: j.stage, lease: j.lease, sweeps: 0, attempts: 0, targets: j.targets };
    }));
  }
  outcomes: string[] = [];
  failures = 0;
  recordOutcome(job: string, lease: string, outcome: ErasureOutcome): Promise<RecordedOutcome> {
    const j = this.jobs.find((x) => x.job === job);
    if (!j || j.lease !== lease) return Promise.resolve({ recorded: false, overdue: false });
    j.lease = null;
    this.outcomes.push(outcome);
    if (outcome === "queued" || outcome === "none_found") {
      j.stage = j.stage === "stop_recorded" ? "provider_delete_accepted" : "provider_delete_confirmed";
      return Promise.resolve({ recorded: true, overdue: false });
    }
    this.failures += 1;
    return Promise.resolve({ recorded: true, overdue: this.failures >= 5 });
  }
}

function limiter(waits: Record<string, number> = {}) {
  const keys: string[] = [];
  const counts: Record<string, number> = {};
  const port: RateLimiter = {
    consume: (key, max) => {
      keys.push(key);
      const surface = key.split(":").slice(0, 2).join(":");
      counts[key] = (counts[key] ?? 0) + 1;
      if (waits[surface] !== undefined) return Promise.resolve(waits[surface]!);
      return Promise.resolve(counts[key]! > max ? 60 : 0);
    },
  };
  return { port, keys };
}

function fakeDeleter(outcome: ErasureOutcome = "queued", canDelete = true) {
  const deleted: string[][] = [];
  const port: PostHogErasurePort = {
    canDelete,
    deleteByDistinctIds: (ids) => (deleted.push([...ids]), Promise.resolve(outcome)),
  };
  return { port, deleted };
}

function erasureRequest(body: unknown, headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" }) {
  return new Request("http://x/analytics-erasure", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function erasureDeps(store: FakeStore | null, over: Partial<Parameters<typeof handleAnalyticsErasure>[1]> = {}) {
  return { store, limiter: limiter().port, posthog: fakeDeleter().port, workerToken: WORKER_TOKEN, ...over };
}

async function captureLogs<T>(run: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: unknown[] = [];
  const original = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  console.error = console.log = console.warn = console.info = (...args: unknown[]) => void lines.push(args);
  try {
    return { value: await run(), logs: JSON.stringify(lines) };
  } finally {
    Object.assign(console, original);
  }
}

// ── PostHog adapter ──────────────────────────────────────────────────────────────────────────

Deno.test("bulk_delete responses use the account-deletion rules; only proven queueing is success", () => {
  const ok = { persons_found: 2, persons_queued_for_deletion: 2, events_queued_for_deletion: true, deletion_errors: [] };
  assertEquals(classifyBulkDelete(202, ok), "queued");
  // As in #305: an absent deletion_errors is an empty list, and persons_deleted counts as queued.
  const { deletion_errors: _ignored, ...withoutErrors } = ok;
  assertEquals(classifyBulkDelete(202, withoutErrors), "queued");
  assertEquals(classifyBulkDelete(202, { persons_deleted: 1 }), "queued");
  assertEquals(classifyBulkDelete(202, { ...ok, deletion_errors: [{ id: "x" }] }), "provider_partial");
  assertEquals(classifyBulkDelete(202, { ...ok, deletion_errors: "x" }), "provider_shape");
  assertEquals(classifyBulkDelete(202, { ...ok, events_queued_for_deletion: false }), "provider_partial");
  assertEquals(classifyBulkDelete(202, { ...ok, persons_queued_for_deletion: 1 }), "provider_partial");
  // A match that queued nothing is never a deletion (the "never report done" rule).
  assertEquals(classifyBulkDelete(202, { ...ok, persons_queued_for_deletion: 0 }), "provider_partial");
  assertEquals(
    classifyBulkDelete(202, { persons_found: 0, persons_queued_for_deletion: 0, deletion_errors: [] }),
    "none_found",
  );
  assertEquals(classifyBulkDelete(202, { persons_found: 0 }), "none_found");
  assertEquals(classifyBulkDelete(202, { persons_found: 0, persons_deleted: 1 }), "provider_shape");
  assertEquals(classifyBulkDelete(202, {}), "provider_shape");
  assertEquals(classifyBulkDelete(202, null), "provider_shape");
  assertEquals(classifyBulkDelete(202, [ok]), "provider_shape");
  assertEquals(classifyBulkDelete(500, ok), "provider_unavailable");
  assertEquals(classifyBulkDelete(429, null), "provider_unavailable");
  assertEquals(classifyBulkDelete(403, null), "provider_rejected");
  assertEquals(combineOutcomes(["queued", "none_found"]), "queued");
  assertEquals(combineOutcomes(["none_found", "none_found"]), "none_found");
  assertEquals(combineOutcomes(["queued", "provider_shape", "provider_unavailable"]), "provider_unavailable");
});

function scriptedPostHog(replies: { status: number; body: unknown }[]) {
  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const config = { apiHost: "https://us.posthog.com/", projectId: "42", personalApiKey: ["phx", "test"].join("_") };
  const ph = new HttpPostHogErasure(config, (url, init) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
    const reply = replies.shift() ?? replies.at(-1)!;
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  });
  return { ph, sent, config };
}

Deno.test("deleteByDistinctIds deletes events, chunks at 1000, and fails closed", async () => {
  const queued = { persons_found: 1, persons_queued_for_deletion: 1, events_queued_for_deletion: true, deletion_errors: [] };
  const { ph, sent, config } = scriptedPostHog([{ status: 202, body: queued }, { status: 202, body: queued }]);
  const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  assertEquals(await ph.deleteByDistinctIds(ids), "queued");
  assertEquals(sent.length, 2);
  assertEquals(sent[0]!.url, "https://us.posthog.com/api/projects/42/persons/bulk_delete/");
  assertEquals(sent[0]!.auth, `Bearer ${config.personalApiKey}`);
  assertEquals((sent[0]!.body.distinct_ids as string[]).length, 1000);
  assertEquals(sent[0]!.body.delete_events, true);
  assertEquals(sent[1]!.body.distinct_ids as string[], [ids[1000]]);

  const unconfigured = new HttpPostHogErasure({}, () => Promise.reject(new Error("must not be called")));
  assertEquals(await unconfigured.deleteByDistinctIds([A]), "provider_unavailable");
  const offline = new HttpPostHogErasure(config, () => Promise.reject(new TypeError("network")));
  assertEquals(await offline.deleteByDistinctIds([A]), "provider_unavailable");
  const garbage = new HttpPostHogErasure(config, () => Promise.resolve(new Response("<html>", { status: 200 })));
  assertEquals(await garbage.deleteByDistinctIds([A]), "provider_shape");
});

Deno.test("an older-PostHog 400 gets #305's check: only all-unmatched is none_found", async () => {
  const ids = [A, "22222222-2222-4222-8222-222222222222"];
  const none = scriptedPostHog([{ status: 400, body: {} }, { status: 200, body: { unmatched_distinct_ids: ids } }]);
  assertEquals(await none.ph.deleteByDistinctIds(ids), "none_found");
  assertEquals(none.sent.map((s) => s.body.delete_events), [true, false]);
  const some = scriptedPostHog([{ status: 400, body: {} }, { status: 200, body: { unmatched_distinct_ids: [A] } }]);
  assertEquals(await some.ph.deleteByDistinctIds(ids), "provider_partial");
  const empty = scriptedPostHog([{ status: 400, body: {} }, { status: 202, body: { persons_found: 0 } }]);
  assertEquals(await empty.ph.deleteByDistinctIds(ids), "none_found");
  const down = scriptedPostHog([{ status: 400, body: {} }, { status: 503, body: null }]);
  assertEquals(await down.ph.deleteByDistinctIds(ids), "provider_unavailable");
});

Deno.test("the account_created event id is keyed by a server secret, or random without one", async () => {
  const secret = ["synthetic", "event", "id", "secret", "for", "tests", "only", "x"].join("-");
  const keyed = await subjectEventId(A, secret);
  assertEquals(keyed, await subjectEventId(A, secret), "repeatable with the secret, so PostHog keeps it once");
  assert(keyed !== await subjectEventId(A, `${secret}-other`));
  assert(keyed !== await accountCreatedEventId(A));
  const random = await subjectEventId(A, undefined);
  assert(random !== await subjectEventId(A, undefined), "without a secret: random");
  assert(random !== await accountCreatedEventId(A));
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(keyed));
  // A short secret is not used as a key.
  assert(await subjectEventId(A, "short") !== await subjectEventId(A, "short"));
});

Deno.test("setSubjectEmail sets the email on the device's subject, never the account id", async () => {
  const sent: { batch: { event: string; uuid?: string; properties: Record<string, unknown> }[] }[] = [];
  const ph = new HttpPostHogErasure(
    { projectKey: ["phc", "test"].join("_"), host: "https://us.i.posthog.com" },
    (_url, init) => (sent.push(JSON.parse(String(init?.body))), Promise.resolve(new Response("{}"))),
  );
  const subject = "33333333-3333-4333-8333-333333333333";
  await ph.setSubjectEmail(subject, "a@b.co", { accountCreated: true, createdAt: "2026-10-01T00:00:00Z", accountId: A });
  const [set, created] = sent[0]!.batch;
  assertEquals(set!.properties.distinct_id, subject);
  assertEquals(set!.properties.$set, { email: "a@b.co" });
  assertEquals(created!.event, "account_created");
  assertEquals(created!.properties.distinct_id, subject);
  // Not the unsalted per-account hash: nobody holding an account UUID can find this event by it.
  assert(created!.uuid !== await accountCreatedEventId(A));
  assert(!JSON.stringify(sent).includes(`"distinct_id":"${A}"`));
  let refused = false;
  await ph.setSubjectEmail(A, "a@b.co", { accountId: A }).catch(() => (refused = true));
  assert(refused, "the account id is never used as a subject");
});

// ── analytics-erasure: device routes ─────────────────────────────────────────────────────────

Deno.test("device erasure needs no account; the server derives every target from the key", async () => {
  const store = new FakeStore();
  const res = await handleAnalyticsErasure(
    erasureRequest({ action: "device", erasureKey: KEY_1, anonIndex: 1 }),
    erasureDeps(store),
  );
  assertEquals(res.status, 202);
  assertEquals(await res.json(), { state: "requested" });
  const bytes = fromHex(KEY_1);
  assertEquals(store.jobs[0]!.targets, [await anonymousIdFromKey(bytes, 0), await anonymousIdFromKey(bytes, 1)]);
});

Deno.test("knowing an anonymous id, an account id or an identify proof gives no erase power", async () => {
  const store = new FakeStore();
  const own = await store.issueSubject(A, PROOF_1);
  const other = await store.issueSubject(A, PROOF_2);
  assert(own.state === "active" && other.state === "active");
  const victimAnon = await anonymousIdFromKey(fromHex(KEY_2), 0);
  // The request has no field for an id, so any id someone knows is refused by shape.
  for (
    const body of [
      { action: "device", erasureKey: KEY_1, anonIndex: 0, anonymousIds: [victimAnon] },
      { action: "device", erasureKey: KEY_1, anonIndex: 0, distinctIds: [other.subject] },
      { action: "device", erasureKey: KEY_1, anonIndex: 0, userId: A },
      { action: "device", originProof: PROOF_2, anonIndex: 0 },
    ]
  ) {
    assertEquals((await handleAnalyticsErasure(erasureRequest(body), erasureDeps(store))).status, 400);
  }
  // A proof seen in identify traffic used in place of the key names a different (empty) device.
  const misuse = await handleAnalyticsErasure(
    erasureRequest({ action: "device", erasureKey: PROOF_2, anonIndex: 255 }),
    erasureDeps(store),
  );
  assertEquals(misuse.status, 202);
  const all = store.jobs.flatMap((j) => j.targets);
  assert(!all.includes(other.subject) && !all.includes(victimAnon), "device 2 untouched");
  assertEquals(store.subjects.find((s) => s.subject === other.subject)!.retired, false);
  // The device's own key erases its own subject and ids.
  await handleAnalyticsErasure(erasureRequest({ action: "device", erasureKey: KEY_1, anonIndex: 0 }), erasureDeps(store));
  assert(store.jobs.some((j) => j.targets.includes(own.subject)));
  assertEquals(await store.issueSubject(A, PROOF_1), { state: "stopped" });
});

Deno.test("device erasure refuses every key beyond the erasure key and index: no ids, no handle", async () => {
  const store = new FakeStore();
  const base = { action: "device", erasureKey: KEY_1, anonIndex: 0 };
  for (
    const body of [
      { ...base, userId: A },
      { ...base, origin: "99999999-9999-4999-8999-999999999999" },
      { ...base, email: "a@b.co" },
      { action: "device", erasureKey: KEY_1 },
      { ...base, erasureKey: KEY_1.toUpperCase() },
      { ...base, erasureKey: KEY_1.slice(1) },
      { ...base, anonIndex: -1 },
      { ...base, anonIndex: 256 },
      { ...base, anonIndex: 1.5 },
      { ...base, anonIndex: "3" },
      { action: "erase-account", erasureKey: KEY_1 },
      { action: "status", erasureKey: KEY_1, anonIndex: 0 },
      [base],
      "not json",
    ]
  ) {
    const res = await handleAnalyticsErasure(erasureRequest(body), erasureDeps(store));
    assertEquals(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  const huge = await handleAnalyticsErasure(erasureRequest(" ".repeat(2_000) + JSON.stringify(base)), erasureDeps(store));
  assertEquals(huge.status, 400);
  assertEquals(store.calls, []);
});

Deno.test("submit and status have separate limits, and no client address means no service", async () => {
  const store = new FakeStore();
  const { port, keys } = limiter();
  const deps = erasureDeps(store, { limiter: port });
  // Polling far past the submit budget never spends it.
  for (let i = 0; i < 40; i++) {
    assertEquals(
      (await handleAnalyticsErasure(erasureRequest({ action: "status", erasureKey: KEY_1 }), deps)).status,
      200,
    );
  }
  const submit = await handleAnalyticsErasure(erasureRequest({ action: "device", erasureKey: KEY_1, anonIndex: 0 }), deps);
  assertEquals(submit.status, 202);
  assertEquals(new Set(keys), new Set(["analytics-erasure-status:ip:198.51.100.7", "analytics-erasure-submit:ip:198.51.100.7"]));
  const limited = await handleAnalyticsErasure(
    erasureRequest({ action: "device", erasureKey: KEY_1, anonIndex: 0 }),
    erasureDeps(store, { limiter: limiter({ "analytics-erasure-submit:ip": 42 }).port }),
  );
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get("retry-after"), "42");
  const before = store.calls.length;
  for (const body of [{ action: "device", erasureKey: KEY_1, anonIndex: 0 }, { action: "status", erasureKey: KEY_1 }]) {
    assertEquals((await handleAnalyticsErasure(erasureRequest(body, {}), deps)).status, 400, "no address");
  }
  assertEquals(store.calls.length, before);
  assertEquals((await handleAnalyticsErasure(erasureRequest({ action: "status", erasureKey: KEY_1 }), erasureDeps(null))).status, 503);
  assertEquals((await handleAnalyticsErasure(new Request("http://x", { method: "GET" }), deps)).status, 405);
});

Deno.test("status: only complete reads as deleted; a confirmed person deletion is still verifying", async () => {
  const store = new FakeStore();
  const status = async (key: string) =>
    await (await handleAnalyticsErasure(erasureRequest({ action: "status", erasureKey: key }), erasureDeps(store))).json();
  assertEquals(await status(KEY_1), { state: "none" });
  await store.beginDeviceErasure(KEY_1, 0);
  assertEquals(await status(KEY_1), { state: "requested" });
  store.jobs[0]!.stage = "provider_delete_accepted";
  assertEquals(await status(KEY_1), { state: "verifying" });
  store.jobs[0]!.stage = "provider_delete_confirmed";
  assertEquals(await status(KEY_1), { state: "verifying" });
  store.jobs[0]!.stage = "complete";
  assertEquals(await status(KEY_1), { state: "deleted" });
  assertEquals(deviceErasureState({ job: A, stage: "provider_delete_confirmed" }), "verifying");
  assertEquals(await status(KEY_2), { state: "none" });
});

Deno.test("storage failures answer 503 and log a fixed category, never the key", async () => {
  const store = new FakeStore();
  store.beginDeviceErasure = () => Promise.reject(new Error(`driver said ${KEY_1}`));
  const { value, logs } = await captureLogs(() =>
    handleAnalyticsErasure(erasureRequest({ action: "device", erasureKey: KEY_1, anonIndex: 0 }), erasureDeps(store))
  );
  assertEquals(value.status, 503);
  assert(logs.length > 0);
  assert(!logs.includes(KEY_1), logs);
});

// ── analytics-erasure: worker ────────────────────────────────────────────────────────────────

Deno.test("the worker route needs its token; a blank configured token refuses everything", async () => {
  const store = new FakeStore();
  await store.beginDeviceErasure(KEY_1, 0);
  const work = (token: string | null, configured = WORKER_TOKEN) =>
    handleAnalyticsErasure(
      erasureRequest({ action: "work" }, token === null ? {} : { Authorization: token }),
      erasureDeps(store, { workerToken: configured }),
    );
  assertEquals((await work(null)).status, 401);
  assertEquals((await work("wrong")).status, 401);
  assertEquals((await work("", "")).status, 401);
  assertEquals(store.outcomes, []);
  const ok = await work(WORKER_TOKEN);
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), { claimed: 1, advanced: 1, failed: 0, lost: 0, overdue: 0, batches: 1 });
  assertEquals(store.jobs[0]!.stage, "provider_delete_accepted");
});

Deno.test("the worker records one fixed outcome per job and reports overdue jobs", async () => {
  const store = new FakeStore();
  await store.beginDeviceErasure(KEY_1, 0);
  await store.beginDeviceErasure(KEY_2, 0);
  const { port, deleted } = fakeDeleter("provider_partial");
  const { value: report, logs } = await captureLogs(() =>
    runErasureWorker({ store, posthog: port, limit: 10, leaseSeconds: 300 })
  );
  assertEquals(report, { claimed: 2, advanced: 0, failed: 2, lost: 0, overdue: 0, batches: 1 });
  assertEquals(deleted.length, 1, "two small jobs share one bulk_delete");
  assertEquals(store.jobs.map((j) => j.stage), ["stop_recorded", "stop_recorded"]);
  assert(!logs.includes("overdue"));
  for (let i = 0; i < 2; i++) await runErasureWorker({ store, posthog: port, limit: 10, leaseSeconds: 300 });
  const { value: late, logs: overdueLogs } = await captureLogs(() =>
    runErasureWorker({ store, posthog: port, limit: 10, leaseSeconds: 300 })
  );
  assertEquals(late.overdue, 2);
  assert(overdueLogs.includes("analytics erasure overdue jobs: 2"), overdueLogs);

  const throwing: PostHogErasurePort = { canDelete: true, deleteByDistinctIds: () => Promise.reject(new Error("x")) };
  await runErasureWorker({ store, posthog: throwing, limit: 1, leaseSeconds: 300 });
  assertEquals(store.outcomes.at(-1), "provider_unavailable");

  const unconfigured = fakeDeleter("queued", false);
  assertEquals(
    await runErasureWorker({ store, posthog: unconfigured.port, limit: 10, leaseSeconds: 300 }),
    { claimed: 0, advanced: 0, failed: 0, lost: 0, overdue: 0, skipped: "provider_unconfigured" },
  );
  assertEquals(unconfigured.deleted, []);

  const stale = new FakeStore();
  await stale.beginDeviceErasure(KEY_1, 0);
  stale.recordOutcome = () => Promise.resolve({ recorded: false, overdue: false });
  assertEquals(
    await runErasureWorker({ store: stale, posthog: fakeDeleter().port, limit: 10, leaseSeconds: 300 }),
    { claimed: 1, advanced: 0, failed: 0, lost: 1, overdue: 0, batches: 1 },
  );
});

/** A store holding pre-staged claimed jobs, recording each outcome. */
function stagedStore(jobs: ClaimedErasureJob[]) {
  const outcomes: Record<string, ErasureOutcome> = {};
  const store: ErasureStore = {
    issueSubject: () => Promise.reject(new Error("unused")),
    subjectActive: () => Promise.reject(new Error("unused")),
    beginDeviceErasure: () => Promise.reject(new Error("unused")),
    erasureStatus: () => Promise.reject(new Error("unused")),
    claimWork: () => Promise.resolve(jobs),
    recordOutcome: (job, _lease, outcome) => {
      outcomes[job] = outcome;
      return Promise.resolve({ recorded: true, overdue: false });
    },
  };
  return { store, outcomes };
}
const claimed = (job: string, stage: ErasureStage, targets: string[]): ClaimedErasureJob => ({
  job,
  stage,
  lease: `${job}-lease`,
  sweeps: 0,
  attempts: 0,
  targets,
});

Deno.test("NEGATIVE CONTROL: a check is never batched, so new found jobs cannot stall a confirmed job", async () => {
  const found = new Set(["new-1", "new-2"]); // persons PostHog still finds: brand-new jobs
  const calls: { ids: string[]; check?: boolean }[] = [];
  const posthog: PostHogErasurePort = {
    canDelete: true,
    deleteByDistinctIds: (ids, options) => {
      calls.push({ ids: [...ids], check: options?.unmatchedCheck });
      return Promise.resolve(ids.some((id) => found.has(id)) ? "queued" : "none_found");
    },
  };
  const { store, outcomes } = stagedStore([
    claimed("a", "stop_recorded", ["new-1"]),
    claimed("b", "stop_recorded", ["new-2"]),
    claimed("c", "provider_delete_confirmed", ["gone-1"]), // past its floor; its person is gone
    claimed("d", "provider_delete_accepted", ["gone-2"]),
  ]);
  const report = await runErasureWorker({ store, posthog, limit: 50, leaseSeconds: 300 });
  assertEquals(outcomes, { a: "queued", b: "queued", c: "none_found", d: "none_found" });
  assertEquals(calls.map((c) => c.ids), [["new-1", "new-2"], ["gone-1"], ["gone-2"]]);
  assertEquals(report.batches, 3);
});

Deno.test("a combined first deletion never uses the 400 fallback: it splits into per-job calls", async () => {
  const calls: { ids: string[]; check?: boolean }[] = [];
  const posthog: PostHogErasurePort = {
    canDelete: true,
    deleteByDistinctIds: (ids, options) => {
      calls.push({ ids: [...ids], check: options?.unmatchedCheck });
      return Promise.resolve(options?.unmatchedCheck ? "none_found" : "bad_request");
    },
  };
  const { store, outcomes } = stagedStore([
    claimed("a", "stop_recorded", ["x-1"]),
    claimed("b", "stop_recorded", ["x-2"]),
  ]);
  await runErasureWorker({ store, posthog, limit: 50, leaseSeconds: 300 });
  assertEquals(calls, [
    { ids: ["x-1", "x-2"], check: false },
    { ids: ["x-1"], check: true },
    { ids: ["x-2"], check: true },
  ]);
  assertEquals(outcomes, { a: "none_found", b: "none_found" });
  // The adapter itself: without the check a 400 is reported, and no second request is made.
  const { ph, sent } = scriptedPostHog([{ status: 400, body: {} }, { status: 200, body: { unmatched_distinct_ids: [A] } }]);
  assertEquals(await ph.deleteByDistinctIds([A], { unmatchedCheck: false }), "bad_request");
  assertEquals(sent.length, 1);
});

Deno.test("jobs are combined into bulk_delete batches of at most 1,000 distinct ids", () => {
  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);
  const job = (name: string, targets: string[]) => ({ name, targets });
  const batches = batchJobs([
    job("a", ids("a", 600)),
    job("b", ids("b", 300)),
    job("c", ids("c", 200)), // does not fit with a+b (1,100)
    job("d", [...ids("a", 600), ...ids("d", 50)]), // shares a's ids: 950 distinct with a
    job("e", ids("e", 1500)), // bigger than a batch: alone
  ]);
  assertEquals(batches.map((b) => b.map((j) => j.name)), [["a", "b", "d"], ["c"], ["e"]]);
  for (const batch of batches.slice(0, 2)) {
    assert(new Set(batch.flatMap((j) => j.targets)).size <= 1000);
  }
});

// ── analytics-identify: per-device subjects ──────────────────────────────────────────────────

function identifyRequest(jwt: string | null, body: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) });
}

function subjectPostHog(canIdentify = true) {
  const calls: string[] = [];
  const port: PostHogSubjectPort = {
    canIdentify,
    setSubjectEmail: (subject, email, options) => (
      calls.push(`subject:${subject}:${email}${options.accountCreated ? ":created" : ""}`), Promise.resolve()
    ),
  };
  return { port, calls };
}

function legacyPostHog() {
  const calls: string[] = [];
  const port: PostHogPort = {
    canIdentify: true,
    canDelete: true,
    setPersonEmail: (userId) => (calls.push(`account:${userId}`), Promise.resolve()),
    deletePerson: () => Promise.resolve(),
  };
  return { port, calls };
}

function identifyDeps(store: FakeStore, over: Record<string, unknown> = {}) {
  const legacy = legacyPostHog();
  const subject = subjectPostHog();
  const marked: string[] = [];
  const deps = {
    jwtSecret: SECRET,
    expected: TEST_EXPECTED_CLAIMS,
    accounts: {
      account: () => Promise.resolve({ email: "a@b.co", createdAt: "2026-09-30T00:00:00Z", analyticsSeen: false }),
      markAnalyticsSeen: (id: string) => (marked.push(id), Promise.resolve()),
    },
    posthog: legacy.port,
    subjectsEnabled: true,
    subjects: { store, limiter: limiter().port, posthog: subject.port },
    now: () => Date.parse("2026-10-05T12:00:00Z"),
    ...over,
  };
  return { deps, legacy: legacy.calls, subject: subject.calls, marked };
}

Deno.test("NEGATIVE CONTROL: the per-device path is off unless its switch is on, whatever is configured", async () => {
  const store = new FakeStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  for (const subjectsEnabled of [undefined, false]) {
    const { deps, subject, legacy } = identifyDeps(store, { subjectsEnabled });
    const res = await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps);
    assertEquals(res.status, 503);
    assertEquals([subject, legacy], [[], []]);
  }
  assertEquals(store.calls, [], "nothing read or written while off");
});

Deno.test("identify with an origin proof issues this device's own subject and sets the email there", async () => {
  const store = new FakeStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { deps, legacy, subject, marked } = identifyDeps(store);
  const res = await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.state, "active");
  assertEquals(body.accountCreated, true);
  assert(body.subject !== A, "the subject is never the account id");
  assertEquals(subject, [`subject:${body.subject}:a@b.co:created`]);
  assertEquals(legacy, [], "the account person is not touched on the per-device path");
  assertEquals(marked, [A]);
  const again = await (await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps)).json();
  assertEquals(again.subject, body.subject);
  const other = await (await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_2 }), deps)).json();
  assert(other.subject !== body.subject);
});

Deno.test("identify answers stopped for an erased device and never reissues its subject", async () => {
  const store = new FakeStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { deps, subject } = identifyDeps(store);
  const first = await (await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps)).json();
  await store.beginDeviceErasure(KEY_1, 0);
  const res = await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps);
  assertEquals(await res.json(), { state: "stopped" });
  assertEquals(subject.length, 1, "no email write for a stopped device");
  assert(store.subjects.filter((s) => s.proof === PROOF_1).every((s) => s.subject === first.subject));
});

Deno.test("a subject retired while the email was attached answers stopped (identify post-check)", async () => {
  const store = new FakeStore();
  store.retireAfterIssue = true;
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { deps } = identifyDeps(store);
  const res = await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps);
  assertEquals(await res.json(), { state: "stopped" });
  assertEquals(store.calls.filter((c) => c.startsWith("active:")).length, 1);
});

Deno.test("the per-device path is strict, rate limited and unavailable without its store", async () => {
  const store = new FakeStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  for (const body of [{ originProof: "x" }, { originProof: PROOF_1, origin: A }, { originProof: PROOF_1, userId: A }]) {
    const { deps } = identifyDeps(store);
    assertEquals((await handleAnalyticsIdentify(identifyRequest(jwt, body), deps)).status, 400);
  }
  const limited = limiter({ "analytics-identify:user": 30 });
  const { deps } = identifyDeps(store, {
    subjects: { store, limiter: limited.port, posthog: subjectPostHog().port },
  });
  const res = await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps);
  assertEquals(res.status, 429);
  assertEquals(limited.keys, [`analytics-identify:user:${A}`]);
  assertEquals(store.calls, []);
  const none = identifyDeps(store, { subjects: null });
  assertEquals((await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), none.deps)).status, 503);
  assertEquals((await handleAnalyticsIdentify(identifyRequest(null, { originProof: PROOF_1 }), none.deps)).status, 401);
});

Deno.test("an account past its daily limit of new devices is told to try later; nothing is written", async () => {
  const store = new FakeStore();
  store.dailyLimitReached = true;
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { deps, subject } = identifyDeps(store);
  const res = await handleAnalyticsIdentify(identifyRequest(jwt, { originProof: PROOF_1 }), deps);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "3600");
  assertEquals([store.subjects.length, subject.length], [0, 0]);
});

Deno.test("IPv6 clients are limited per /64; IPv4 and mapped addresses per address", async () => {
  assertEquals(limiterAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assertEquals(limiterAddress("2001:DB8:1:2::1"), "2001:db8:1:2::/64");
  assertEquals(limiterAddress("[2001:db8:0:0:1::5]"), "2001:db8:0:0::/64");
  assertEquals(limiterAddress("2001:db8::"), "2001:db8:0:0::/64");
  assertEquals(limiterAddress("fe80::1%en0"), "fe80:0:0:0::/64");
  assertEquals(limiterAddress("::ffff:198.51.100.7"), "198.51.100.7");
  assertEquals(limiterAddress("198.51.100.7"), "198.51.100.7");
  assertEquals(limiterAddress("not:an:address::x::y"), "not:an:address::x::y");
  const store = new FakeStore();
  const { port, keys } = limiter();
  for (const ip of ["2001:db8:1:2::a", "2001:db8:1:2:ffff::b"]) {
    await handleAnalyticsErasure(
      erasureRequest({ action: "status", erasureKey: KEY_1 }, { "cf-connecting-ip": ip }),
      erasureDeps(store, { limiter: port }),
    );
  }
  assertEquals(keys, ["analytics-erasure-status:ip:2001:db8:1:2::/64", "analytics-erasure-status:ip:2001:db8:1:2::/64"]);
  const identifyLimiter = limiter();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { deps } = identifyDeps(store, { subjects: { store, limiter: identifyLimiter.port, posthog: subjectPostHog().port } });
  await handleAnalyticsIdentify(
    new Request("http://x", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "cf-connecting-ip": "2001:db8:9:9::42" },
      body: JSON.stringify({ originProof: PROOF_1 }),
    }),
    deps,
  );
  assertEquals(identifyLimiter.keys, [`analytics-identify:user:${A}`, "analytics-identify:ip:2001:db8:9:9::/64"]);
});

Deno.test("released 2.1 bodies keep the account-person path, unchanged", async () => {
  const store = new FakeStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  for (const body of [{}, { userId: "someone-else", email: "x@evil" }]) {
    const { deps, legacy, subject } = identifyDeps(store);
    const res = await handleAnalyticsIdentify(identifyRequest(jwt, body), deps);
    assertEquals(await res.json(), { identified: true, accountCreated: true });
    assertEquals(legacy, [`account:${A}`]);
    assertEquals(subject, []);
  }
  assertEquals(store.calls, []);
});
