---
title: Keep secrets out of CLI arguments — agent transcripts persist them like chat output
date: 2026-07-16
category: security-issues
module: supabase/functions
problem_type: security_issue
component: authentication
symptoms:
  - "A secret passed as a literal `supabase secrets set KEY=value` argument is persisted verbatim in shell history and in the agent's tool-call transcript"
  - "A curl smoke test that prints the response body writes the minted session tokens into the same transcript"
  - "Secrets set after a function deploy do not take effect until the function is redeployed"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: medium
tags: [supabase, secrets, csprng, env-file, deploy-ordering, credential-hygiene, agent-transcripts]
---

# Keep secrets out of CLI arguments — agent transcripts persist them like chat output

## Problem

`AGENTS.md` forbids credentials in "plans, handoffs, solution docs, commits, or **chat output**."
An agent running `supabase secrets set REVIEW_SIGNIN_CODE=123456` satisfies every one of those
rules by the letter and violates the intent completely: the live value lands in its persisted
tool-call transcript, which is reviewed, shared, and fed back into future context. It does not
look like chat output — it looks like ordinary infrastructure tooling — which is exactly why it
gets missed.

This surfaced during a code review of the plan to deploy the `review-signin` function, where the
proposed step would have put an App Review authentication bypass code into the session transcript.

## Symptoms

- A secret as a literal CLI argument persists in shell history **and** in the agent's tool-call
  record, verbatim.
- A smoke test that prints the response body writes minted access/refresh tokens into the same
  transcript.
- A "verify the client and server values match" step, done by printing both, leaks both.
- Secrets set *after* a function deploy silently do not take effect until a redeploy — this repo
  was previously bitten by exactly that ordering with `SELECTOR_CANARY_INVOCATION_TOKEN`.

## What Didn't Work

- **Relying on the letter of the secrets rule.** "Never put secrets in chat output" reads as
  satisfied by a CLI invocation. The rule needed the transcript named explicitly.
- **Suppressing stdout alone.** `-o /dev/null` hides the response, but a secret in `argv` is already
  recorded regardless of what the command prints.

## Solution

Move the value from generation to consumption without it ever being rendered.

**1. Mint straight into a gitignored file, never echoed** (`.gitignore` carries `.env` / `.env.*`
with an `!.env.example` exception, so `packages/app-webview/.env.review-signin` can never be
committed — confirm with `git check-ignore` before writing):

```bash
python3 -c "import secrets; print(f'REVIEW_SIGNIN_CODE={secrets.randbelow(10**6):06d}')" >> "$F"
```

CSPRNG, not `$RANDOM` — the rate limiter caps brute force but does not stop one lucky guess of a
memorable pattern.

**2. Push via `--env-file`, never inline args** — and always name the project explicitly, because
the bare command depends on a gitignored local `supabase link` that a fresh clone or another
worktree does not have:

```bash
supabase secrets set --env-file packages/app-webview/.env.review-signin --project-ref <ref>
supabase functions deploy review-signin --import-map supabase/functions/deno.json --project-ref <ref>
```

**3. Set secrets before deploying.** Documented Supabase behavior is that Edge Function secrets are
injected per-invocation from a platform store, so a newly-set secret is generally expected to be
visible on the next invocation without a redeploy. This repo nonetheless observed a secret set
*after* deploy not taking effect until redeploy (`SELECTOR_CANARY_INVOCATION_TOKEN`) — cause never
established (warm instance, stale link, or a platform quirk at the time). Treat set-then-deploy as
cheap insurance rather than platform law: the ordering costs nothing and removes the question.

**4. Smoke-test on status codes only.** Source the env file into shell variables and discard the
body entirely — the assertion is the status code, so minted tokens never materialize:

```bash
set -a; source packages/app-webview/.env.review-signin; set +a
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H 'Content-Type: application/json' \
  --data "{\"action\":\"verify\",\"email\":\"$REVIEW_SIGNIN_EMAIL\",\"code\":\"$REVIEW_SIGNIN_CODE\"}"   # expect 200
```

Assert the negative paths too (wrong code → 401, unknown address → 404): a positive-only smoke
cannot distinguish a working gate from one that accepts everything.

**Residual vector this does not close:** the shell expands those variables before `exec`ing `curl`,
so the plaintext sits in the **curl process's argv** for the duration of the call — readable by
local `ps -eww`. The agent transcript stays clean (it records `$REVIEW_SIGNIN_CODE`, not its value),
which is the threat this pattern targets, but a local observer is not covered. Where that matters,
keep the body out of argv entirely:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H 'Content-Type: application/json' --data @- <<EOF
{"action":"verify","email":"$REVIEW_SIGNIN_EMAIL","code":"$REVIEW_SIGNIN_CODE"}
EOF
```

**5. Verify by exit code or status code — never by printing. The right technique depends on whether
the value is readable.**

- **Both sides locally knowable** (e.g. the client-baked email vs. the same key in the env file):
  compare with `cmp`/`diff` on extracted lines and report only pass/fail.
- **The remote side is write-only** (e.g. the code): there is nothing to diff. `supabase secrets list`
  returns **digests, never values** — by design. Verify *behaviorally* instead: exercise the secret
  and assert the HTTP status (correct → 200, wrong → 401). Do not go looking for a way to read the
  deployed value back; that instinct is the leak this doc exists to prevent.

**6. Record pass/fail + date only** in committed checklists — never raw codes, request bodies, or
session tokens.

## Why This Works

Every durable point where the value could be captured — a CLI argument, stdout, a committed file, a
printed diff — is replaced with something that carries only the *proof* rather than the *value*: a
file path, an exit code, an HTTP status. The secret comes to rest in exactly two places, a gitignored
file and the hosted secret store, and every verification step still produces real evidence that it
ran and passed.

The scope is worth being precise about: this defeats **persistence** (transcripts, history, git), not
**local observation** (a transient argv readable by `ps` on the operator's own machine, per step 4).
That is the right trade for the actual threat — a transcript outlives the session and travels; an
argv lives for the length of one curl on a machine an attacker would already have to own.

## Prevention

- **Read "chat output" in the secrets rule as including agent tool-call transcripts.** If a value
  would be wrong to paste into chat, it is wrong as a CLI argument.
- Prefer a tool's file-based secret input (`--env-file` or equivalent) over inline args — the pattern
  generalizes to any CLI that offers one.
- Make smoke tests assert status codes, not bodies, whenever the body carries credentials.
- Set secrets **before** deploying the function that reads them.
- Pass `--project-ref` (or the equivalent explicit target) so the command does not silently depend on
  unversioned local link state.
- Rotate when the need ends: `supabase secrets unset <KEY> --project-ref <ref>`, and clear any
  build-time env that mirrors it — a populated value silently bakes into every future build.

## Related Issues

- `docs/solutions/security-issues/supabase-edge-function-hardening.md` — the code-level boundary
  hardening for these same functions (fail-closed token gates, constant-time compare). This doc covers
  the operator/agent workflow around the same `supabase secrets set` deploy step.
- `docs/solutions/security-issues/gate-production-trust-by-build-mode.md` — the related rule that
  trust must be gated by build mode, not by whether a secret happens to be populated.
- `docs/release/extension-purchase-deploy-checklist.md` §1c — the operational mint/deploy/verify/rotate
  sequence this doc generalizes.
