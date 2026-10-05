import {
  PRODUCT_POLICY_MAX_BYTES,
  type ProductPolicyEnvironment,
  type ProductPolicyNamespace,
  type ProductPolicySurface,
} from "@still/shared-types/product-policy";
// Direct source paths, not the package indexes: the evaluator and cache are deliberately kept out
// of the barrels (see product-policy.ts), and nothing here should pull the sync or UI graphs in.
import {
  evaluateRatingPolicy, evaluateSalesPolicy, packagedPolicyContext,
  type PackagedPolicyContext, type ProductPolicyResponse, type ProductPolicyVerdict,
} from "../../core/src/entitlement/product-policy.js";
import {
  OrdinaryPolicyCache, type PolicyCacheRead, type PolicyCacheRecord,
} from "../../core/src/entitlement/product-policy-cache.js";

// Chrome and Firefox client for the remote product policy (U6). DORMANT: nothing imports this
// module yet, so no build contains it and no person can reach it.
//
// What it is for. Before a purchase may start or a review prompt may be requested, the background
// asks the public `product-policy` function one fresh question and evaluates the answer with the
// shared fail-safe evaluator. Free blocking, free sync and Restore never consult any of this
// (owner decision 17: Restore is never gated by policy).
//
// Rules this module keeps, each pinned by lib/__tests__/product-policy-runtime.test.ts:
//   * Background only. Content scripts and pages never import it, and it registers no listener,
//     alarm, interval or poll. A check runs only when a caller asks for one.
//   * One plain request: POST {"namespace","environment"} to the project's existing first-party
//     Supabase origin, with no query string, no account, install or device identifier, no session
//     token and no API key (the function is public: verify_jwt=false), `cache: "no-store"`,
//     `credentials: "omit"`, no redirects, and a 5 second limit. The origin is the one the rule-set
//     refresh already reaches today, so no host permission is added.
//   * The response body is read as raw bytes (never decoded text, so a byte-order mark or invalid
//     UTF-8 is judged exactly as StillKit judges it) and capped just past the grammar's limit.
//   * A response lives only in memory for the one evaluation that requested it. It is never
//     written to storage, so it cannot be replayed later.
//   * The only things stored, in chrome.storage.local, are, per namespace: the highest policy
//     revision ever accepted (raised with max() only after an accepted verdict) and the ordinary
//     cache's advisory record (revision, on/off, two timestamps). Neither can authorize anything.
//   * Offline, timed out, failed, missing, invalid, late or stale means Off. A cached On never
//     authorizes: `freshCheck` never reads the ordinary cache.

/** The public function path on the project origin. */
export const PRODUCT_POLICY_PATH = "/functions/v1/product-policy";
/** A fresh check that has not answered within this many milliseconds is Off. */
export const PRODUCT_POLICY_TIMEOUT_MS = 5000;

const NAMESPACES: readonly ProductPolicyNamespace[] = Object.freeze(["sales", "rating"]);
const highestSeenKey = (namespace: ProductPolicyNamespace) => `still:productPolicy:${namespace}:highestSeenRevision`;
const ordinaryKey = (namespace: ProductPolicyNamespace) => `still:productPolicy:${namespace}:ordinary`;
/** Every storage key this module may write. Nothing else is ever stored. */
export const PRODUCT_POLICY_STORAGE_KEYS: readonly string[] = Object.freeze(
  NAMESPACES.flatMap(namespace => [highestSeenKey(namespace), ordinaryKey(namespace)]),
);

/** The advisory projection the ordinary cache keeps for UI hints. Never an authorization. */
export interface PolicyAdvisory { readonly on: boolean }

/** The subset of chrome.storage.local this module uses. */
export interface PolicyStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ProductPolicyRuntimeOptions {
  /** The build's configured Supabase project URL (VITE_SUPABASE_URL). Absent or malformed: no
   * request is ever made and every check is Off. Only its origin is used. */
  readonly supabaseUrl: string | undefined;
  readonly environment: ProductPolicyEnvironment;
  readonly surface: ProductPolicySurface;
  /** This packaged build's identifier, as the policy's build allowlist names it. */
  readonly build: string;
  readonly area: PolicyStorageArea;
  readonly fetchImpl?: typeof fetch;
  /** Monotonic milliseconds for request freshness. Defaults to performance.now(). */
  readonly monotonicNow?: () => number;
  /** Wall-clock milliseconds for the ordinary cache's spacing. Defaults to Date.now(). */
  readonly wallNow?: () => number;
}

export interface ProductPolicyRuntime {
  /** One fresh online check, for the moment a purchase would start or a review prompt would be
   * requested. Never throws; anything but a fresh, valid, current, allowlisted On is Off. */
  freshCheck(namespace: ProductPolicyNamespace): Promise<ProductPolicyVerdict>;
  /** Advisory UI-open caches. They never authorize a purchase or a rating. */
  readonly ordinary: Readonly<Record<ProductPolicyNamespace, OrdinaryPolicyCache<PolicyAdvisory>>>;
}

/** The function URL on the configured project's origin, or null when the build has none. */
export function productPolicyEndpoint(supabaseUrl: string | undefined): string | null {
  const trimmed = supabaseUrl?.trim() ?? "";
  if (!trimmed) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  return `${url.origin}${PRODUCT_POLICY_PATH}`;
}

/** Read at most `max + 1` raw bytes. One byte past the grammar's cap is enough for the evaluator to
 * call the body oversized; the rest is never read. No text decoding happens here. */
async function readBoundedBytes(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, max + 1);
  const reader = res.body.getReader();
  const out = new Uint8Array(max + 1);
  let length = 0;
  try {
    while (length <= max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, out.length - length);
      out.set(value.subarray(0, take), length);
      length += take;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return out.slice(0, length);
}

export interface FetchProductPolicyRequest {
  readonly endpoint: string;
  readonly namespace: ProductPolicyNamespace;
  readonly environment: ProductPolicyEnvironment;
  readonly fetchImpl: typeof fetch;
  readonly monotonicNow: () => number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One request to the public read. Never throws: any failure, any status but 200 (404 means no
 * policy, which is Off) and any timeout yield a null body, which the evaluator calls missing. */
export async function fetchProductPolicy(request: FetchProductPolicyRequest): Promise<ProductPolicyResponse> {
  const requestStartedAt = request.monotonicNow();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, request.timeoutMs ?? PRODUCT_POLICY_TIMEOUT_MS);
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  try {
    const res = await request.fetchImpl(request.endpoint, {
      method: "POST",
      // The only header. No Authorization, apikey or client-info header, ever.
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ namespace: request.namespace, environment: request.environment }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "cors",
      signal: controller.signal,
    });
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      return { body: null, requestStartedAt };
    }
    return { body: await readBoundedBytes(res, PRODUCT_POLICY_MAX_BYTES), requestStartedAt };
  } catch {
    return { body: null, requestStartedAt };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
  }
}

const safeRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const safeWall = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Accepted verdicts are those the evaluator fully validated for this environment and revision. */
const accepted = (verdict: ProductPolicyVerdict): verdict is ProductPolicyVerdict & { readonly revision: number } =>
  verdict.revision !== null && (verdict.reason === "on" || verdict.reason === "off" || verdict.reason === "build");
const off = (reason: ProductPolicyVerdict["reason"]): ProductPolicyVerdict => Object.freeze({ allowed: false, reason, revision: null });
/** Verdicts the packaged context alone decides, before any request. */
const PACKAGED_ONLY: ReadonlySet<ProductPolicyVerdict["reason"]> = new Set(["context", "compiled_off", "deferred_surface"]);

export function createProductPolicyRuntime(options: ProductPolicyRuntimeOptions): ProductPolicyRuntime {
  const endpoint = productPolicyEndpoint(options.supabaseUrl);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const monotonicNow = options.monotonicNow ?? (() => Math.floor(performance.now()));
  const wallNow = options.wallNow ?? Date.now;
  const { area } = options;
  // Built once from packaged values; the compiled paid switch comes from the evaluator's module.
  const context: PackagedPolicyContext = packagedPolicyContext(options.environment, options.surface, options.build);
  const evaluate = (namespace: ProductPolicyNamespace, response: ProductPolicyResponse | null, highestSeen: number) =>
    (namespace === "sales" ? evaluateSalesPolicy : evaluateRatingPolicy)(context, response, highestSeen, monotonicNow);

  // One in-process queue for every storage mutation, so max() is never lost to an interleaving.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };

  /** The stored fence. Absent is 0; anything unreadable throws, which every caller treats as Off. */
  async function readHighestSeen(namespace: ProductPolicyNamespace): Promise<number> {
    const value = (await area.get(highestSeenKey(namespace)))?.[highestSeenKey(namespace)];
    if (value === undefined) return 0;
    if (!safeRevision(value)) throw new Error("Unreadable policy revision fence");
    return value;
  }

  /** Persist max(previous, revision). Called only after an accepted verdict. */
  function raiseHighestSeen(namespace: ProductPolicyNamespace, revision: number): Promise<void> {
    return serialize(async () => {
      const previous = await readHighestSeen(namespace);
      if (revision > previous) await area.set({ [highestSeenKey(namespace)]: revision });
    });
  }

  /** Fetch, evaluate and fence one answer. The response never leaves this function. */
  async function check(namespace: ProductPolicyNamespace, signal?: AbortSignal): Promise<ProductPolicyVerdict> {
    try {
      // The packaged context decides some verdicts by itself (with the shipped compiled switch,
      // every sales check). Those never make a request.
      const packaged = evaluate(namespace, null, 0);
      if (PACKAGED_ONLY.has(packaged.reason)) return packaged;
      if (!endpoint) return off("missing");
      const highestSeen = await readHighestSeen(namespace);
      const response = await fetchProductPolicy({
        endpoint, namespace, environment: context.environment, fetchImpl, monotonicNow, signal,
      });
      const verdict = evaluate(namespace, response, highestSeen);
      // Only accepted verdicts move the fence; "stale" and every failure leave it untouched.
      if (!accepted(verdict)) return verdict;
      // An On that cannot be fenced is not an On: a failed write falls to the catch below.
      await raiseHighestSeen(namespace, verdict.revision);
      return verdict;
    } catch {
      return off("context");
    }
  }

  function ordinaryCache(namespace: ProductPolicyNamespace): OrdinaryPolicyCache<PolicyAdvisory> {
    const key = ordinaryKey(namespace);
    return new OrdinaryPolicyCache<PolicyAdvisory>({
      now: wallNow,
      readTrusted: async (): Promise<PolicyCacheRead<PolicyAdvisory>> => {
        let value: unknown;
        try { value = (await area.get(key))?.[key]; } catch { return { status: "unreadable" }; }
        if (value === undefined) return { status: "missing" };
        if (!plainObject(value) || !exactKeys(value, ["schema", "revision", "projection", "lastSuccess", "highWater"]) ||
          value.schema !== 1 || !safeRevision(value.revision) || !safeWall(value.lastSuccess) || !safeWall(value.highWater) ||
          !plainObject(value.projection) || !exactKeys(value.projection, ["on"]) || typeof value.projection.on !== "boolean") {
          return { status: "unreadable" };
        }
        return { status: "loaded", record: {
          schema: 1, revision: value.revision, projection: { on: value.projection.on },
          lastSuccess: value.lastSuccess, highWater: value.highWater,
        } };
      },
      fetchVerified: async signal => {
        const verdict = await check(namespace, signal);
        if (!accepted(verdict)) throw new Error("No accepted product policy");
        return { revision: verdict.revision, projection: { on: verdict.allowed } };
      },
      commit: (record: PolicyCacheRecord<PolicyAdvisory>, fence) => serialize(async () => {
        if (fence.signal.aborted || !fence.isCurrent()) throw new Error("Stale policy commit");
        // Exactly the advisory record: never a response body, header or request detail.
        await area.set({ [key]: {
          schema: 1, revision: record.revision, projection: { on: record.projection.on === true },
          lastSuccess: record.lastSuccess, highWater: record.highWater,
        } });
        return { status: "committed" as const };
      }),
    });
  }

  return Object.freeze({
    freshCheck: (namespace: ProductPolicyNamespace) =>
      NAMESPACES.includes(namespace) ? check(namespace) : Promise.resolve(off("context")),
    ordinary: Object.freeze({ sales: ordinaryCache("sales"), rating: ordinaryCache("rating") }),
  });
}

/** The policy surface for this extension build. Firefox for Android is not a launch surface. */
export function extensionPolicySurface(isFirefox: boolean): ProductPolicySurface {
  return isFirefox ? "firefox_desktop" : "chrome_desktop";
}

/** Background-only wiring over chrome.storage.local. Uncalled until a reviewed change wires it. */
export function createChromeProductPolicyRuntime(options: Omit<ProductPolicyRuntimeOptions, "area">): ProductPolicyRuntime {
  return createProductPolicyRuntime({ ...options, area: chrome.storage.local });
}
