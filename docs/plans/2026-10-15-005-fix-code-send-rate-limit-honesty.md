---
title: Honest sign-in code send limits (ISS-0060) and the code re-request wait (ISS-0059)
status: in_progress
date: 2026-10-15
---

# Honest sign-in code send limits and the code re-request wait

## Problem

- **ISS-0060 (major).** On the iPhone app, QA A saw the generic "Couldn't send the code. Try again."
  about two minutes after the same account requested a code and signed in on Chrome. A later attempt
  worked. When the sign-in provider refuses a send because of a limit, Still must say so and show the
  wait, not report a generic failure.
- **ISS-0059 (minor change request).** The owner wants the wait before requesting another code to drop
  from 60 s to about 30 s, with the remaining time visible, and the client wait must match the server.

## Where the code request runs (traced)

Every surface uses one shared client: `SupabaseAuthPort.requestCode` / `verifyCode`
(`packages/core/src/sync/auth.ts`), driven by `UiController.sendCode` / `resendCode` and rendered by
`SignInSheet.svelte` with copy from `STRINGS.codeAuth`.

- Chrome, Firefox desktop and Firefox Android: the extension background holds the port
  (`ext-chromium/entrypoints/background.ts` -> `extension-session.ts`), the popup reaches it through the
  session message router. Background requests run with host permission, so CORS does not apply.
- iPhone app and Mac app: `packages/app-webview/src/main.ts` constructs the same port inside a
  WKWebView loaded with `loadFileURL` (origin `null`), so every Auth response is a cross-origin read.
- Safari extension popups have no sign-in path (device-only copy). There is no native Swift email-code
  path; `SignInWithApple.swift` is not used for email codes.

## Root cause

1. **Classification depends on a field the WebView may not be able to read.** `requestCode` maps a
   refusal to the honest wait only when `error.code === "over_email_send_rate_limit"`. supabase-js only
   reads `code` from the 2024-01-01 body shape when it can read the `X-Supabase-Api-Version` response
   header; otherwise it looks for the legacy `error_code` field, which that body shape does not carry
   (GoTrue `HTTPErrorResponse20240101` is `{code, message}`). Any cross-origin response whose version
   header is not exposed through the hosted gateway therefore arrives as a 429 with `code` undefined and
   falls to `send-failed`, the generic line. The HTTP status (429) is always readable. GoTrue itself lists
   the header as CORS-exposed; whether the hosted gateway passes that through to a `null` origin is not
   verified (probing the hosted project was out of bounds), so this is a confirmed mechanism and a likely,
   not proven, contributor.
2. **Other provider limits on the same endpoint were never mapped.** The per-IP sign-in limit on the
   code endpoint answers 429 `over_request_rate_limit`; the send path mapped only the email-send code, so
   that limit also rendered the generic line. Chrome and the iPhone on one home network share a
   public address.
3. **The real wait was thrown away.** GoTrue states the per-email wait only in its message
   ("For security purposes, you can only request this after N seconds."). The client ignored it and
   always locked for a fixed 60 s, so the countdown could not match the server.

Which limit fired at 12:45 is not proven: the hosted Auth logs and limit values are not readable through
any documented read-only route (the read-only QA route reads database views only). Two minutes after the
Chrome request is outside a 60 s per-email interval, so the hourly email cap or the per-IP limit is more
likely than the per-email interval, and a genuine provider failure is also possible. The fix is correct
for all of these: every 429 gets the honest wait, every other failure keeps the generic line.

## Where the 60 s comes from (ISS-0059)

- The visible "Send a new code in 42s" countdown is the client constant `RESEND_COOLDOWN_MS = 60_000`
  (`controller.svelte.ts`), started when a send succeeds.
- It mirrors the hosted per-email minimum interval (`smtp_max_frequency`). The deploy reference
  (`docs/release/extension-purchase-deploy-checklist.md` section 1) records the expected hosted value as a
  60-second resend cooldown, which is also the Supabase hosted default. Local `supabase/config.toml`
  `max_frequency = "1s"` is the local development stack only.
- The hosted value cannot be read through a documented read-only route. It is an owner check.

Decision: the client stays at 60 s in this change. Shortening only the client would make every resend
between 30 s and 60 s a provider refusal (ISS-0060 again). After this change, such a refusal would at
least render the honest wait with the server's own remaining seconds, so a client/server mismatch can no
longer surface as a generic error.

### Owner gate: proposed hosted change (not applied)

The QA sandbox runs on the existing hosted backend (`docs/release/shared-hosted-sandbox-qa.md`), so there
is one Auth configuration shared with production users. A QA-only interval is not possible.

1. Owner reads, in the Supabase dashboard for the hosted project (Authentication, rate limits and email
   settings): the per-email minimum interval (`smtp_max_frequency`), the hourly email-sent limit
   (`rate_limit_email_sent`) and the sign-in/OTP per-IP limit (`rate_limit_otp`). Also the Auth logs for
   15 Oct around 12:43-12:46 local for `/otp` responses (status and error code only).
2. If the owner approves: change `smtp_max_frequency` from 60 s to 30 s on that project.
3. In the same release, change the one client constant `RESEND_COOLDOWN_MS` from `60_000` to `30_000`
   and update the deploy reference. Until both are changed, keep 60 s.

## Approach

1. `auth.ts` `requestCode`: classify **any** HTTP 429, or either limit code
   (`over_email_send_rate_limit`, `over_request_rate_limit`), as `send-rate-limited`. Everything else
   stays `send-failed`.
2. `auth.ts` `verifyCode`: same rule for the verify throttle (`verify-rate-limited`), so a code-absent
   429 never reads as a calm "try again" that invites hammering.
3. Parse the provider's stated wait from the message, only for a 429, with one strict pattern
   (`after N second(s)`), add one second (GoTrue truncates the remaining time), and clamp to the existing
   600 s ceiling through one shared clamp. No match leaves `retryAfterSeconds` absent, so the controller
   keeps its 60 s lock. Classification never depends on message text; only the number does.
4. Root fix for the lost code (review finding): `preserveAuthErrorCodes`, a `fetch` wrapper the Apple
   WebView's Supabase client uses. On a non-2xx `/auth/v1/` JSON body with a string `code` and no
   `error_code`, it mirrors `code` into `error_code`, which supabase-js reads when the version header is
   not visible. This also keeps a wrong code reading as "That code didn't work" instead of "We couldn't
   sign you in" if the header is hidden. Inert when the header is readable; every other response passes
   through untouched.
5. No copy change. The existing lines already read the same on every surface (one shared sheet):
   email view "We can't send a code right now. Try again in 29s"; code view "Too many codes requested.
   The code already in your email still works." with "Send a new code in 29s" on the button.
6. Update the doc comments that said message text is never parsed.

### Review decisions

- Not done: moving a first send refused by the per-email interval straight to code entry. In the
  cross-device case the earlier code may already have been used by the other device, so offering it
  could be false. The email view keeps the honest "can't send right now, try again in Ns" line. This is
  a possible owner design follow-up, not a defect fix.
- Not done: the owner-admin page's own sign-in (an owner-only tool, not a product surface) still
  reports any send failure generically.

## Tests (written first, must fail on current code)

- `auth.test.ts`: frequency 429 with the GoTrue message -> `send-rate-limited`, `retryAfterSeconds`
  = N + 1; code-absent 429 (WebView shape) -> `send-rate-limited`; `over_request_rate_limit` 429 ->
  `send-rate-limited`; hourly-cap message -> `send-rate-limited` with no seconds; absurd seconds clamped;
  500, 400 and thrown errors stay `send-failed`; code-absent 429 on verify -> `verify-rate-limited`.
- `auth-error-codes.test.ts`: with the real supabase-js client and a response with no readable version
  header, the code is lost (mechanism); through `preserveAuthErrorCodes` the send maps to the wait with
  seconds and a wrong code maps to `invalid-code`; genuine failures stay generic; other routes,
  successes, non-JSON and legacy bodies pass through untouched.
- `controller.test.ts`: a send refused with `retryAfterSeconds` shows that countdown and re-enables at
  exactly that time (countdown matches the server), for both first send and resend. This one guards
  existing controller behavior and passed before the change.

Failing first: 5 `auth.test.ts` cases failed on `origin/main` (`send-failed`/missing seconds instead of
the wait); the `preserveAuthErrorCodes` cases failed with the helper absent; the mechanism case passed,
reproducing the lost code.

## Retest (owner)

IOS-38, CH-38, MAC-39, FX-39, AND-37/38; back-to-back requests for one account on two surfaces within a
minute (expect the wait line with seconds, never the generic line), and several within an hour. IOS-39
and CH sign-in: request, wait about 30 s, request again: with the hosted interval still at 60 s the
button shows the remaining seconds; only after the owner gate both read 30 s.

## Risks

- A 429 from something other than a send limit would now show a wait instead of "try again". On this
  endpoint every 429 is a limit, and the wait self-clears.
- Message wording could change upstream; then no seconds are parsed and the fixed 60 s lock applies.

## Verification (15 Oct, branch fix/iss0060-code-send-honesty-20261015)

- `pnpm lint`, `pnpm typecheck`, `pnpm test:release`, `pnpm build`: pass.
- `pnpm test`: core 5,318 passed (39 skipped); app-webview 18 passed. One unrelated analytics timing
  test (`apple-app.test.ts`, two back-to-back sign-ins) failed once under parallel load and passed on
  rerun; it does not import the auth code.
- Playwright fixtures, unconfigured lane: 350 passed, 25 skipped. Configured lane: 197 passed,
  176 skipped, 2 Instagram fixture cases failed under parallel load; both spec files then passed on
  rerun (32 passed).
- Not verified: the hosted gateway's CORS headers, the hosted Auth limits and the 12:45 Auth log
  (owner check above), and on-device behavior (owner retest below). Status stays in progress until
  the owner retest.
