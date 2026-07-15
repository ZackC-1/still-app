import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAuthPort } from "../auth.js";

// SupabaseAuthPort.signOut (F1): auth-js only removes the LOCAL session after a successful server
// revoke, so a failed/offline global sign-out would leave the session persisted — the extension's
// next background wake would resurrect the signed-out user. The port must fall back to
// scope:"local" so the local session is always cleared.

function clientWith(signOut: ReturnType<typeof vi.fn>) {
  return { auth: { signOut } } as unknown as SupabaseClient;
}

function codeClient(fns: { signInWithOtp?: ReturnType<typeof vi.fn>; verifyOtp?: ReturnType<typeof vi.fn> }) {
  return { auth: fns } as unknown as SupabaseClient;
}

/** GoTrue-shaped error: classification must read `code`, never `status` or `message` (R1). */
function gotrueError(code: string | undefined, status: number) {
  return { code, status, message: "raw backend text that must never reach the UI" };
}

describe("SupabaseAuthPort.signOut (F1 — offline-proof local removal)", () => {
  it("a clean global sign-out needs no local fallback", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    await new SupabaseAuthPort(clientWith(signOut)).signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith(); // the default (global) call only
  });

  it("a failed global sign-out falls back to scope:'local' so the session is still cleared", async () => {
    const signOut = vi
      .fn()
      .mockResolvedValueOnce({ error: new Error("offline") }) // global revoke fails
      .mockResolvedValueOnce({ error: null }); // local removal succeeds
    await new SupabaseAuthPort(clientWith(signOut)).signOut();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenLastCalledWith({ scope: "local" });
  });
});

// The R1/R5/R7 classification matrix. GoTrue reports wrong AND expired tokens as one 403
// `otp_expired` (anti-enumeration), rate limits as 429s with distinct codes, and everything else
// must land on the calm non-attempt kinds — a non-OTP 403 (`otp_disabled`) or a code-absent
// response must NEVER read as "wrong code" (the old status catch-all dead-ended those forever).

describe("SupabaseAuthPort.requestCode classification (R1/R5/R7)", () => {
  it("success → sent", async () => {
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    const out = await new SupabaseAuthPort(codeClient({ signInWithOtp })).requestCode("a@b.c");
    expect(out).toEqual({ kind: "sent" });
    expect(signInWithOtp).toHaveBeenCalledWith({ email: "a@b.c" });
  });

  it("over_email_send_rate_limit → send-rate-limited (cooldown and hourly cap share this code)", async () => {
    const signInWithOtp = vi.fn(async () => ({ error: gotrueError("over_email_send_rate_limit", 429) }));
    const out = await new SupabaseAuthPort(codeClient({ signInWithOtp })).requestCode("a@b.c");
    expect(out.kind).toBe("send-rate-limited");
  });

  it("unknown error code → send-failed (calm retry, never a wait lock)", async () => {
    const signInWithOtp = vi.fn(async () => ({ error: gotrueError("smtp_exploded", 500) }));
    const out = await new SupabaseAuthPort(codeClient({ signInWithOtp })).requestCode("a@b.c");
    expect(out.kind).toBe("send-failed");
  });

  it("a thrown transport error → send-failed, never a rejection at the sheet", async () => {
    const signInWithOtp = vi.fn(async () => {
      throw new Error("network down");
    });
    const out = await new SupabaseAuthPort(codeClient({ signInWithOtp })).requestCode("a@b.c");
    expect(out.kind).toBe("send-failed");
  });
});

describe("SupabaseAuthPort.verifyCode classification (R1/R5/R7)", () => {
  const verify = async (verifyOtp: ReturnType<typeof vi.fn>) =>
    new SupabaseAuthPort(codeClient({ verifyOtp })).verifyCode("a@b.c", "123456");

  it("session returned → verified with the user id", async () => {
    const verifyOtp = vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null }));
    expect(await verify(verifyOtp)).toEqual({ kind: "verified", userId: "u1" });
    expect(verifyOtp).toHaveBeenCalledWith({ email: "a@b.c", token: "123456", type: "email" });
  });

  it("user id falls back to the session payload when data.user is absent", async () => {
    const verifyOtp = vi.fn(async () => ({ data: { session: { user: { id: "u2" } } }, error: null }));
    expect(await verify(verifyOtp)).toEqual({ kind: "verified", userId: "u2" });
  });

  it("otp_expired (wrong OR expired token — one server error by design) → invalid-code", async () => {
    const verifyOtp = vi.fn(async () => ({ data: {}, error: gotrueError("otp_expired", 403) }));
    expect((await verify(verifyOtp)).kind).toBe("invalid-code");
  });

  it("over_request_rate_limit (per-IP verify throttle) → verify-rate-limited, not an attempt kind", async () => {
    const verifyOtp = vi.fn(async () => ({ data: {}, error: gotrueError("over_request_rate_limit", 429) }));
    expect((await verify(verifyOtp)).kind).toBe("verify-rate-limited");
  });

  it("a non-OTP 403 (otp_disabled) → verify-failed — NEVER 'wrong code' (the old catch-all dead end)", async () => {
    const verifyOtp = vi.fn(async () => ({ data: {}, error: gotrueError("otp_disabled", 403) }));
    expect((await verify(verifyOtp)).kind).toBe("verify-failed");
  });

  it("a code-absent 403 → verify-failed (older stacks / stripped bodies must not read as wrong)", async () => {
    const verifyOtp = vi.fn(async () => ({ data: {}, error: gotrueError(undefined, 403) }));
    expect((await verify(verifyOtp)).kind).toBe("verify-failed");
  });

  it("a code-absent 500 → verify-failed", async () => {
    const verifyOtp = vi.fn(async () => ({ data: {}, error: gotrueError(undefined, 500) }));
    expect((await verify(verifyOtp)).kind).toBe("verify-failed");
  });

  it("a thrown transport error → verify-failed", async () => {
    const verifyOtp = vi.fn(async () => {
      throw new Error("network down");
    });
    expect((await verify(verifyOtp)).kind).toBe("verify-failed");
  });

  it("a success payload with no user id anywhere → verify-failed", async () => {
    const verifyOtp = vi.fn(async () => ({ data: {}, error: null }));
    expect((await verify(verifyOtp)).kind).toBe("verify-failed");
  });
});


// The deterministic App Review sign-in branch (plan 2026-07-15-002, R8–R10/AE7–AE9). The port
// routes the ONE configured review address through the review-signin function; everyone else —
// and every address when config is absent — takes the normal GoTrue path. The 404 refusal
// ("not configured") falls through to GoTrue on BOTH actions so client/server config drift
// degrades to ordinary OTP end to end instead of bricking the address.

const REVIEW = { email: "review@example.test" };

function reviewClient(fns: {
  invoke?: ReturnType<typeof vi.fn>;
  signInWithOtp?: ReturnType<typeof vi.fn>;
  verifyOtp?: ReturnType<typeof vi.fn>;
  setSession?: ReturnType<typeof vi.fn>;
}) {
  return {
    auth: {
      signInWithOtp: fns.signInWithOtp ?? vi.fn(async () => ({ error: null })),
      verifyOtp: fns.verifyOtp ?? vi.fn(async () => ({ data: {}, error: null })),
      setSession: fns.setSession ?? vi.fn(async () => ({ data: { user: { id: "u-r" } }, error: null })),
    },
    functions: { invoke: fns.invoke ?? vi.fn(async () => ({ data: { ok: true }, error: null })) },
  } as unknown as SupabaseClient;
}

/** supabase-js FunctionsHttpError shape: the Response rides on `.context`. */
function httpError(status: number, body: Record<string, unknown> = {}) {
  return {
    data: null,
    error: { context: new Response(JSON.stringify(body), { status }) },
  };
}

function reviewPort(fns: Parameters<typeof reviewClient>[0]) {
  return new SupabaseAuthPort(reviewClient(fns), undefined, REVIEW);
}

describe("review sign-in branch — requestCode (AE7/AE9, R9)", () => {
  it("review address + preflight 200 → sent, and no email is ever dispatched", async () => {
    const invoke = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    const out = await reviewPort({ invoke, signInWithOtp }).requestCode("review@example.test");
    expect(out).toEqual({ kind: "sent" });
    expect(invoke).toHaveBeenCalledWith("review-signin", {
      body: { action: "request", email: "review@example.test" },
    });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("mixed-case, padded review address still takes the branch (AE8) and is sent normalized", async () => {
    const invoke = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const out = await reviewPort({ invoke }).requestCode("  Review@Example.TEST ");
    expect(out.kind).toBe("sent");
    expect(invoke.mock.calls[0][1]).toEqual({
      body: { action: "request", email: "review@example.test" },
    });
  });

  it("preflight 429 renders the wait state with the genuine retry-after — never a real email", async () => {
    const invoke = vi.fn(async () => httpError(429, { retry_after: 37 }));
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    const out = await reviewPort({ invoke, signInWithOtp }).requestCode("review@example.test");
    expect(out).toEqual({ kind: "send-rate-limited", retryAfterSeconds: 37 });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("preflight not-configured (404) falls back to the real OTP send exactly once (AE9)", async () => {
    const invoke = vi.fn(async () => httpError(404));
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    const out = await reviewPort({ invoke, signInWithOtp }).requestCode("review@example.test");
    expect(out.kind).toBe("sent");
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("preflight transport failure (no status) also falls back to the real send", async () => {
    const invoke = vi.fn(async () => ({ data: null, error: { name: "FunctionsFetchError" } }));
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    const out = await reviewPort({ invoke, signInWithOtp }).requestCode("review@example.test");
    expect(out.kind).toBe("sent");
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("a non-review address with config present never touches the function", async () => {
    const invoke = vi.fn();
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    await reviewPort({ invoke, signInWithOtp }).requestCode("someone@else.test");
    expect(invoke).not.toHaveBeenCalled();
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("no review config → even the review address takes the normal path (fail closed)", async () => {
    const invoke = vi.fn();
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    const port = new SupabaseAuthPort(
      reviewClient({ invoke, signInWithOtp }),
      undefined,
      undefined,
    );
    await port.requestCode("review@example.test");
    expect(invoke).not.toHaveBeenCalled();
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });
});

describe("review sign-in branch — verifyCode (AE7/AE9, R8/R9)", () => {
  it("200 mints a normal session: setSession gets BOTH tokens, outcome carries the server user id", async () => {
    const invoke = vi.fn(async () => ({
      data: { access_token: "at", refresh_token: "rt", user_id: "u-review" },
      error: null,
    }));
    const setSession = vi.fn(async () => ({ data: { user: { id: "u-review" } }, error: null }));
    const out = await reviewPort({ invoke, setSession }).verifyCode(
      "review@example.test",
      "654321",
    );
    expect(out).toEqual({ kind: "verified", userId: "u-review" });
    expect(setSession).toHaveBeenCalledWith({ access_token: "at", refresh_token: "rt" });
  });

  it("401 (wrong fixed code) → invalid-code; GoTrue verify is never consulted", async () => {
    const invoke = vi.fn(async () => httpError(401));
    const verifyOtp = vi.fn();
    const out = await reviewPort({ invoke, verifyOtp }).verifyCode("review@example.test", "000000");
    expect(out.kind).toBe("invalid-code");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("429 → verify-rate-limited carrying the genuine retry-after", async () => {
    const invoke = vi.fn(async () => httpError(429, { retry_after: 55 }));
    const out = await reviewPort({ invoke }).verifyCode("review@example.test", "654321");
    expect(out).toEqual({ kind: "verify-rate-limited", retryAfterSeconds: 55 });
  });

  it("not-configured (404) falls through to normal GoTrue verify — full drift recovery (AE9)", async () => {
    const invoke = vi.fn(async () => httpError(404));
    const verifyOtp = vi.fn(async () => ({ data: { user: { id: "u-fallback" } }, error: null }));
    const out = await reviewPort({ invoke, verifyOtp }).verifyCode("review@example.test", "111222");
    expect(out).toEqual({ kind: "verified", userId: "u-fallback" });
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "review@example.test",
      token: "111222",
      type: "email",
    });
  });

  it("5xx → verify-failed (calm retry), NOT a fall-through to GoTrue", async () => {
    const invoke = vi.fn(async () => httpError(500, { error: "internal" }));
    const verifyOtp = vi.fn();
    const out = await reviewPort({ invoke, verifyOtp }).verifyCode("review@example.test", "654321");
    expect(out.kind).toBe("verify-failed");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("transport failure (no status) falls through to the normal verify while config is present", async () => {
    const invoke = vi.fn(async () => ({ data: null, error: { name: "FunctionsFetchError" } }));
    const verifyOtp = vi.fn(async () => ({ data: { user: { id: "u-net" } }, error: null }));
    const out = await reviewPort({ invoke, verifyOtp }).verifyCode("review@example.test", "111222");
    expect(out).toEqual({ kind: "verified", userId: "u-net" });
  });

  it("a 200 missing tokens → verify-failed, never a half-minted session", async () => {
    const invoke = vi.fn(async () => ({ data: { user_id: "u-review" }, error: null }));
    const setSession = vi.fn();
    const out = await reviewPort({ invoke, setSession }).verifyCode("review@example.test", "654321");
    expect(out.kind).toBe("verify-failed");
    expect(setSession).not.toHaveBeenCalled();
  });

  it("the unwired magic-link path is deliberately NOT review-aware (it would send a real email)", async () => {
    const invoke = vi.fn();
    const signInWithOtp = vi.fn(async () => ({ error: null }));
    await reviewPort({ invoke, signInWithOtp }).signInWithMagicLink("review@example.test");
    expect(invoke).not.toHaveBeenCalled();
    expect(signInWithOtp).toHaveBeenCalledTimes(1); // pinned: wiring this host-side at the review address is forbidden
  });
});
