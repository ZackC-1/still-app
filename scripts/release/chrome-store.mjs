// The small part of the Chrome Web Store API (v2) that Still's release workflow needs:
// read an item's status, upload a package, and submit it for review. Nothing else.
//
// Deliberately absent: cancelling a review and changing a rollout percentage. Reviews are cancelled
// in the dashboard by the owner, and Still has no percentage rollout (both by owner decision).
//
// Rules this module keeps:
//   - Node built-ins only. It runs in the one job that holds a Google token, so no package from
//     npm is ever loaded next to that token.
//   - The API address is a constant. There is no flag or variable that can point the token anywhere
//     else; tests replace `fetch` instead.
//   - Reads may be retried a few times. Upload and submit are never retried automatically: if the
//     answer is lost, the next run's status check finds out what really happened.
//   - Every message that may reach a log goes through redact(), so a token or the publisher ID in an
//     error body is never printed.

export const API_ORIGIN = "https://chromewebstore.googleapis.com";
export const READ_SCOPE = "https://www.googleapis.com/auth/chromewebstore.readonly";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/chromewebstore";

// Publish exactly like this, always: normal review (never an attempt to skip it), live automatically
// once Google approves (no staged hold, by owner decision), stop on any warning, and no rollout percentage.
export const PUBLISH_BODY = Object.freeze({ publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: true });

const EXTENSION_ID = /^[a-p]{32}$/;
const PUBLISHER_ID = /^[A-Za-z0-9-]{1,64}$/;
const ITEM_STATES = new Set(["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS", "REJECTED", "CANCELLED"]);
const UPLOAD_STATES = new Set(["SUCCEEDED", "IN_PROGRESS", "FAILED", "NOT_FOUND"]);

export class StoreRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreRefusal";
    this.code = code;
  }
}

/**
 * Remove anything secret-looking from text before it is printed: the given values (token, publisher
 * ID), any Google access token, any bearer header, and the publisher part of an item name.
 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out
    .replace(/ya29\.[A-Za-z0-9._~+/=-]+/g, "[redacted-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/publishers\/[^/\s"']+/g, "publishers/[redacted]")
    .slice(0, 600);
}

/** Chrome extension versions: one to four dot-separated integers 0-65535, no leading zeros. */
export function parseChromeVersion(text) {
  const parts = String(text).split(".");
  if (parts.length < 1 || parts.length > 4) throw new StoreRefusal("version-invalid", `"${text}" is not a Chrome extension version`);
  return parts.map((part) => {
    if (!/^(0|[1-9]\d{0,4})$/.test(part) || Number(part) > 65535) throw new StoreRefusal("version-invalid", `"${text}" is not a Chrome extension version`);
    return Number(part);
  });
}

/** Negative when a < b, zero when equal, positive when a > b. Missing parts count as zero. */
export function compareChromeVersions(a, b) {
  const [x, y] = [parseChromeVersion(a), parseChromeVersion(b)];
  for (let i = 0; i < 4; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function normalizeUploadState(state) {
  if (state === undefined || state === null || state === "") return undefined;
  // The overview page writes UPLOAD_IN_PROGRESS; the reference enum says IN_PROGRESS. Accept both.
  const value = state === "UPLOAD_IN_PROGRESS" ? "IN_PROGRESS" : state;
  if (!UPLOAD_STATES.has(value)) throw new StoreRefusal("store-response-unexpected", `Unknown upload state ${JSON.stringify(state)}`);
  return value;
}

function revision(status, label) {
  if (status === undefined || status === null) return null;
  if (typeof status !== "object" || !ITEM_STATES.has(status.state))
    throw new StoreRefusal("store-response-unexpected", `Unknown ${label} state ${JSON.stringify(status?.state)}`);
  const channels = Array.isArray(status.distributionChannels) ? status.distributionChannels : [];
  let version = null;
  for (const channel of channels) {
    if (channel?.crxVersion === undefined) continue;
    parseChromeVersion(channel.crxVersion);
    if (version === null || compareChromeVersions(channel.crxVersion, version) > 0) version = channel.crxVersion;
  }
  return { state: status.state, version };
}

/** The parts of a fetchStatus answer the release decisions use, validated. Unknown values refuse. */
export function summarizeStatus(status) {
  if (!status || typeof status !== "object") throw new StoreRefusal("store-response-unexpected", "The store returned no status");
  return {
    published: revision(status.publishedItemRevisionStatus, "published"),
    submitted: revision(status.submittedItemRevisionStatus, "submitted"),
    takenDown: status.takenDown === true,
    warned: status.warned === true,
    lastUploadState: normalizeUploadState(status.lastAsyncUploadState) ?? null,
  };
}

/**
 * Decide whether a release of `version` may go ahead, given the store's current status.
 * Returns { action: "proceed" | "already-submitted" | "already-live", note } or throws StoreRefusal.
 * "already-*" means a previous run finished the work; the caller must then write nothing.
 */
export function decidePreflight(summary, version) {
  parseChromeVersion(version);
  if (summary.takenDown) throw new StoreRefusal("item-taken-down", "The item is taken down. Resolve it in the Chrome Web Store dashboard first.");
  if (summary.warned) throw new StoreRefusal("item-warned", "Google has a policy warning on the item. The owner reviews it in the dashboard before any release.");
  const { published, submitted } = summary;
  if (published && published.version !== null && compareChromeVersions(published.version, version) === 0)
    return { action: "already-live", note: `Version ${version} is already published.` };
  if (submitted) {
    if (submitted.state === "PENDING_REVIEW") {
      if (submitted.version !== null && compareChromeVersions(submitted.version, version) === 0)
        return { action: "already-submitted", note: `Version ${version} is already submitted and in review.` };
      throw new StoreRefusal("other-version-in-review", `Version ${submitted.version ?? "(unknown)"} is in review. Cancel it in the dashboard first if that is intended; this workflow never cancels a review.`);
    }
    if ((submitted.state === "PUBLISHED" || submitted.state === "PUBLISHED_TO_TESTERS") && submitted.version !== null && compareChromeVersions(submitted.version, version) === 0)
      return { action: "already-live", note: `Version ${version} is already published.` };
    if (submitted.state === "STAGED") throw new StoreRefusal("staged-submission-exists", "An approved submission is waiting to be published. The owner decides what to do with it in the dashboard.");
    if (submitted.version !== null && compareChromeVersions(version, submitted.version) <= 0)
      throw new StoreRefusal("version-not-higher", `Version ${version} is not higher than the last submitted version ${submitted.version} (${submitted.state}).`);
  }
  if (published && published.version !== null && compareChromeVersions(version, published.version) <= 0)
    throw new StoreRefusal("version-not-higher", `Version ${version} is not higher than the published version ${published.version}.`);
  return { action: "proceed", note: published?.version ? `Store has ${published.version}; ${version} is higher.` : `No published version found; ${version} will be the first.` };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A client bound to one token and one item. Throws before any request if anything is missing.
 * `fetchImpl` is required (tests pass a fake; the CLI passes the global fetch).
 */
export function createStoreClient({ fetchImpl, token, publisherId, itemId, sleep = defaultSleep, pollIntervalMs = 10_000, pollTimeoutMs = 300_000, readRetries = 3 }) {
  if (typeof fetchImpl !== "function") throw new StoreRefusal("config-missing", "No transport was provided");
  if (typeof token !== "string" || token.length < 10) throw new StoreRefusal("token-missing", "No Google access token is available; keyless sign-in did not happen, and there is no other way in");
  if (typeof publisherId !== "string" || !PUBLISHER_ID.test(publisherId)) throw new StoreRefusal("config-missing", "The publisher ID is missing or malformed");
  if (typeof itemId !== "string" || !EXTENSION_ID.test(itemId)) throw new StoreRefusal("config-missing", "The extension ID is missing or malformed");
  const name = `publishers/${publisherId}/items/${itemId}`;
  const secrets = [token, publisherId];

  async function send(method, url, body, contentType) {
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (contentType) headers["Content-Type"] = contentType;
    let response;
    try {
      response = await fetchImpl(url, { method, headers, body, redirect: "error" });
    } catch (error) {
      throw new StoreRefusal("network", `The store could not be reached (${redact(error?.message, secrets)})`);
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (response.ok) throw new StoreRefusal("store-response-unexpected", "The store answered with something that is not JSON");
    }
    if (!response.ok) {
      const detail = json?.error ? `${json.error.status ?? ""} ${json.error.message ?? ""}`.trim() : text;
      const code = response.status === 401 || response.status === 403 ? "store-access-denied" : response.status === 429 ? "store-rate-limited" : `store-http-${response.status}`;
      const hint = code === "store-access-denied" ? " Keyless access is not working (service account link, API access or token scope). There is no fallback." : "";
      throw new StoreRefusal(code, `The store refused the request (HTTP ${response.status}): ${redact(detail, secrets)}.${hint}`);
    }
    return json;
  }

  async function read(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send("GET", url);
      } catch (error) {
        const retryable = error.code === "network" || error.code === "store-rate-limited" || /^store-http-5\d\d$/.test(error.code ?? "");
        if (!retryable || attempt >= readRetries) throw error;
        await sleep(2 ** attempt * 2_000);
      }
    }
  }

  const client = {
    name,
    secrets,
    async fetchStatus() {
      return read(`${API_ORIGIN}/v2/${name}:fetchStatus`);
    },
    /** Upload the exact bytes once. Returns { state, crxVersion }; never retried. */
    async upload(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new StoreRefusal("package-missing", "No package bytes to upload");
      const json = await send("POST", `${API_ORIGIN}/upload/v2/${name}:upload`, bytes, "application/zip");
      return { state: normalizeUploadState(json?.uploadState) ?? null, crxVersion: json?.crxVersion ?? null };
    },
    /** Poll the status (reads only) until the last upload finishes. */
    async waitForUpload() {
      const deadline = pollTimeoutMs;
      for (let waited = 0; ; waited += pollIntervalMs) {
        const state = summarizeStatus(await client.fetchStatus()).lastUploadState;
        if (state === "SUCCEEDED" || state === "FAILED" || state === "NOT_FOUND") return state;
        if (waited + pollIntervalMs > deadline) return "IN_PROGRESS";
        await sleep(pollIntervalMs);
      }
    },
    /** Submit the uploaded draft for review, once. */
    async submit() {
      const json = await send("POST", `${API_ORIGIN}/v2/${name}:publish`, JSON.stringify(PUBLISH_BODY), "application/json");
      if (!ITEM_STATES.has(json?.state)) throw new StoreRefusal("store-response-unexpected", `Unknown state after submitting: ${JSON.stringify(json?.state)}`);
      const warnings = Array.isArray(json?.warningInfo?.warnings) ? json.warningInfo.warnings.map((w) => String(w?.reason ?? "unknown")) : [];
      return { state: json.state, warnings };
    },
  };
  return client;
}
