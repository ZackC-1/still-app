import { assert, assertEquals } from "@std/assert";
import type { RateLimiter } from "../_shared/rate-limit.ts";
import {
  handleReviewSignin,
  LIMITER_FAILURE_RETRY_SECONDS,
  type ReviewAdmin,
  type ReviewSession,
  type ReviewSigninDeps,
  type ReviewUser,
} from "./handler.ts";

// DI-fake coverage for the deterministic App Review sign-in (plan 2026-07-15-002, U3). Every
// value here is deliberately fake: review@example.test / 123456 exist nowhere outside these tests.

const REVIEW_EMAIL = "review@example.test";
const REVIEW_CODE = "123456";
const CONFIG = { reviewEmail: REVIEW_EMAIL, reviewCode: REVIEW_CODE };
const UNSET_CONFIG = { reviewEmail: "", reviewCode: "" };
const USER_ID = "33333333-3333-3333-3333-333333333333";
const SESSION: ReviewSession = {
  access_token: "fake-access-token",
  refresh_token: "fake-refresh-token",
  user_id: USER_ID,
};
const CONFIRMED: ReviewUser = { id: USER_ID, emailConfirmed: true };
const UNCONFIRMED: ReviewUser = { id: USER_ID, emailConfirmed: false };

const allowAll: RateLimiter = { consume: () => Promise.resolve(0) };

/** findQueue yields one result per findUserByEmail call; createResult null = "already registered". */
function makeAdmin(findQueue: Array<ReviewUser | null>, createResult: ReviewUser | null = null) {
  const seq: string[] = [];
  const emailsSeen: string[] = [];
  const admin: ReviewAdmin = {
    findUserByEmail(email) {
      seq.push("find");
      emailsSeen.push(email);
      return Promise.resolve(findQueue.shift() ?? null);
    },
    createConfirmedUser(email) {
      seq.push("create");
      emailsSeen.push(email);
      return Promise.resolve(createResult);
    },
    confirmEmail(_userId) {
      seq.push("confirm");
      return Promise.resolve();
    },
    generateMagicLinkTokenHash(email) {
      seq.push("generate");
      emailsSeen.push(email);
      return Promise.resolve("fake-token-hash");
    },
    verifyMagicLinkTokenHash(_tokenHash) {
      seq.push("verify");
      return Promise.resolve(SESSION);
    },
  };
  return { admin, seq, emailsSeen };
}

function recordingLimiter(waits: Record<string, number> = {}) {
  const seen: string[] = [];
  const limiter: RateLimiter = {
    consume(key) {
      seen.push(key);
      return Promise.resolve(waits[key] ?? 0);
    },
  };
  return { limiter, seen };
}

function deps(
  admin: ReviewAdmin,
  limiter: RateLimiter = allowAll,
  config = CONFIG,
): ReviewSigninDeps {
  return { config, limiter, admin };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://x/review-signin", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("verify with the review email and correct code mints a session (existing user)", async () => {
  const { admin, seq } = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    access_token: "fake-access-token",
    refresh_token: "fake-refresh-token",
    user_id: USER_ID,
  });
  // Existing confirmed user: no create, no confirm heal — straight to the magic-link mint.
  assertEquals(seq, ["find", "generate", "verify"]);
});

Deno.test("verify auto-creates the user only when the lookup misses (create wins the race)", async () => {
  const { admin, seq } = makeAdmin([null], CONFIRMED);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin),
  );
  assertEquals(res.status, 200);
  assertEquals(seq, ["find", "create", "generate", "verify"]);
});

Deno.test("createUser already-registered race: the re-lookup adopts the winner's row", async () => {
  const { admin, seq } = makeAdmin([null, CONFIRMED], null);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin),
  );
  assertEquals(res.status, 200);
  assertEquals(seq, ["find", "create", "find", "generate", "verify"]);
});

Deno.test("user still absent after already-registered create → 500 without internals", async () => {
  const { admin } = makeAdmin([null, null], null);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin),
  );
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "internal" });
});

Deno.test("existing unconfirmed user is healed (email_confirm) before the magic-link mint", async () => {
  const { admin, seq } = makeAdmin([UNCONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin),
  );
  assertEquals(res.status, 200);
  assertEquals(seq, ["find", "confirm", "generate", "verify"]);
});

Deno.test("mixed-case, padded email input matches after normalization in both actions", async () => {
  const messy = "  ReVIEW@Example.TEST ";
  // request: 200 and the limiter bucket is keyed by the NORMALIZED email.
  const { limiter, seen } = recordingLimiter();
  const requestRes = await handleReviewSignin(
    post({ action: "request", email: messy }),
    deps(makeAdmin([CONFIRMED]).admin, limiter),
  );
  assertEquals(requestRes.status, 200);
  assertEquals(seen, ["review-signin:request:user:review@example.test"]);
  // verify: every admin call receives the normalized email (find, create, generate).
  const { admin, emailsSeen } = makeAdmin([null], CONFIRMED);
  const verifyRes = await handleReviewSignin(
    post({ action: "verify", email: messy, code: REVIEW_CODE }),
    deps(admin),
  );
  assertEquals(verifyRes.status, 200);
  assertEquals(emailsSeen, [REVIEW_EMAIL, REVIEW_EMAIL, REVIEW_EMAIL]);
  // the CONFIGURED value is normalized too.
  const paddedConfig = { reviewEmail: " Review@EXAMPLE.test ", reviewCode: REVIEW_CODE };
  const cfgRes = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(makeAdmin([CONFIRMED]).admin, allowAll, paddedConfig),
  );
  assertEquals(cfgRes.status, 200);
});

Deno.test("wrong or missing code → 401 with no admin calls", async () => {
  const wrong = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: "654321" }),
    deps(wrong.admin),
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "invalid_code");
  assertEquals(wrong.seq, []);
  // A missing code is a wrong (empty) code, not a parse error.
  const missing = makeAdmin([CONFIRMED]);
  const res2 = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL }),
    deps(missing.admin),
  );
  assertEquals(res2.status, 401);
  assertEquals(missing.seq, []);
});

Deno.test("non-review email refusal is indistinguishable from the unset-config refusal", async () => {
  const mismatch = { admin: makeAdmin([CONFIRMED]), limiter: recordingLimiter() };
  const unset = { admin: makeAdmin([CONFIRMED]), limiter: recordingLimiter() };
  const a = await handleReviewSignin(
    post({ action: "verify", email: "someone-else@example.test", code: REVIEW_CODE }),
    deps(mismatch.admin.admin, mismatch.limiter.limiter),
  );
  const b = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(unset.admin.admin, unset.limiter.limiter, UNSET_CONFIG),
  );
  // Identical status AND body — the shape is the client's fall-back routing contract (U4).
  assertEquals(a.status, 404);
  assertEquals(b.status, a.status);
  assertEquals(await b.json(), await a.json());
  // Neither refusal touches admin or consumes a rate-limit slot (no configuration oracle).
  assertEquals(mismatch.admin.seq, []);
  assertEquals(unset.admin.seq, []);
  assertEquals(mismatch.limiter.seen, []);
  assertEquals(unset.limiter.seen, []);
  // ...and both are distinguishable from the wrong-code 401.
  const c = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: "000000" }),
    deps(makeAdmin([CONFIRMED]).admin),
  );
  assert(c.status !== a.status);
  assertEquals(c.status, 401);
});

Deno.test("unset secrets refuse every input for both actions (fail closed)", async () => {
  const configs = [
    UNSET_CONFIG,
    { reviewEmail: REVIEW_EMAIL, reviewCode: "" },
    { reviewEmail: "", reviewCode: REVIEW_CODE },
  ];
  for (const config of configs) {
    for (const action of ["request", "verify"] as const) {
      const { admin, seq } = makeAdmin([CONFIRMED]);
      const res = await handleReviewSignin(
        post({ action, email: REVIEW_EMAIL, code: REVIEW_CODE }),
        deps(admin, allowAll, config),
      );
      assertEquals(res.status, 404);
      assertEquals(seq, []);
    }
  }
});

Deno.test("request preflight on the review email → 200 ok, no admin calls, email window only", async () => {
  const { limiter, seen } = recordingLimiter();
  const { admin, seq } = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "request", email: REVIEW_EMAIL }, { "cf-connecting-ip": "203.0.113.9" }),
    deps(admin, limiter),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  // The preflight never touches GoTrue — nothing here can send an email.
  assertEquals(seq, []);
  // request consumes ONLY the per-email window (plan U3 policy — no IP bucket).
  assertEquals(seen, ["review-signin:request:user:review@example.test"]);
});

Deno.test("request with a non-review email → the same 404 refusal, no side effects", async () => {
  const { limiter, seen } = recordingLimiter();
  const { admin, seq } = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "request", email: "other@example.test" }),
    deps(admin, limiter),
  );
  assertEquals(res.status, 404);
  assertEquals(seq, []);
  assertEquals(seen, []);
});

Deno.test("request over the per-email window → 429 carrying the RPC's wait", async () => {
  const { limiter } = recordingLimiter({ "review-signin:request:user:review@example.test": 45 });
  const res = await handleReviewSignin(
    post({ action: "request", email: REVIEW_EMAIL }),
    deps(makeAdmin([CONFIRMED]).admin, limiter),
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "45");
  assertEquals((await res.json()).retry_after, 45);
});

Deno.test("verify over the per-email window → 429 with retry-after, no admin calls", async () => {
  const { limiter } = recordingLimiter({ "review-signin:verify:user:review@example.test": 33 });
  const { admin, seq } = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin, limiter),
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "33");
  assertEquals((await res.json()).retry_after, 33);
  assertEquals(seq, []);
});

Deno.test("verify consumes the email bucket then the per-IP bucket keyed by the Cloudflare IP", async () => {
  const { limiter, seen } = recordingLimiter({ "review-signin:verify:ip:203.0.113.9": 12 });
  const { admin, seq } = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }, {
      // A spoofed first x-forwarded-for hop must lose to cf-connecting-ip.
      "x-forwarded-for": "1.1.1.1, 203.0.113.9",
      "cf-connecting-ip": "203.0.113.9",
    }),
    deps(admin, limiter),
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "12");
  assertEquals(seen, [
    "review-signin:verify:user:review@example.test",
    "review-signin:verify:ip:203.0.113.9",
  ]);
  assertEquals(seq, []);
});

Deno.test("rate-limiter RPC failure fails closed as 429 for both actions", async () => {
  const throwing: RateLimiter = { consume: () => Promise.reject(new Error("rpc down")) };
  for (const action of ["request", "verify"] as const) {
    const { admin, seq } = makeAdmin([CONFIRMED]);
    const res = await handleReviewSignin(
      post({ action, email: REVIEW_EMAIL, code: REVIEW_CODE }),
      deps(admin, throwing),
    );
    assertEquals(res.status, 429);
    assertEquals(res.headers.get("retry-after"), String(LIMITER_FAILURE_RETRY_SECONDS));
    assertEquals(seq, []);
  }
});

Deno.test("an admin-chain failure → 500 {error} without internal detail", async () => {
  const base = makeAdmin([CONFIRMED]).admin;
  const admin: ReviewAdmin = {
    ...base,
    generateMagicLinkTokenHash: () => Promise.reject(new Error("gotrue exploded: internal detail")),
  };
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin),
  );
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "internal" });
});

Deno.test("OPTIONS preflight → 204 with CORS headers before any gate (even unconfigured)", async () => {
  const { admin, seq } = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    new Request("http://x/review-signin", { method: "OPTIONS" }),
    deps(admin, allowAll, UNSET_CONFIG),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert((res.headers.get("access-control-allow-methods") ?? "").includes("OPTIONS"));
  assertEquals(seq, []);
});

Deno.test("GET → 405", async () => {
  const res = await handleReviewSignin(
    new Request("http://x/review-signin", { method: "GET" }),
    deps(makeAdmin([CONFIRMED]).admin),
  );
  assertEquals(res.status, 405);
});

Deno.test("sign-in logs contain only timestamps, outcomes and fixed failure categories", async (t) => {
  const ipv4 = "203.0.113.9";
  const ipv6 = "2001:db8::7";
  const forwarded = "198.51.100.42";
  const otherEmail = "other@example.test";
  const wrongCode = "654321";
  const sensitive = [
    ipv4, ipv6, forwarded, REVIEW_EMAIL, otherEmail, REVIEW_CODE, wrongCode,
    SESSION.access_token, SESSION.refresh_token, USER_ID, "fake-token-hash",
  ];
  // Provider errors can expose details through the message, cause, stack or extra fields.
  const providerError = Object.assign(new Error(sensitive.join(" "), {
    cause: { headers: { authorization: SESSION.access_token }, email: REVIEW_EMAIL },
  }), { token: SESSION.refresh_token });
  const throwing: RateLimiter = { consume: () => Promise.reject(providerError) };
  const headers: Record<string, string>[] = [
    { "cf-connecting-ip": ipv4, "x-real-ip": ipv6, "x-forwarded-for": forwarded },
    { "x-real-ip": ipv6, "x-forwarded-for": forwarded },
    { "x-forwarded-for": `${forwarded}, ${ipv6}` },
  ];

  for (const [index, requestHeaders] of headers.entries()) {
    const cases = [
      { name: "success", status: 200, outcome: "verified", body: SESSION },
      { name: "wrong code", status: 401, outcome: "invalid_code", code: wrongCode, body: { error: "invalid_code" } },
      { name: "email mismatch", status: 404, outcome: "refused", email: otherEmail, body: { error: "not_found" } },
      { name: "unconfigured", status: 404, outcome: "refused", config: UNSET_CONFIG, body: { error: "not_found" } },
      {
        name: "rate limited", status: 429, outcome: "rate_limited",
        limiter: recordingLimiter({ "review-signin:verify:user:review@example.test": 33 }).limiter,
        body: { error: "rate_limited", retry_after: 33 },
      },
      {
        name: "mint failure", status: 500, outcome: "mint_failed",
        admin: { ...makeAdmin([CONFIRMED]).admin, generateMagicLinkTokenHash: () => Promise.reject(providerError) },
        error: "review-signin session mint failed", body: { error: "internal" },
      },
      {
        name: "verify limiter failure", status: 429, outcome: "rate_limited", limiter: throwing,
        error: "review-signin rate limiter failed (failing closed)",
        body: { error: "rate_limited", retry_after: LIMITER_FAILURE_RETRY_SECONDS },
      },
      {
        name: "request limiter failure", action: "request", status: 429, limiter: throwing,
        error: "review-signin rate limiter failed (failing closed)",
        body: { error: "rate_limited", retry_after: LIMITER_FAILURE_RETRY_SECONDS },
      },
    ];
    for (const scenario of cases) {
      await t.step(`${scenario.name}, IP header variant ${index + 1}`, async () => {
        const info: unknown[][] = [];
        const errors: unknown[][] = [];
        const originalInfo = console.info;
        const originalError = console.error;
        console.info = (...args: unknown[]) => void info.push(args);
        console.error = (...args: unknown[]) => void errors.push(args);
        try {
          const response = await handleReviewSignin(
            post({
              action: scenario.action ?? "verify",
              email: scenario.email ?? REVIEW_EMAIL,
              code: scenario.code ?? REVIEW_CODE,
            }, requestHeaders),
            deps(scenario.admin ?? makeAdmin([CONFIRMED]).admin, scenario.limiter ?? allowAll, scenario.config ?? CONFIG),
          );
          assertEquals(response.status, scenario.status);
          assertEquals(await response.json(), scenario.body);
          if (scenario.status === 429) {
            assert("retry_after" in scenario.body);
            assertEquals(response.headers.get("retry-after"), String(scenario.body.retry_after));
          }
        } finally {
          console.info = originalInfo;
          console.error = originalError;
        }
        assertEquals(errors, scenario.error ? [[scenario.error]] : []);
        assertEquals(info.length, scenario.outcome ? 1 : 0);
        if (scenario.outcome) {
          assertEquals(info[0].length, 1);
          const line = info[0][0];
          assert(typeof line === "string");
          const match = /^review-signin verify at=(\S+) outcome=(\w+)$/.exec(line);
          assert(match, "audit fields must be limited to timestamp and outcome");
          assertEquals(new Date(match[1]).toISOString(), match[1]);
          assertEquals(match[2], scenario.outcome);
        }
        const logged = JSON.stringify([info, errors]);
        for (const sentinel of sensitive) assert(!logged.includes(sentinel), `logged sensitive sentinel: ${sentinel}`);
      });
    }
  }
});

Deno.test("a correct code is accepted even after the per-email verify bucket is exhausted (reviewer never locked out)", async () => {
  // Design invariant (adversarial finding): the anti-brute-force cap meters attempts, but a
  // fat-fingering reviewer whose eventual entry is CORRECT must still get in. With maxPerUser=10
  // the bucket only bites after 10 attempts in the window; a correct entry within that headroom
  // mints normally. (The bucket exhaustion path itself is the "verify over the window → 429" test.)
  const { limiter } = recordingLimiter(); // allow-through: within the 10-attempt window
  const { admin, seq } = makeAdmin([CONFIRMED]);
  const res = await handleReviewSignin(
    post({ action: "verify", email: REVIEW_EMAIL, code: REVIEW_CODE }),
    deps(admin, limiter),
  );
  assertEquals(res.status, 200);
  assertEquals(seq, ["find", "generate", "verify"]);
});

Deno.test("malformed JSON, unknown action, and non-string fields → 400", async () => {
  const d = deps(makeAdmin([CONFIRMED]).admin);
  assertEquals((await handleReviewSignin(post("{not json"), d)).status, 400);
  assertEquals((await handleReviewSignin(post({ action: "reset", email: REVIEW_EMAIL }), d)).status, 400);
  assertEquals((await handleReviewSignin(post({ action: "verify", email: 42, code: REVIEW_CODE }), d)).status, 400);
  assertEquals(
    (await handleReviewSignin(post({ action: "verify", email: REVIEW_EMAIL, code: 123456 }), d)).status,
    400,
  );
});
