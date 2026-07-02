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
