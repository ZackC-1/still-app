---
title: Hosted portal config drifts — a prior "verified" note is a snapshot, not evidence
date: 2026-07-16
category: conventions
module: supabase/auth
problem_type: convention
component: email_processing
severity: high
applies_when:
  - "About to gate a release on hosted/portal config (Supabase Auth templates, ASC state, DNS, RevenueCat) that a checklist or note already marks verified"
  - "Building an email one-time-code flow where the provider shares a single token between the emailed link and the emailed code"
tags: [supabase, gotrue, otp, email-templates, prefetch, portal-config, config-drift, apple-review]
---

# Hosted portal config drifts — a prior "verified" note is a snapshot, not evidence

## Context

Apple rejected Still under Guideline 2.1(a): *"an error message was displayed when we entered the
verification code."* The deploy checklist carried a note saying the Supabase email templates were
**"Verified live 2026-07-06"** — so the templates were treated as a solved item and the July 15
session hunted the bug in client code instead, shipping defensive fixes for rate-limit classification,
expiry handling, and error routing.

The prefetch theory *was* raised on July 15 as one of several "leading suspects," but the session
ended with the hosted auth config explicitly logged as **unverified** — nobody had opened the
dashboard.

On 2026-07-16, someone finally looked. The live **"Confirm signup"** template still contained
`{{ .ConfirmationURL }}`. The 10-day-old "verified" note was simply wrong, and it had been steering
the investigation away from the most probable root cause the entire time.

## Guidance

**Two distinct rules came out of this.**

**1. The technical trap: an emailed link and an emailed code can share one token.**

In Supabase/GoTrue, the magic-link URL and the 6-digit OTP in the same email are backed by the
**same one-time token**. Link-prefetching mail scanners (Outlook Safe Links and similar) fetch the
`ConfirmationURL` automatically on delivery, which **consumes the token server-side**. The user then
types a perfectly correct code and is told it is invalid. No client-side code can compensate — a
prefetch-consumed token looks identical to a wrong code to a flawless client.

If your flow only needs the code, the email must contain **only** the code:

```html
<h2>Sign in to Still</h2>
<p>Enter this code in Still: <strong>{{ .Token }}</strong></p>
<p>This code expires in 1 hour. If you didn't request it, ignore this email.</p>
```

No `{{ .ConfirmationURL }}`, no `{{ .TokenHash }}` link. With no link in the email, there is nothing
for a scanner to prefetch.

**Both templates must be fixed, not just the obvious one.** GoTrue sends **"Confirm signup"** — not
"Magic Link" — the first time an address signs in via OTP. A fix applied only to "Magic Link" leaves
every *new* customer broken while every test with an existing address passes. Making the two
templates identical is correct.

**2. The process rule: re-verify hosted config live, immediately before the gate.**

A dated "verified" note records what someone saw once. It is not evidence about now. Portal config
is external state: it drifts through dashboard edits, provider defaults, and migrations, and nothing
in the repo constrains it. Before any gate that depends on it, open the live dashboard (or read the
Management API) and check — and do not let a prior checkmark suppress the check.

Better still, **make the config declarative instead of trusting verification**. `supabase config push`
can pin `otp_length`, OTP expiry, and templates from `config.toml`, moving them from dashboard-drift-prone
state into version control. This was identified as a strong candidate on 2026-07-15 but has not been
adopted — it remains the durable fix for this whole class of drift.

## Why This Matters

This one stale note plausibly cost an App Store rejection and a review cycle. The template had been
broken for at least ten days while a checklist asserted it was fine, and the note's existence is
precisely what stopped anyone from looking. A wrong "verified" marker is worse than no marker: an
unchecked box invites a check, a checked box suppresses one.

The prefetch mechanism is also non-obvious in a specific way — it produces a **correct-looking client
and an incorrect-looking user**. Every clue points at the code or at the person typing, and the actual
consumer is a mail scanner that touched the token before either of them.

## When to Apply

- Before any release gate depending on hosted/portal config — auth templates, OTP length/expiry,
  SMTP, rate limits, ASC state, DNS, RevenueCat settings — regardless of what a checklist claims.
- When building any email one-time-code flow: check whether your provider shares a token between the
  link and the code, and strip the link if you only need the code.
- When a bug's symptoms indict the client but the client looks correct: suspect state outside the
  repo before adding more defensive client code.
- When writing a checklist item about external state, prefer a status line with a date over a `[x]`,
  and say explicitly that it must be re-verified rather than trusted.

## Examples

The checklist now carries the correction rather than the false claim, so the next reader inherits the
evidence instead of the trap:

> ⚠️ The 2026-07-06 "verified live" note was WRONG or the template later regressed: on 2026-07-16 the
> live "Confirm signup" template still carried `{{ .ConfirmationURL }}` — the §1b don't-trust-old-notes
> rule caught it. FIXED 2026-07-16: both templates are now token-only and were re-verified end-to-end
> the same day.

The verification that closes this gate is an end-to-end sign-in with **two** addresses — one
brand-new (exercises "Confirm signup") and one existing (exercises "Magic Link") — because a
one-address smoke leaves the template every first-time customer hits completely unproven.

## Related

- `docs/release/extension-purchase-deploy-checklist.md` §1b — the hard gates and the live-verification
  methods (dashboard click-path and Management API query).
- `docs/solutions/integration-issues/asc-submission-silently-omits-first-iap.md` — the sibling lesson
  from the same release: the portal *UI* lies about submission state just as a stale note lies about
  config. Verify at the source of truth, immediately before the gate.
- `AGENTS.md` → "Secrets and external systems": *"Portal status is time-sensitive. Verify it directly
  before acting."* This doc is the concrete precedent for why that rule exists.
