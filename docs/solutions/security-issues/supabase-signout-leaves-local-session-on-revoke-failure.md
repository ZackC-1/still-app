---
title: Supabase signOut() leaves the local session persisted when the server revoke fails
category: security-issues
problem_type: security_issue
track: bug
module: packages/core
component: authentication
symptoms:
  - A user who taps Sign out stays effectively signed in after a network blip
  - The persisted Supabase session survives an explicit sign-out on disk
  - A background wake resurrects the signed-out user and the next reconcile re-grants Pro
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [supabase, auth-js, sign-out, session, mv3-extension, teardown, entitlement]
date: 2026-07-02
status: active
---

# Supabase signOut() leaves the local session persisted when the server revoke fails

## Problem

The extension purchase spine (PR #34) assumed `supabase.auth.signOut()` always clears the local session. It does not: when the server-side revoke fails on a network error or 5xx, `auth-js` returns the error **before** removing the local session. So an explicit sign-out could leave a live session persisted in `chrome.storage.local`, and the next background wake would resurrect the signed-out user — with the following reconcile re-writing `entitled: true` after they had signed out. On a shared machine that means the next person inherits the prior account and its Pro entitlement.

## Symptoms

- Tapping "Sign out" while offline (or during a Supabase 5xx) leaves the user effectively signed in.
- The persisted session record under the auth storage key is still present after sign-out.
- A later worker wake (`resume()`) reads a valid `getSession()` and a subsequent reconcile re-grants entitlement.

## What Didn't Work

- **Trusting `signOut()`'s return as "session cleared."** `SupabaseAuthPort.signOut` originally did `await this.client.auth.signOut()` and discarded the result — which is exactly the failure: auth-js only reaches `_removeSession()` after a successful `admin.signOut()` (or a 401/403/404, which it treats as already-gone). On any other error it early-returns with the error and the local session stays.
- **Assuming `scope: 'local'` alone fixes offline.** `signOut({ scope: 'local' })` still issues a network revoke for the current session, so it can fail the same way when truly offline. It helps when the server is merely 5xx-ing, but it is not an offline guarantee on its own.

## Solution

Two layers — never depend on the SDK to have cleared local state:

1. **Fall back to `scope: 'local'` in the shared auth port** so a failed global revoke still drops the local session when the server is reachable-but-erroring:

```ts
// packages/core/src/sync/auth.ts
async signOut(): Promise<void> {
  const { error } = await this.client.auth.signOut();
  if (error) await this.client.auth.signOut({ scope: "local" });
}
```

2. **Clear the persisted session storage directly in the teardown** — the offline-proof guarantee. In the extension this is an injected `clearAuthStorage` closure the background wires to a `chrome.storage.local.remove`, called from the one shared teardown helper (alongside the entitlement `entitled:false` write, pending-flag clears, and identity reset):

```ts
// packages/ext-chromium/lib/auth-storage.ts
export async function clearExtensionAuthStorage(): Promise<void> {
  try {
    await browser.storage.local.remove([AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`]);
  } catch { /* best-effort */ }
}
```

Because the MV3 worker dies and is recreated with a fresh client that reads empty storage, removing the persisted record makes `currentUserId()` return `null` on the next wake — so `resume()` no-ops and no reconcile re-grants Pro.

A companion guard closes the in-session race (a reconcile already in flight when teardown runs): the reconcile captures a teardown-generation counter and the current user id *before* its network await and skips the entitlement write if either changed — so a stale `entitled: true` can't land after the purge wrote `entitled: false`.

## Why This Works

The mistaken mental model was "`signOut()` resolved, therefore the session is gone." The library's actual contract is "the session is gone only if the server revoke succeeded (or returned 401/403/404)." Clearing the persisted storage ourselves makes local removal independent of the network entirely, and the `scope: 'local'` fallback covers the reachable-but-erroring case cheaply. Only voluntary sign-out/delete does this; an *involuntary* 401 mid-session is mapped to a re-sign-in prompt and deliberately does **not** clear the entitlement cache (it rides its TTL), so an auth hiccup never downgrades a paid user.

## Prevention

- **Treat any auth SDK's `signOut()` as best-effort for local state.** After it, clear the persisted session storage yourself if a signed-out user must be truly signed out (shared machines, kiosk, extensions).
- **Verify library teardown behavior at the source, not the docs.** The auth-js `_signOut` early-return on non-401/403/404 errors is the load-bearing detail; a one-minute read of the installed version's source confirmed it.
- **Test the failure path.** Pin it: a `signOut` whose revoke rejects still clears the local session.

```ts
it("a failed global sign-out falls back to scope:'local'", async () => {
  const signOut = vi.fn()
    .mockResolvedValueOnce({ error: new Error("offline") })
    .mockResolvedValueOnce({ error: null });
  await new SupabaseAuthPort(clientWith(signOut)).signOut();
  expect(signOut).toHaveBeenLastCalledWith({ scope: "local" });
});
```

- Route sign-out, delete-account, and identity-switch through the one teardown helper so this clear can't be forgotten on a sibling path (see Related).

## Related Issues

- `docs/solutions/conventions/mirror-fixes-across-parallel-paths.md` — the teardown parity convention this reinforces: the persisted-session clear lives in the single shared helper so all voluntary-teardown paths get it.
- `docs/solutions/security-issues/gate-production-trust-by-build-mode.md` — sibling auth/trust-boundary learning for the same extension spine.
- Found by the 10-persona `/ce-code-review` on PR #34 (correctness + security personas, cross-reviewer agreement); fixed in commit `f2cb9be`.
