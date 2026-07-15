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
