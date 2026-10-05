// Per-device analytics identities and device erasure (U5-W2 part 1): handlers, worker and the
// PostHog adapter, against an in-memory store and a fake PostHog. No network, no database.
import { assert, assertEquals } from "@std/assert";
import { handleAnalyticsErasure, MAX_ANONYMOUS_IDS } from "../analytics-erasure/handler.ts";
import { runErasureWorker } from "../analytics-erasure/worker.ts";
import { handleAnalyticsIdentify } from "../analytics-identify/handler.ts";
import type {
  ClaimedErasureJob,
  ErasureJobRef,
  ErasureOutcome,
  ErasureStage,
  ErasureStore,
  SubjectIssue,
} from "../_shared/erasure-store.ts";
import { deviceErasureState } from "../_shared/erasure-store.ts";
import {
  classifyBulkDelete,
  combineOutcomes,
  HttpPostHogErasure,
  type PostHogErasurePort,
  type PostHogSubjectPort,
} from "../_shared/posthog-erasure.ts";
import { accountCreatedEventId, type PostHogPort } from "../_shared/posthog.ts";
import type { RateLimiter } from "../_shared/rate-limit.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const A = "11111111-1111-4111-8111-111111111111";
const PROOF_1 = "a".repeat(64);
const PROOF_2 = "b".repeat(64);
const ANON_1 = "00000000-0000-4000-8000-000000000001";
const ANON_2 = "00000000-0000-4000-8000-000000000002";
const WORKER_TOKEN = "worker-invocation-token";

/** Mirrors 0017's semantics closely enough for the handlers: one subject per (account, device),
 * erasure retires a device's subjects and refuses another device's ids. The SQL itself is proven by
 * supabase/tests/analytics_erasure_migration_test.ts. */
class FakeStore implements ErasureStore {
  readonly calls: string[] = [];
  subjects: { subject: string; user: string; proof: string; retired: boolean }[] = [];
  jobs: { job: string; proof: string; stage: ErasureStage; targets: string[]; lease: string | null }[] = [];
  users = new Set<string>([A]);
  retireAfterIssue = false;
  private seq = 0;
  private id() {
    return `00000000-0000-4000-9000-${String(++this.seq).padStart(12, "0")}`;
  }
  issueSubject(user: string, proof: string): Promise<SubjectIssue> {
    this.calls.push(`issue:${user}:${proof.slice(0, 4)}`);
    if (this.jobs.some((j) => j.proof === proof)) return Promise.resolve({ state: "stopped" });
    let row = this.subjects.find((s) => s.user === user && s.proof === proof);
    if (row?.retired) return Promise.resolve({ state: "stopped" });
    if (!row) this.subjects.push(row = { subject: this.id(), user, proof, retired: false });
    if (this.retireAfterIssue) row.retired = true;
    return Promise.resolve({ state: "active", subject: row.subject });
  }
  subjectActive(subject: string): Promise<boolean> {
    this.calls.push(`active:${subject}`);
    return Promise.resolve(this.subjects.some((s) => s.subject === subject && !s.retired));
  }
  beginDeviceErasure(proof: string, ids: readonly string[]): Promise<ErasureJobRef | "refused"> {
    this.calls.push(`begin:${proof.slice(0, 4)}:${ids.length}`);
    if (ids.some((id) => this.users.has(id) || this.subjects.some((s) => s.subject === id && s.proof !== proof))) {
      return Promise.resolve("refused");
    }
    for (const s of this.subjects) if (s.proof === proof) s.retired = true;
    let job = this.jobs.find((j) => j.proof === proof);
    if (!job) this.jobs.push(job = { job: this.id(), proof, stage: "stop_recorded", targets: [], lease: null });
    const own = this.subjects.filter((s) => s.proof === proof).map((s) => s.subject);
    job.targets = [...new Set([...job.targets, ...ids, ...own])];
    return Promise.resolve({ job: job.job, stage: job.stage });
  }
  erasureStatus(proof: string): Promise<ErasureJobRef | null> {
    const job = this.jobs.find((j) => j.proof === proof);
    return Promise.resolve(job ? { job: job.job, stage: job.stage } : null);
  }
  claimWork(limit: number): Promise<ClaimedErasureJob[]> {
    const due = this.jobs.filter((j) => j.stage !== "complete" && !j.lease).slice(0, limit);
    return Promise.resolve(due.map((j) => {
      j.lease = this.id();
      return { job: j.job, stage: j.stage, lease: j.lease, sweeps: 0, targets: j.targets };
    }));
  }
  outcomes: string[] = [];
  recordOutcome(job: string, lease: string, outcome: ErasureOutcome): Promise<boolean> {
    const j = this.jobs.find((x) => x.job === job);
    if (!j || j.lease !== lease) return Promise.resolve(false);
    j.lease = null;
    this.outcomes.push(outcome);
    if (outcome === "queued" || outcome === "none_found") {
      j.stage = j.stage === "stop_recorded" ? "provider_delete_accepted" : "provider_delete_confirmed";
    }
    return Promise.resolve(true);
  }
}

function limiter(waits: Record<string, number> = {}) {
  const keys: string[] = [];
  const port: RateLimiter = {
    consume: (key) => (keys.push(key), Promise.resolve(waits[key.split(":").slice(0, 2).join(":")] ?? 0)),
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

function erasureRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://x/analytics-erasure", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function erasureDeps(store: FakeStore | null, over: Partial<Parameters<typeof handleAnalyticsErasure>[1]> = {}) {
  return { store, limiter: limiter().port, posthog: fakeDeleter().port, workerToken: WORKER_TOKEN, ...over };
}

async function captureLogs<T>(run: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: unknown[] = [];
  const original = { error: console.error, log: console.log, warn: console.warn };
  console.error = console.log = console.warn = (...args: unknown[]) => void lines.push(args);
  try {
    return { value: await run(), logs: JSON.stringify(lines) };
  } finally {
    Object.assign(console, original);
  }
}

// ── PostHog adapter ──────────────────────────────────────────────────────────────────────────

Deno.test("bulk_delete responses map to fixed outcomes; only proven queueing is success", () => {
  const ok = { persons_found: 2, persons_queued_for_deletion: 2, events_queued_for_deletion: true, deletion_errors: [] };
  assertEquals(classifyBulkDelete(202, ok), "queued");
  assertEquals(classifyBulkDelete(202, { ...ok, deletion_errors: [{ id: "x" }] }), "provider_partial");
  assertEquals(classifyBulkDelete(202, { ...ok, events_queued_for_deletion: false }), "provider_shape");
  assertEquals(classifyBulkDelete(202, { ...ok, persons_queued_for_deletion: 1 }), "provider_partial");
  // A match that queued nothing is never a deletion (the 2.1 "never report done" rule).
  assertEquals(classifyBulkDelete(202, { ...ok, persons_queued_for_deletion: 0 }), "provider_partial");
  assertEquals(
    classifyBulkDelete(202, { persons_found: 0, persons_queued_for_deletion: 0, deletion_errors: [] }),
    "none_found",
  );
  assertEquals(classifyBulkDelete(202, { persons_found: 0, deletion_errors: [] }), "none_found");
  assertEquals(classifyBulkDelete(202, { persons_deleted: 1 }), "provider_shape");
  assertEquals(classifyBulkDelete(202, null), "provider_shape");
  assertEquals(classifyBulkDelete(202, [ok]), "provider_shape");
  assertEquals(classifyBulkDelete(500, ok), "provider_unavailable");
  assertEquals(classifyBulkDelete(429, null), "provider_unavailable");
  assertEquals(classifyBulkDelete(400, ok), "provider_rejected");
  assertEquals(classifyBulkDelete(403, null), "provider_rejected");
  assertEquals(combineOutcomes(["queued", "none_found"]), "queued");
  assertEquals(combineOutcomes(["none_found", "none_found"]), "none_found");
  assertEquals(combineOutcomes(["queued", "provider_shape", "provider_unavailable"]), "provider_unavailable");
});

Deno.test("deleteByDistinctIds deletes events, chunks at 1000, and fails closed", async () => {
  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const config = { apiHost: "https://us.posthog.com/", projectId: "42", personalApiKey: "phx_key" };
  const ph = new HttpPostHogErasure(config, (url, init) => {
    sent.push({
      url: String(url),
      auth: new Headers(init?.headers).get("Authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          persons_found: 1,
          persons_queued_for_deletion: 1,
          events_queued_for_deletion: true,
          deletion_errors: [],
        }),
        { status: 202 },
      ),
    );
  });
  const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  assertEquals(await ph.deleteByDistinctIds(ids), "queued");
  assertEquals(sent.length, 2);
  assertEquals(sent[0]!.url, "https://us.posthog.com/api/projects/42/persons/bulk_delete/");
  assertEquals(sent[0]!.auth, "Bearer phx_key");
  assertEquals((sent[0]!.body.distinct_ids as string[]).length, 1000);
  assertEquals(sent[0]!.body.delete_events, true);
  assertEquals((sent[1]!.body.distinct_ids as string[]), [ids[1000]]);

  const unconfigured = new HttpPostHogErasure({}, () => Promise.reject(new Error("must not be called")));
  assertEquals(await unconfigured.deleteByDistinctIds([ANON_1]), "provider_unavailable");
  const offline = new HttpPostHogErasure(config, () => Promise.reject(new TypeError("network")));
  assertEquals(await offline.deleteByDistinctIds([ANON_1]), "provider_unavailable");
  const garbage = new HttpPostHogErasure(config, () => Promise.resolve(new Response("<html>", { status: 200 })));
  assertEquals(await garbage.deleteByDistinctIds([ANON_1]), "provider_shape");
});

Deno.test("setSubjectEmail sets the email on the device's subject, never the account id", async () => {
  const sent: { batch: { event: string; uuid?: string; properties: Record<string, unknown> }[] }[] = [];
  const ph = new HttpPostHogErasure(
    { projectKey: "phc_x", host: "https://us.i.posthog.com" },
    (_url, init) => (sent.push(JSON.parse(String(init?.body))), Promise.resolve(new Response("{}"))),
  );
  const subject = "33333333-3333-4333-8333-333333333333";
  await ph.setSubjectEmail(subject, "a@b.co", { accountCreated: true, createdAt: "2026-10-01T00:00:00Z", accountId: A });
  const [set, created] = sent[0]!.batch;
  assertEquals(set!.properties.distinct_id, subject);
  assertEquals(set!.properties.$set, { email: "a@b.co" });
  assertEquals(created!.event, "account_created");
  assertEquals(created!.properties.distinct_id, subject);
  assertEquals(created!.uuid, await accountCreatedEventId(A));
  assert(!JSON.stringify(sent).includes(`"distinct_id":"${A}"`));
  let refused = false;
  await ph.setSubjectEmail(A, "a@b.co", { accountId: A }).catch(() => (refused = true));
  assert(refused, "the account id is never used as a subject");
});

// ── analytics-erasure: device routes ─────────────────────────────────────────────────────────

Deno.test("device erasure needs no account, records the job and answers requested", async () => {
  const store = new FakeStore();
  const res = await handleAnalyticsErasure(
    erasureRequest({ action: "device", originProof: PROOF_1, anonymousIds: [ANON_1, ANON_2] }),
    erasureDeps(store),
  );
  assertEquals(res.status, 202);
  assertEquals(await res.json(), { state: "requested" });
  assertEquals(store.calls, ["begin:aaaa:2"]);
  assertEquals(store.jobs[0]!.targets, [ANON_1, ANON_2]);
});

Deno.test("device erasure deletes only this device: another device's subject is refused", async () => {
  const store = new FakeStore();
  const own = await store.issueSubject(A, PROOF_1);
  const other = await store.issueSubject(A, PROOF_2);
  assert(own.state === "active" && other.state === "active");
  const refused = await handleAnalyticsErasure(
    erasureRequest({ action: "device", originProof: PROOF_1, anonymousIds: [ANON_1, other.subject] }),
    erasureDeps(store),
  );
  assertEquals(refused.status, 400);
  const accountId = await handleAnalyticsErasure(
    erasureRequest({ action: "device", originProof: PROOF_1, anonymousIds: [A] }),
    erasureDeps(store),
  );
  assertEquals(accountId.status, 400);
  const res = await handleAnalyticsErasure(
    erasureRequest({ action: "device", originProof: PROOF_1, anonymousIds: [ANON_1] }),
    erasureDeps(store),
  );
  assertEquals(res.status, 202);
  assertEquals(store.jobs.length, 1);
  assertEquals(store.jobs[0]!.targets, [ANON_1, own.subject]);
  assertEquals(store.subjects.find((s) => s.subject === other.subject)!.retired, false);
  // And the erased device never receives an identity again, under any account.
  assertEquals(await store.issueSubject(A, PROOF_1), { state: "stopped" });
});

Deno.test("device erasure refuses every key beyond the proof and ids: no account, no consent handle", async () => {
  const store = new FakeStore();
  const base = { action: "device", originProof: PROOF_1, anonymousIds: [ANON_1] };
  for (
    const body of [
      { ...base, userId: A },
      { ...base, origin: "99999999-9999-4999-8999-999999999999" },
      { ...base, email: "a@b.co" },
      { action: "device", originProof: PROOF_1 },
      { ...base, originProof: PROOF_1.toUpperCase() },
      { ...base, originProof: "a".repeat(63) },
      { ...base, anonymousIds: [] },
      { ...base, anonymousIds: [ANON_1, ANON_1] },
      { ...base, anonymousIds: ["AAAAAAAA-0000-4000-8000-000000000001"] },
      { ...base, anonymousIds: ["not-a-uuid"] },
      { ...base, anonymousIds: Array.from({ length: MAX_ANONYMOUS_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) },
      { action: "erase-account", originProof: PROOF_1 },
      [base],
      "not json",
    ]
  ) {
    const res = await handleAnalyticsErasure(erasureRequest(body), erasureDeps(store));
    assertEquals(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  const huge = await handleAnalyticsErasure(erasureRequest(" ".repeat(20_000) + JSON.stringify(base)), erasureDeps(store));
  assertEquals(huge.status, 400);
  assertEquals(store.calls, []);
});

Deno.test("device routes are rate limited per address and fail closed without storage", async () => {
  const store = new FakeStore();
  const { port, keys } = limiter({ "analytics-erasure:ip": 42 });
  const res = await handleAnalyticsErasure(
    erasureRequest({ action: "device", originProof: PROOF_1, anonymousIds: [ANON_1] }),
    erasureDeps(store, { limiter: port }),
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "42");
  assertEquals(keys, ["analytics-erasure:ip:198.51.100.7"]);
  assertEquals(store.calls, []);
  const none = await handleAnalyticsErasure(
    erasureRequest({ action: "status", originProof: PROOF_1 }),
    erasureDeps(null),
  );
  assertEquals(none.status, 503);
  const get = await handleAnalyticsErasure(new Request("http://x", { method: "GET" }), erasureDeps(store));
  assertEquals(get.status, 405);
});

Deno.test("status maps stages to the device's states; pending is never deleted", async () => {
  const store = new FakeStore();
  const status = async (proof: string) =>
    await (await handleAnalyticsErasure(erasureRequest({ action: "status", originProof: proof }), erasureDeps(store)))
      .json();
  assertEquals(await status(PROOF_1), { state: "none" });
  await store.beginDeviceErasure(PROOF_1, [ANON_1]);
  assertEquals(await status(PROOF_1), { state: "requested" });
  store.jobs[0]!.stage = "provider_delete_accepted";
  assertEquals(await status(PROOF_1), { state: "verifying" });
  store.jobs[0]!.stage = "provider_delete_confirmed";
  assertEquals(await status(PROOF_1), { state: "deleted" });
  assertEquals(deviceErasureState({ job: ANON_1, stage: "complete" }), "deleted");
  assertEquals(await status(PROOF_2), { state: "none" });
});

Deno.test("storage failures answer 503 and log a fixed category, never the proof or ids", async () => {
  const store = new FakeStore();
  store.beginDeviceErasure = () => Promise.reject(new Error(`driver said ${PROOF_1} ${ANON_1}`));
  const { value, logs } = await captureLogs(() =>
    handleAnalyticsErasure(
      erasureRequest({ action: "device", originProof: PROOF_1, anonymousIds: [ANON_1] }),
      erasureDeps(store),
    )
  );
  assertEquals(value.status, 503);
  assert(logs.length > 0);
  assert(!logs.includes(PROOF_1) && !logs.includes(ANON_1), logs);
});

// ── analytics-erasure: worker ────────────────────────────────────────────────────────────────

Deno.test("the worker route needs its token; a blank configured token refuses everything", async () => {
  const store = new FakeStore();
  await store.beginDeviceErasure(PROOF_1, [ANON_1]);
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
  assertEquals(await ok.json(), { claimed: 1, advanced: 1, failed: 0, lost: 0 });
  assertEquals(store.jobs[0]!.stage, "provider_delete_accepted");
});

Deno.test("the worker deletes each job's targets and records one fixed outcome per job", async () => {
  const store = new FakeStore();
  await store.beginDeviceErasure(PROOF_1, [ANON_1, ANON_2]);
  await store.beginDeviceErasure(PROOF_2, [ANON_1]);
  const { port, deleted } = fakeDeleter("provider_partial");
  const report = await runErasureWorker({ store, posthog: port, limit: 10, leaseSeconds: 300 });
  assertEquals(report, { claimed: 2, advanced: 0, failed: 2, lost: 0 });
  assertEquals(deleted, [[ANON_1, ANON_2], [ANON_1]]);
  assertEquals(store.outcomes, ["provider_partial", "provider_partial"]);
  assertEquals(store.jobs.map((j) => j.stage), ["stop_recorded", "stop_recorded"]);

  const throwing: PostHogErasurePort = { canDelete: true, deleteByDistinctIds: () => Promise.reject(new Error("x")) };
  await runErasureWorker({ store, posthog: throwing, limit: 1, leaseSeconds: 300 });
  assertEquals(store.outcomes.at(-1), "provider_unavailable");

  const unconfigured = fakeDeleter("queued", false);
  assertEquals(
    await runErasureWorker({ store, posthog: unconfigured.port, limit: 10, leaseSeconds: 300 }),
    { claimed: 0, advanced: 0, failed: 0, lost: 0, skipped: "provider_unconfigured" },
  );
  assertEquals(unconfigured.deleted, []);

  // A lease taken over by another run is reported as lost, not as progress.
  const stale = new FakeStore();
  await stale.beginDeviceErasure(PROOF_1, [ANON_1]);
  stale.recordOutcome = () => Promise.resolve(false);
  assertEquals(
    await runErasureWorker({ store: stale, posthog: fakeDeleter().port, limit: 10, leaseSeconds: 300 }),
    { claimed: 1, advanced: 0, failed: 0, lost: 1 },
  );
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
    subjects: { store, limiter: limiter().port, posthog: subject.port },
    now: () => Date.parse("2026-10-05T12:00:00Z"),
    ...over,
  };
  return { deps, legacy: legacy.calls, subject: subject.calls, marked };
}

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
  // Same account, same device: the same subject. Another device: another subject.
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
  await store.beginDeviceErasure(PROOF_1, [ANON_1]);
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
  for (const body of [{ originProof: "x" }, { originProof: PROOF_1, origin: ANON_1 }, { originProof: PROOF_1, userId: A }]) {
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
