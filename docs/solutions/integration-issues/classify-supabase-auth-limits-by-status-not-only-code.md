---
title: Classify Supabase Auth rate limits by the 429 status, not only the error code
date: 2026-10-15
category: integration-issues
module: packages/core/src/sync/auth.ts
problem_type: integration_issue
component: authentication
symptoms:
  - "The iPhone app showed the generic \"Couldn't send the code. Try again.\" for a sign-in code request that a later attempt completed"
  - "The same refusal path rendered the honest wait line in the browser extensions' tests, because those mocks always carried error.code"
  - "The re-request countdown was a fixed 60 s regardless of the wait the provider stated"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [supabase, gotrue, auth-js, otp, rate-limit, wkwebview, cors, error-classification]
---

# Classify Supabase Auth rate limits by the 429 status, not only the error code

## Problem

Still mapped a refused code send to its honest wait state only when `error.code` was
`over_email_send_rate_limit`. Everything else, including any 429 whose code was missing, became the
generic send failure. The owner hit that generic line in the iPhone app (ISS-0060).

## Why the code can be missing

- supabase-js (`auth-js` `handleError`) reads `code` from the 2024-01-01 error body only when it can
  read the `X-Supabase-Api-Version` **response header**. Otherwise it falls back to the legacy
  `error_code` field.
- GoTrue answers a request that sends the 2024-01-01 version header with `{code, message}` only, with no
  `error_code`. If the client cannot read the version header, the error has `code === undefined`.
- The Apple app's WKWebView is loaded with `loadFileURL`, so every Auth call is a cross-origin read and
  only CORS-exposed headers are visible. Extension background contexts have host permission and see all
  headers, which is why only the app reproduced it.
- `error.status` (429) is always readable.

Other limits on the same endpoint also return 429 with a different code: the per-IP sign-in limit is
`over_request_rate_limit`, and the hourly email cap shares `over_email_send_rate_limit` with the
per-email interval.

## Fix

- Treat **any** 429 from a code send as `send-rate-limited`, and any 429 from a verify as
  `verify-rate-limited` (`isProviderLimit` in `auth.ts`). Every non-429 failure keeps the generic
  outcome.
- GoTrue states the per-email wait only in its message: "For security purposes, you can only request
  this after N seconds." Read that one number from a 429 alone with a strict pattern, add one second
  (GoTrue truncates), and clamp to the 600 s ceiling. Classification never reads message text. With no
  match (hourly cap, per-IP throttles), the controller keeps its fixed lock.

- Keep the code readable at the source: the Apple WebView's Supabase client uses
  `preserveAuthErrorCodes` as its `fetch`. It copies `code` into `error_code` on non-2xx `/auth/v1/`
  JSON bodies, so supabase-js's legacy fallback finds it. That keeps every Auth code (a wrong code's
  `otp_expired` included) working even when the version header is hidden. A test with the real
  supabase-js client reproduces the lost code and proves the wrapper restores it.

## Keep the client interval equal to the server's

The visible "Send a new code in Ns" countdown (`RESEND_COOLDOWN_MS`) must equal the hosted per-email
minimum interval (`smtp_max_frequency`). Shortening only the client turns every early resend into a
refusal. Change both together. In Still the QA sandbox shares the hosted project's Auth configuration,
so that interval cannot be changed for QA alone. Local `supabase/config.toml` values describe only the
development stack.

## Prevention

- Test auth error mapping with the **code-absent** shape a cross-origin client can see, not only the
  ideal `{code, status}` mock.
- When a provider states a wait, render that wait; a fixed guess cannot match a configurable server.
