// Tests for the Chrome release scripts. No network: every request goes to an in-memory fake of the
// Chrome Web Store and GitHub APIs, and the global fetch is replaced with one that throws, so a
// forgotten injection fails loudly instead of reaching Google.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { API_ORIGIN, compareChromeVersions, createStoreClient, decidePreflight, PUBLISH_BODY, READ_SCOPE, redact, StoreRefusal, summarizeStatus, WRITE_SCOPE } from "./chrome-store.mjs";
import * as storeModule from "./chrome-store.mjs";
import { buildReceipt, checkEnvironmentProtection, checkInputs, checkRunContext, checkSubjectCustomization, EXPECTED, main, runUpload, sha256, verifyArtifact, zipName } from "./chrome-release.mjs";
import { assertPaidTierOff, collectPublicEnv, runPackage, verifyBuilt } from "./chrome-package.mjs";

const HERE = new URL(".", import.meta.url);
const TOKEN = "ya29.a0TESTTOKEN-not-real_0123456789";
const PUBLISHER = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const ITEM = "midpefhbieafmeboompbboemeahjjnkf";
const NAME = `publishers/${PUBLISHER}/items/${ITEM}`;
const STATUS_PATH = `GET /v2/${NAME}:fetchStatus`;
const UPLOAD_PATH = `POST /upload/v2/${NAME}:upload`;
const PUBLISH_PATH = `POST /v2/${NAME}:publish`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network access in a test");
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

/**
 * An in-memory store. `routes` maps "METHOD /path" to a response, a list of responses (served in
 * order, last one repeating), or a function. Writes are refused unless allowWrites is set, and any
 * address other than the Chrome Web Store API is refused.
 */
function fakeStore(routes, { allowWrites = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    if (!url.startsWith(`${API_ORIGIN}/`)) throw new Error(`test transport: off-site request to ${url}`);
    if (init.method !== "GET" && !allowWrites) throw new Error(`test transport: write denied (${init.method})`);
    const key = `${init.method} ${url.slice(API_ORIGIN.length)}`;
    let route = routes[key];
    if (route === undefined) throw new Error(`test transport: no route for ${key}`);
    if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0];
    const r = typeof route === "function" ? route(init) : route;
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { fetchImpl, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

const status = (fields) => ({ body: { name: NAME, itemId: ITEM, ...fields } });
const published = (version, state = "PUBLISHED") => ({ state, distributionChannels: [{ crxVersion: version, deployPercentage: 100 }] });
const noSleep = async () => {};
const client = (fetchImpl, extra = {}) => createStoreClient({ fetchImpl, token: TOKEN, publisherId: PUBLISHER, itemId: ITEM, sleep: noSleep, pollIntervalMs: 10, pollTimeoutMs: 50, ...extra });

const RUN_ENV = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "ZackC-1/still-app",
  GITHUB_REPOSITORY_ID: "1278502679",
  GITHUB_REPOSITORY_OWNER_ID: "257643931",
  GITHUB_WORKFLOW_REF: "ZackC-1/still-app/.github/workflows/release-chrome.yml@refs/heads/main",
  GITHUB_RUN_ID: "4242",
};

function workdir() {
  return mkdtempSync(join(tmpdir(), "still-chrome-test-"));
}

/** A work directory holding a "package" whose fingerprint the caller knows. */
function stagedPackage(version = "2.2.0", bytes = Buffer.from("PK fake chrome package " + version)) {
  const dir = workdir();
  const pkg = join(dir, "package");
  mkdirSync(pkg);
  writeFileSync(join(pkg, zipName(version)), bytes);
  const digest = sha256(bytes);
  writeFileSync(join(pkg, "SHA256SUMS.json"), JSON.stringify({ version, files: { [zipName(version)]: { sha256: digest, bytes: bytes.length } } }));
  return { dir, digest, bytes };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, deps: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, text: () => out.join("") + err.join("") };
}

// ---- versions ----

test("Chrome version comparison follows Chrome's rules", () => {
  const cases = [
    ["2.1.1", "2.2.0", -1],
    ["2.10.0", "2.9.9", 1],
    ["2.2.0", "2.2.0", 0],
    ["2.2", "2.2.0", 0],
    ["2.2.0.1", "2.2.0", 1],
    ["1.0.3", "2.0.0", -1],
  ];
  for (const [a, b, sign] of cases) assert.equal(Math.sign(compareChromeVersions(a, b)), sign, `${a} vs ${b}`);
  for (const bad of ["", "2..1", "02.1.0", "1.2.3.4.5", "65536.0.0", "v2.0.0", "2.0.0-beta"]) assert.throws(() => compareChromeVersions(bad, "1.0.0"), StoreRefusal, bad);
});

// ---- status and preflight decisions ----

test("an unknown store state or upload state is refused, never guessed", () => {
  assert.throws(() => summarizeStatus({ publishedItemRevisionStatus: { state: "LIVE_SOMEHOW" } }), /Unknown published state/);
  assert.throws(() => summarizeStatus({ lastAsyncUploadState: "MAYBE" }), /Unknown upload state/);
  assert.equal(summarizeStatus({ lastAsyncUploadState: "UPLOAD_IN_PROGRESS" }).lastUploadState, "IN_PROGRESS");
  assert.throws(() => summarizeStatus(null), /no status/);
});

test("a live, in-review or staged revision without a version is refused instead of treated as absent", () => {
  for (const field of ["publishedItemRevisionStatus", "submittedItemRevisionStatus"])
    for (const state of ["PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED"])
      for (const channels of [undefined, [], [{ deployPercentage: 100 }]])
        assert.throws(() => summarizeStatus({ [field]: { state, distributionChannels: channels } }), (e) => e.code === "store-response-unexpected", `${field} ${state} ${JSON.stringify(channels)}`);
  // Rejected or cancelled submissions may carry no version; nothing is compared against them.
  for (const state of ["REJECTED", "CANCELLED"]) assert.equal(summarizeStatus({ submittedItemRevisionStatus: { state } }).submitted.version, null);
});

test("a versionless published revision stops the whole store check before any upload", async () => {
  const { dir, digest } = stagedPackage();
  const store = fakeStore({ [STATUS_PATH]: status({ publishedItemRevisionStatus: { state: "PUBLISHED" } }) });
  const io = capture();
  assert.equal(await main(["preflight", "--dir", dir], { env: storeEnv("upload", dir, digest), fetchImpl: store.fetchImpl, ...io.deps }), 1);
  assert.match(io.err.join(""), /store-response-unexpected/);
  assert.ok(!existsSync(join(dir, "github-output")), "no decision was handed to later steps");
});

test("preflight allows only a strictly higher version and stops on every risky store state", () => {
  const decide = (fields, version = "2.2.0") => decidePreflight(summarizeStatus(fields), version);
  assert.equal(decide({ publishedItemRevisionStatus: published("2.1.1") }).action, "proceed");
  assert.equal(decide({}).action, "proceed");
  assert.equal(decide({ publishedItemRevisionStatus: published("2.2.0") }).action, "already-live");
  assert.equal(decide({ submittedItemRevisionStatus: published("2.2.0", "PENDING_REVIEW") }).action, "already-submitted");
  const refusals = [
    [{ publishedItemRevisionStatus: published("2.3.0") }, "version-not-higher"],
    [{ publishedItemRevisionStatus: published("2.2.0.1") }, "version-not-higher"],
    [{ submittedItemRevisionStatus: published("2.2.1", "PENDING_REVIEW") }, "other-version-in-review"],
    [{ submittedItemRevisionStatus: published("2.2.0", "STAGED") }, "staged-submission-exists"],
    [{ submittedItemRevisionStatus: published("2.2.0", "REJECTED") }, "version-not-higher"],
    [{ submittedItemRevisionStatus: published("2.2.0", "CANCELLED") }, "version-not-higher"],
    [{ publishedItemRevisionStatus: published("2.1.1"), takenDown: true }, "item-taken-down"],
    [{ publishedItemRevisionStatus: published("2.1.1"), warned: true }, "item-warned"],
  ];
  for (const [fields, code] of refusals) assert.throws(() => decide(fields), (e) => e.code === code, code);
});

// ---- the transport ----

test("preflight and status only ever read: a write-denying transport is enough to run them", async () => {
  const store = fakeStore({ [STATUS_PATH]: status({ publishedItemRevisionStatus: published("2.1.1") }) });
  const { dir } = stagedPackage();
  const env = { ...RUN_ENV, RELEASE_MODE: "status", RELEASE_COMMIT: COMMIT, RELEASE_VERSION: "2.2.0", RELEASE_ZIP_SHA256: "a".repeat(64), CWS_ACCESS_TOKEN: TOKEN, CWS_PUBLISHER_ID: PUBLISHER, CWS_EXTENSION_ID: ITEM };
  const io = capture();
  assert.equal(await main(["preflight", "--dir", dir], { env, fetchImpl: store.fetchImpl, ...io.deps }), 0, io.text());
  assert.ok(store.calls.length >= 1);
  assert.deepEqual(store.writes(), []);
  // Control: the same transport really does refuse a write.
  await assert.rejects(client(store.fetchImpl).upload(new Uint8Array([1])), /write denied/);
});

test("every request goes to the Chrome Web Store API with the token, and redirects are refused", async () => {
  const store = fakeStore({ [STATUS_PATH]: status({}) });
  await client(store.fetchImpl).fetchStatus();
  const [call] = store.calls;
  assert.equal(call.url, `${API_ORIGIN}/v2/${NAME}:fetchStatus`);
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.redirect, "error");
  assert.equal(API_ORIGIN, "https://chromewebstore.googleapis.com");
  assert.equal(READ_SCOPE, "https://www.googleapis.com/auth/chromewebstore.readonly");
  assert.equal(WRITE_SCOPE, "https://www.googleapis.com/auth/chromewebstore");
});

test("a missing token, publisher ID or extension ID stops before any request", () => {
  const store = fakeStore({});
  const base = { fetchImpl: store.fetchImpl, token: TOKEN, publisherId: PUBLISHER, itemId: ITEM };
  for (const [field, value, code] of [
    ["token", "", "token-missing"],
    ["token", undefined, "token-missing"],
    ["publisherId", "", "config-missing"],
    ["publisherId", "a/b", "config-missing"],
    ["itemId", "", "config-missing"],
    ["itemId", "not-an-extension-id", "config-missing"],
    ["fetchImpl", undefined, "config-missing"],
  ])
    assert.throws(() => createStoreClient({ ...base, [field]: value }), (e) => e.code === code, `${field}=${value}`);
  assert.equal(store.calls.length, 0);
  // Control: with everything present a client is created.
  assert.equal(createStoreClient(base).name, NAME);
});

test("reads are retried a few times on rate limits and outages; then the run stops", async () => {
  const store = fakeStore({ [STATUS_PATH]: [{ status: 503, body: {} }, { status: 429, body: {} }, status({})] });
  await client(store.fetchImpl).fetchStatus();
  assert.equal(store.calls.length, 3);
  const down = fakeStore({ [STATUS_PATH]: { status: 503, body: {} } });
  await assert.rejects(client(down.fetchImpl).fetchStatus(), (e) => e.code === "store-http-503");
  assert.equal(down.calls.length, 4);
  const denied = fakeStore({ [STATUS_PATH]: { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "no" } } } });
  await assert.rejects(client(denied.fetchImpl).fetchStatus(), (e) => e.code === "store-access-denied" && /no fallback/i.test(e.message));
  assert.equal(denied.calls.length, 1);
});

test("upload and submit are sent exactly once, even when the answer is lost", async () => {
  for (const failure of [new TypeError("socket hang up"), { status: 500, body: {} }, { status: 429, body: {} }]) {
    const store = fakeStore({ [UPLOAD_PATH]: failure, [PUBLISH_PATH]: failure }, { allowWrites: true });
    await assert.rejects(client(store.fetchImpl).upload(new Uint8Array([1, 2, 3])));
    await assert.rejects(client(store.fetchImpl).submit());
    assert.equal(store.calls.length, 2, JSON.stringify(failure));
  }
});

test("the submission body is fixed: normal review, live after approval, stop on warnings, no percentage", async () => {
  assert.deepEqual({ ...PUBLISH_BODY }, { publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: true });
  assert.ok(Object.isFrozen(PUBLISH_BODY));
  const store = fakeStore({ [PUBLISH_PATH]: { body: { state: "PENDING_REVIEW" } } }, { allowWrites: true });
  await client(store.fetchImpl).submit();
  const [call] = store.calls;
  assert.deepEqual(JSON.parse(call.body), { publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: true });
  assert.ok(!("deployInfos" in JSON.parse(call.body)));
  assert.equal(call.headers["Content-Type"], "application/json");
});

test("the module has no way to cancel a review or change a rollout percentage", () => {
  const source = readFileSync(new URL("chrome-store.mjs", HERE), "utf8") + readFileSync(new URL("chrome-release.mjs", HERE), "utf8");
  for (const forbidden of [":cancelSubmission", ":setPublishedDeployPercentage", "deployPercentage\":", "STAGED_PUBLISH\"", "skipReview: true", "/v1.1/", "chromewebstore/v1"])
    assert.ok(!source.includes(forbidden), forbidden);
  assert.deepEqual(Object.keys(storeModule).sort(), ["API_ORIGIN", "PUBLISH_BODY", "READ_SCOPE", "StoreRefusal", "WRITE_SCOPE", "compareChromeVersions", "createStoreClient", "decidePreflight", "parseChromeVersion", "redact", "summarizeStatus"]);
  assert.deepEqual(Object.keys(client(fakeStore({}).fetchImpl)).sort(), ["fetchStatus", "name", "secrets", "submit", "upload", "waitForUpload"]);
});

test("the scripts that run beside the token load only Node built-ins and each other", () => {
  for (const file of ["chrome-store.mjs", "chrome-release.mjs"]) {
    const source = readFileSync(new URL(file, HERE), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    // chrome-store.mjs imports nothing at all; chrome-release.mjs must show its imports to this scan.
    if (file === "chrome-release.mjs") assert.ok(imports.includes("./chrome-store.mjs") && imports.some((s) => s.startsWith("node:")), "import scan sees nothing");
    assert.ok(!/\brequire\(/.test(source), `${file} uses require`);
    for (const spec of imports) assert.ok(spec.startsWith("node:") || spec === "./chrome-store.mjs", `${file} imports ${spec}`);
    assert.ok(!/\bimport\(/.test(source), `${file} has a dynamic import`);
    assert.ok(!/process\.env\.\w*(API|BASE|ORIGIN|URL)/.test(source), `${file} reads an address from the environment`);
  }
});

// ---- upload flow ----

async function uploadWith(routes, preflightAction = "proceed", version = "2.2.0") {
  const { dir, bytes } = stagedPackage(version);
  writeFileSync(join(dir, "preflight.json"), JSON.stringify({ action: preflightAction }));
  const store = fakeStore(routes, { allowWrites: true });
  const inputs = { mode: "upload", version, commit: COMMIT, zipSha256: "", confirm: "" };
  return { store, run: () => runUpload({ client: client(store.fetchImpl), inputs, dir, bytes }), dir };
}

test("upload succeeds only with SUCCEEDED, waits for IN_PROGRESS by reading, and blocks a version mismatch", async () => {
  let t = await uploadWith({ [UPLOAD_PATH]: { body: { uploadState: "SUCCEEDED", crxVersion: "2.2.0" } } });
  assert.equal((await t.run()).versionConfirmed, true);

  t = await uploadWith({ [UPLOAD_PATH]: { body: { uploadState: "UPLOAD_IN_PROGRESS" } }, [STATUS_PATH]: [status({ lastAsyncUploadState: "IN_PROGRESS" }), status({ lastAsyncUploadState: "SUCCEEDED" })] });
  const r = await t.run();
  assert.equal(r.state, "SUCCEEDED");
  assert.equal(t.store.writes().length, 1);

  t = await uploadWith({ [UPLOAD_PATH]: { body: { uploadState: "IN_PROGRESS" } }, [STATUS_PATH]: status({ lastAsyncUploadState: "IN_PROGRESS" }) });
  await assert.rejects(t.run(), (e) => e.code === "upload-still-processing");
  assert.equal(t.store.writes().length, 1, "a slow upload is never sent again");

  t = await uploadWith({ [UPLOAD_PATH]: { body: { uploadState: "FAILED" } } });
  await assert.rejects(t.run(), (e) => e.code === "upload-failed");

  t = await uploadWith({ [UPLOAD_PATH]: { body: { uploadState: "SUCCEEDED", crxVersion: "2.1.9" } } });
  await assert.rejects(t.run(), (e) => e.code === "store-version-mismatch");

  t = await uploadWith({ [UPLOAD_PATH]: { body: { uploadState: "SUCCEEDED", crxVersion: "2.2.0" } } }, "already-submitted");
  await assert.rejects(t.run(), (e) => e.code === "preflight-not-passed");
  assert.equal(t.store.calls.length, 0);
});

// ---- the whole store job, through the CLI ----

function storeEnv(mode, dir, digest, extra = {}) {
  return {
    ...RUN_ENV,
    RELEASE_MODE: mode,
    RELEASE_COMMIT: COMMIT,
    RELEASE_VERSION: "2.2.0",
    RELEASE_ZIP_SHA256: digest,
    RELEASE_CONFIRM_SUBMIT: mode === "upload-and-submit" ? "submit 2.2.0" : "",
    PACKAGE_ZIP_SHA256: digest,
    CWS_ACCESS_TOKEN: TOKEN,
    CWS_PUBLISHER_ID: PUBLISHER,
    CWS_EXTENSION_ID: ITEM,
    GITHUB_OUTPUT: join(dir, "github-output"),
    GITHUB_STEP_SUMMARY: join(dir, "step-summary.md"),
    ...extra,
  };
}

test("upload-and-submit end to end: read, upload once, submit once, read back, closing record", async () => {
  const { dir, digest } = stagedPackage();
  const store = fakeStore(
    {
      [STATUS_PATH]: [status({ publishedItemRevisionStatus: published("2.1.1") }), status({ lastAsyncUploadState: "SUCCEEDED" }), status({ publishedItemRevisionStatus: published("2.1.1"), submittedItemRevisionStatus: published("2.2.0", "PENDING_REVIEW") })],
      [UPLOAD_PATH]: { body: { uploadState: "IN_PROGRESS" } },
      [PUBLISH_PATH]: { body: { state: "PENDING_REVIEW", warningInfo: { warnings: [] } } },
    },
    { allowWrites: true },
  );
  const env = storeEnv("upload-and-submit", dir, digest);
  const io = capture();
  for (const command of ["check-inputs", "verify-artifact", "preflight", "upload", "submit"]) assert.equal(await main([command, "--dir", dir].slice(0, command === "check-inputs" ? 1 : 3), { env, fetchImpl: store.fetchImpl, clientOptions: { sleep: noSleep, pollIntervalMs: 1 }, ...io.deps }), 0, `${command}: ${io.text()}`);
  assert.deepEqual(store.writes().map((c) => c.url.slice(API_ORIGIN.length)), [`/upload/v2/${NAME}:upload`, `/v2/${NAME}:publish`]);
  assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /action=proceed\nuploaded=true\n/);
  assert.equal(await main(["receipt", "--dir", dir], { env: { ...env, JOB_STATUS: "success" }, ...io.deps }), 0);
  const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
  assert.equal(receipt.submit.state, "PENDING_REVIEW");
  assert.equal(receipt.submit.versionInStore, "2.2.0");
  assert.equal(receipt.extensionId, ITEM);
  rmSync(dir, { recursive: true, force: true });
});

test("a re-run after a finished submission writes nothing", async () => {
  const { dir, digest } = stagedPackage();
  const store = fakeStore({ [STATUS_PATH]: status({ publishedItemRevisionStatus: published("2.1.1"), submittedItemRevisionStatus: published("2.2.0", "PENDING_REVIEW") }) });
  const env = storeEnv("upload-and-submit", dir, digest);
  const io = capture();
  assert.equal(await main(["preflight", "--dir", dir], { env, fetchImpl: store.fetchImpl, ...io.deps }), 0);
  assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /action=already-submitted/);
  // Even if the workflow's step conditions were wrong, the upload command itself refuses.
  assert.equal(await main(["upload", "--dir", dir], { env, fetchImpl: store.fetchImpl, ...io.deps }), 1);
  assert.match(io.err.join(""), /preflight-not-passed/);
  assert.deepEqual(store.writes(), []);
});

test("submit refuses without the typed confirmation, a different mode, or a successful upload from this run", async () => {
  const { dir, digest } = stagedPackage();
  const store = fakeStore({}, { allowWrites: true });
  const io = capture();
  assert.equal(await main(["submit", "--dir", dir], { env: storeEnv("upload-and-submit", dir, digest), fetchImpl: store.fetchImpl, ...io.deps }), 1, "no upload.json yet");
  writeFileSync(join(dir, "upload.json"), JSON.stringify({ state: "SUCCEEDED" }));
  assert.equal(await main(["submit", "--dir", dir], { env: storeEnv("upload", dir, digest), fetchImpl: store.fetchImpl, ...io.deps }), 1, "upload mode");
  assert.equal(await main(["submit", "--dir", dir], { env: storeEnv("upload-and-submit", dir, digest, { RELEASE_CONFIRM_SUBMIT: "submit 2.2.1" }), fetchImpl: store.fetchImpl, ...io.deps }), 1, "wrong confirmation");
  assert.deepEqual(store.calls, []);
});

test("a submission the store does not hold at the expected version fails the run loudly", async () => {
  const { dir, digest } = stagedPackage();
  writeFileSync(join(dir, "upload.json"), JSON.stringify({ state: "SUCCEEDED" }));
  const store = fakeStore({ [PUBLISH_PATH]: { body: { state: "PENDING_REVIEW" } }, [STATUS_PATH]: status({ submittedItemRevisionStatus: published("2.1.9", "PENDING_REVIEW") }) }, { allowWrites: true });
  const io = capture();
  assert.equal(await main(["submit", "--dir", dir], { env: storeEnv("upload-and-submit", dir, digest), fetchImpl: store.fetchImpl, ...io.deps }), 1);
  assert.match(io.err.join(""), /store-version-mismatch.*dashboard/);
});

// ---- logs never carry the token or the publisher ID ----

test("store errors that echo the token, a bearer header or the publisher are redacted in every output", async () => {
  const { dir, digest } = stagedPackage();
  const leaky = { error: { status: "PERMISSION_DENIED", message: `token ${TOKEN} header Bearer ${TOKEN} for ${NAME} publisher ${PUBLISHER}` } };
  const store = fakeStore({ [STATUS_PATH]: { status: 403, body: leaky } });
  const io = capture();
  const env = storeEnv("status", dir, digest, { GITHUB_ACTIONS: "true" });
  assert.equal(await main(["preflight", "--dir", dir], { env, fetchImpl: store.fetchImpl, ...io.deps }), 1);
  const printed = io.text();
  assert.match(printed, /store-access-denied/);
  assert.ok(!printed.includes(TOKEN), "token printed");
  assert.ok(!printed.includes("a0TESTTOKEN"), "token fragment printed");
  // The only place the publisher ID may appear is GitHub's own mask command, which GitHub hides.
  const lines = printed.split("\n").filter((l) => l.includes(PUBLISHER));
  assert.deepEqual(lines, [`::add-mask::${PUBLISHER}`]);
  // Outside GitHub Actions no mask command is printed at all.
  const local = capture();
  await main(["preflight", "--dir", dir], { env: { ...env, GITHUB_ACTIONS: "" }, fetchImpl: store.fetchImpl, ...local.deps });
  assert.ok(!local.text().includes(PUBLISHER));
});

test("a network error carrying the token is redacted too", async () => {
  const { dir, digest } = stagedPackage();
  const store = fakeStore({ [STATUS_PATH]: new Error(`connect failed Authorization: Bearer ${TOKEN}`) });
  const io = capture();
  assert.equal(await main(["preflight", "--dir", dir], { env: storeEnv("status", dir, digest), fetchImpl: store.fetchImpl, clientOptions: { sleep: noSleep }, ...io.deps }), 1);
  assert.ok(!io.text().includes(TOKEN));
  assert.match(io.text(), /network/);
});

test("the closing record and step summary contain no token, no publisher ID and no raw store answer", async () => {
  const { dir, digest } = stagedPackage();
  writeFileSync(join(dir, "preflight.json"), JSON.stringify({ action: "proceed", publishedVersion: "2.1.1", raw: TOKEN, name: NAME }));
  writeFileSync(join(dir, "upload.json"), JSON.stringify({ state: "SUCCEEDED", crxVersion: "2.2.0", versionConfirmed: true, extra: PUBLISHER }));
  const io = capture();
  const env = storeEnv("upload", dir, digest, { JOB_STATUS: "success" });
  assert.equal(await main(["receipt", "--dir", dir], { env, ...io.deps }), 0, io.text());
  const written = readFileSync(join(dir, "receipt.json"), "utf8") + readFileSync(env.GITHUB_STEP_SUMMARY, "utf8") + io.text();
  for (const value of [TOKEN, PUBLISHER, "publishers/"]) assert.ok(!written.includes(value), value);
  assert.match(written, /2\.2\.0/);
  // A receipt is still written when the run failed before anything else, into a fresh directory.
  const fresh = join(workdir(), "never-created");
  assert.equal(await main(["receipt", "--dir", fresh], { env: { ...env, RELEASE_MODE: "nonsense" }, ...io.deps }), 0);
  assert.equal(JSON.parse(readFileSync(join(fresh, "receipt.json"), "utf8")).mode, null);
});

test("redact covers tokens, bearer headers, item names and given values", () => {
  const text = redact(`a ${TOKEN} b Bearer abc.def c ${NAME} d secret-value e`, ["secret-value"]);
  for (const value of [TOKEN, "abc.def", PUBLISHER, "secret-value"]) assert.ok(!text.includes(value), value);
});

// ---- inputs, run context and approvals ----

test("inputs: mode, commit, version, fingerprint and the typed confirmation are all checked", () => {
  const ok = { RELEASE_MODE: "upload", RELEASE_COMMIT: COMMIT, RELEASE_VERSION: "2.2.0", RELEASE_ZIP_SHA256: "f".repeat(64), RELEASE_CONFIRM_SUBMIT: "" };
  assert.equal(checkInputs(ok).mode, "upload");
  assert.equal(checkInputs({ ...ok, RELEASE_MODE: "package-only", RELEASE_ZIP_SHA256: "" }).zipSha256, "");
  assert.equal(checkInputs({ ...ok, RELEASE_MODE: "upload-and-submit", RELEASE_CONFIRM_SUBMIT: "submit 2.2.0" }).confirm, "submit 2.2.0");
  for (const bad of [
    { RELEASE_MODE: "publish" },
    { RELEASE_MODE: "" },
    { RELEASE_COMMIT: COMMIT.slice(1) },
    { RELEASE_COMMIT: COMMIT.toUpperCase() },
    { RELEASE_VERSION: "2.2" },
    { RELEASE_VERSION: "2.2.0; rm -rf /" },
    { RELEASE_ZIP_SHA256: "" },
    { RELEASE_ZIP_SHA256: "F".repeat(64) },
    { RELEASE_MODE: "upload-and-submit", RELEASE_CONFIRM_SUBMIT: "" },
    { RELEASE_MODE: "upload-and-submit", RELEASE_CONFIRM_SUBMIT: "submit 2.2.1" },
    { RELEASE_MODE: "upload-and-submit", RELEASE_CONFIRM_SUBMIT: "Submit 2.2.0" },
    { RELEASE_CONFIRM_SUBMIT: "submit 2.2.0" },
  ])
    assert.throws(() => checkInputs({ ...ok, ...bad }), StoreRefusal, JSON.stringify(bad));
});

test("the run must be this repository's release-chrome workflow, started by hand on main", () => {
  checkRunContext(RUN_ENV);
  for (const [key, value] of [
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_REPOSITORY", "someone/still-app"],
    ["GITHUB_REPOSITORY_ID", "1"],
    ["GITHUB_REPOSITORY_OWNER_ID", "1"],
    ["GITHUB_WORKFLOW_REF", "ZackC-1/still-app/.github/workflows/ci.yml@refs/heads/main"],
    ["GITHUB_WORKFLOW_REF", "ZackC-1/still-app/.github/workflows/release-chrome.yml@refs/heads/other"],
  ])
    assert.throws(() => checkRunContext({ ...RUN_ENV, [key]: value }), (e) => e.code === "run-context", key);
});

function protectedEnvironment(overrides = {}) {
  return {
    id: 99,
    name: "chrome-release",
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { id: EXPECTED.ownerId } }] }],
    ...overrides,
  };
}
const ownerApproval = { state: "approved", user: { id: EXPECTED.ownerId }, environments: [{ id: 99 }] };

test("approval safeguards: owner-only review, no bypass, restricted branches, owner approved this run", () => {
  assert.deepEqual(checkEnvironmentProtection({ environment: protectedEnvironment(), approvals: [ownerApproval, ownerApproval] }), []);
  const mainOnly = protectedEnvironment({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  assert.deepEqual(checkEnvironmentProtection({ environment: mainOnly, branches: { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] }, approvals: [ownerApproval] }), []);
  const cases = [
    [{ environment: null }, "environment-missing"],
    [{ environment: protectedEnvironment({ can_admins_bypass: true }), approvals: [ownerApproval] }, "admin-bypass-not-disabled"],
    [{ environment: protectedEnvironment({ protection_rules: [] }), approvals: [ownerApproval] }, "required-reviewer-not-exactly-owner"],
    [{ environment: protectedEnvironment({ protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] }] }), approvals: [ownerApproval] }, "required-reviewer-not-exactly-owner"],
    [{ environment: protectedEnvironment({ protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: EXPECTED.ownerId } }, { type: "Team", reviewer: { id: 5 } }] }] }), approvals: [ownerApproval] }, "required-reviewer-not-exactly-owner"],
    [{ environment: protectedEnvironment({ deployment_branch_policy: null }), approvals: [ownerApproval] }, "deployment-branches-not-restricted"],
    [{ environment: mainOnly, branches: { total_count: 2, branch_policies: [{ name: "main" }, { name: "dev" }] }, approvals: [ownerApproval] }, "deployment-branches-not-restricted"],
    [{ environment: protectedEnvironment(), approvals: [] }, "owner-approval-not-observed"],
    [{ environment: protectedEnvironment(), approvals: [ownerApproval, { ...ownerApproval, user: { id: 7 } }] }, "owner-approval-not-observed"],
    [{ environment: protectedEnvironment(), approvals: [{ ...ownerApproval, state: "rejected" }] }, "owner-approval-not-observed"],
  ];
  for (const [args, issue] of cases) assert.ok(checkEnvironmentProtection(args).includes(issue), issue);
});

test("a changed OIDC subject (repository rename or immutable subjects) is caught with a clear reason", () => {
  assert.deepEqual(checkSubjectCustomization({ use_default: true, use_immutable_subject: false, sub_claim_prefix: "repo:ZackC-1/still-app" }), []);
  for (const sub of [null, { use_default: false }, { use_default: true, use_immutable_subject: true }, { use_default: true, sub_claim_prefix: "repo:ZackC-1@257643931/still-app@1278502679" }])
    assert.deepEqual(checkSubjectCustomization(sub), ["oidc-subject-changed"], JSON.stringify(sub));
});

test("the protection command reads GitHub only, and refuses when the safeguards drifted", async () => {
  const github = (environment, approvals, sub = { use_default: true, use_immutable_subject: false }) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method });
      assert.equal(init.method, "GET");
      assert.ok(url.startsWith("https://api.github.com/repos/ZackC-1/still-app/"), url);
      const path = url.slice("https://api.github.com/repos/ZackC-1/still-app".length);
      const body = path === "/environments/chrome-release" ? environment : path === "/actions/runs/4242/approvals" ? approvals : path === "/actions/oidc/customization/sub" ? sub : undefined;
      if (body === undefined) return new Response("{}", { status: 404 });
      if (body === "forbidden") return new Response("{}", { status: 403 });
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return { fetchImpl, calls };
  };
  const env = { ...RUN_ENV, RELEASE_MODE: "status", RELEASE_COMMIT: COMMIT, RELEASE_VERSION: "2.2.0", RELEASE_ZIP_SHA256: "a".repeat(64), GH_TOKEN: "ghs_testtoken123" };
  let io = capture();
  assert.equal(await main(["protection"], { env, fetchImpl: github(protectedEnvironment(), [ownerApproval]).fetchImpl, ...io.deps }), 0, io.text());
  io = capture();
  assert.equal(await main(["protection"], { env, fetchImpl: github(protectedEnvironment(), [ownerApproval], "forbidden").fetchImpl, ...io.deps }), 0, "an unreadable subject setting is left to Google");
  assert.match(io.text(), /could not be read/);
  io = capture();
  assert.equal(await main(["protection"], { env, fetchImpl: github(protectedEnvironment({ can_admins_bypass: true }), [ownerApproval]).fetchImpl, ...io.deps }), 1);
  assert.match(io.err.join(""), /admin-bypass-not-disabled/);
  io = capture();
  assert.equal(await main(["protection"], { env, fetchImpl: github(protectedEnvironment(), [ownerApproval], { use_default: true, use_immutable_subject: true }).fetchImpl, ...io.deps }), 1);
  assert.match(io.err.join(""), /oidc-subject-changed/);
  io = capture();
  assert.equal(await main(["protection"], { env, fetchImpl: github("forbidden", [ownerApproval]).fetchImpl, ...io.deps }), 1, "unreadable environment fails closed");
  assert.ok(!io.text().includes("ghs_testtoken123"));
  io = capture();
  assert.equal(await main(["protection"], { env: { ...env, RELEASE_MODE: "package-only", RELEASE_ZIP_SHA256: "" }, fetchImpl: github(protectedEnvironment(), [ownerApproval]).fetchImpl, ...io.deps }), 1, "package-only never reaches the store job");
});

// ---- package verification ----

test("the downloaded package must match its own sums, the build job and the owner's fingerprint", () => {
  const { dir, digest } = stagedPackage();
  const inputs = { version: "2.2.0", zipSha256: digest };
  assert.equal(verifyArtifact({ dir: join(dir, "package"), inputs, packageSha256: digest }).sha256, digest);
  assert.throws(() => verifyArtifact({ dir: join(dir, "package"), inputs: { ...inputs, zipSha256: "0".repeat(64) }, packageSha256: digest }), /approved fingerprint/);
  assert.throws(() => verifyArtifact({ dir: join(dir, "package"), inputs, packageSha256: "0".repeat(64) }), /changed between/);
  assert.throws(() => verifyArtifact({ dir: join(dir, "package"), inputs: { ...inputs, version: "2.2.1" }, packageSha256: digest }), /missing/);
  writeFileSync(join(dir, "package", zipName("2.2.0")), "tampered");
  assert.throws(() => verifyArtifact({ dir: join(dir, "package"), inputs, packageSha256: digest }), /own SHA256SUMS/);
  const other = stagedPackage();
  writeFileSync(join(other.dir, "package", "SHA256SUMS.json"), JSON.stringify({ version: "2.1.0", files: {} }));
  assert.throws(() => verifyArtifact({ dir: join(other.dir, "package"), inputs: { version: "2.2.0", zipSha256: other.digest }, packageSha256: other.digest }), /is for 2\.1\.0/);
});

test("a store package must have the paid tier off", () => {
  assertPaidTierOff("export const PAID_TIER_ENABLED = false;\n");
  assert.throws(() => assertPaidTierOff("export const PAID_TIER_ENABLED = true;\n"), (e) => e.code === "paid-flag-on");
  assert.throws(() => assertPaidTierOff("export const SOMETHING = false;\n"), (e) => e.code === "paid-flag-unknown");
  assertPaidTierOff(readFileSync(new URL("../../packages/shared-types/src/entitlement.ts", HERE), "utf8"));
});

test("public build values: the four required ones must be present; the sync switch is optional", () => {
  const full = { VITE_SUPABASE_URL: "https://x.supabase.co", VITE_SUPABASE_ANON_KEY: "pk", VITE_POSTHOG_KEY: "phc", VITE_POSTHOG_HOST: "https://ph", OTHER: "ignored" };
  assert.deepEqual(collectPublicEnv(full), { VITE_SUPABASE_URL: "https://x.supabase.co", VITE_SUPABASE_ANON_KEY: "pk", VITE_POSTHOG_KEY: "phc", VITE_POSTHOG_HOST: "https://ph" });
  assert.equal(collectPublicEnv({ ...full, VITE_MODERN_SETTINGS_SYNC_ENABLED: "true" }).VITE_MODERN_SETTINGS_SYNC_ENABLED, "true");
  for (const key of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_POSTHOG_KEY", "VITE_POSTHOG_HOST"]) assert.throws(() => collectPublicEnv({ ...full, [key]: "" }), (e) => e.code === "build-values-missing", key);
});

test("the built package must carry the requested version and, outside package-only, the approved fingerprint", () => {
  const bytes = Buffer.from("zip bytes");
  const digest = sha256(bytes);
  const manifest = { version: "2.2.0", files: { [zipName("2.2.0")]: { sha256: digest } } };
  assert.equal(verifyBuilt({ manifest, zipBytes: bytes, inputs: { version: "2.2.0", zipSha256: "" } }), digest);
  assert.equal(verifyBuilt({ manifest, zipBytes: bytes, inputs: { version: "2.2.0", zipSha256: digest } }), digest);
  assert.throws(() => verifyBuilt({ manifest, zipBytes: bytes, inputs: { version: "2.2.0", zipSha256: "1".repeat(64) } }), /not the approved/);
  assert.throws(() => verifyBuilt({ manifest: { ...manifest, version: "2.1.1" }, zipBytes: bytes, inputs: { version: "2.2.0", zipSha256: "" } }), /says 2\.1\.1/);
  assert.throws(() => verifyBuilt({ manifest, zipBytes: Buffer.from("other"), inputs: { version: "2.2.0", zipSha256: "" } }), /own fingerprint/);
});

test("the build job builds only a commit on main, with the paid tier off, and hands over exactly two files", () => {
  const publicEnv = { VITE_SUPABASE_URL: "u", VITE_SUPABASE_ANON_KEY: "k", VITE_POSTHOG_KEY: "p", VITE_POSTHOG_HOST: "h" };
  const env = { ...RUN_ENV, ...publicEnv, RELEASE_MODE: "package-only", RELEASE_COMMIT: COMMIT, RELEASE_VERSION: "2.2.0", RELEASE_ZIP_SHA256: "", RELEASE_CONFIRM_SUBMIT: "" };
  const fakeGit = ({ onMain = true, paid = false } = {}) => (args) => {
    if (args[0] === "merge-base") {
      if (!onMain) throw new Error("not an ancestor");
      return "";
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const dir = args[3];
      mkdirSync(join(dir, "packages/shared-types/src"), { recursive: true });
      writeFileSync(join(dir, "packages/shared-types/src/entitlement.ts"), `export const PAID_TIER_ENABLED = ${paid};\n`);
      return "";
    }
    return "";
  };
  const builds = [];
  const fakeBuild = ({ out, root, env: values }) => {
    builds.push({ root, values });
    mkdirSync(out, { recursive: true });
    const bytes = Buffer.from("built 2.2.0");
    writeFileSync(join(out, zipName("2.2.0")), bytes);
    writeFileSync(join(out, "still-firefox-2.2.0.zip"), "ff");
    const manifest = { version: "2.2.0", files: { [zipName("2.2.0")]: { sha256: sha256(bytes) } } };
    writeFileSync(join(out, "SHA256SUMS.json"), JSON.stringify(manifest));
    return manifest;
  };
  const out = join(workdir(), "artifact");
  const result = runPackage({ env, out, build: fakeBuild, git: fakeGit() });
  assert.equal(result.digest, sha256(Buffer.from("built 2.2.0")));
  assert.deepEqual(readdirSync(out).sort(), ["SHA256SUMS.json", zipName("2.2.0")]);
  assert.deepEqual(builds[0].values, publicEnv);
  assert.throws(() => runPackage({ env, out, build: fakeBuild, git: fakeGit({ onMain: false }) }), (e) => e.code === "commit-not-on-main");
  assert.throws(() => runPackage({ env, out, build: fakeBuild, git: fakeGit({ paid: true }) }), (e) => e.code === "paid-flag-on");
  assert.throws(() => runPackage({ env: { ...env, RELEASE_MODE: "upload", RELEASE_ZIP_SHA256: "2".repeat(64) }, out, build: fakeBuild, git: fakeGit() }), (e) => e.code === "package-mismatch");
  assert.throws(() => runPackage({ env: { ...env, GITHUB_REF: "refs/heads/x" }, out, build: fakeBuild, git: fakeGit() }), (e) => e.code === "run-context");
  assert.equal(builds.length, 2, "refusals before the build never start one");
});


test("receipts fall back to nulls when nothing ran", () => {
  const dir = workdir();
  const receipt = buildReceipt({ inputs: null, extensionId: "not-an-id", dir, outcome: "" });
  assert.deepEqual([receipt.mode, receipt.extensionId, receipt.preflight, receipt.upload, receipt.submit, receipt.outcome], [null, null, null, null, null, "unknown"]);
});
