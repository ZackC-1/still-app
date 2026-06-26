# Still — external services & connections checklist

The autonomous `/loop` build can do almost all of Phase A with **zero external accounts** (everything runs locally via the Supabase CLI + Docker and Playwright). External accounts are needed to *deploy* and to do the Apple/store half. This file lists every connection, who does it, what it unblocks, and the order.

Legend: 🤖 agent can do · 🧑 human must do · ⏳ blocks a phase

---

## Tier 0 — needed to start the autonomous loop

| # | Connection | Who | Provides | Blocks |
|---|---|---|---|---|
| 1 | **GitHub auth** (`gh auth login`) | 🧑 | push + Actions for the loop | ⏳ everything (version control + CI) |
| 2 | GitHub repo created (`gh repo create`) | 🤖 once authed | the remote | ⏳ CI |
| 3 | Local toolchain: Node 20+, pnpm, Supabase CLI, Docker, Playwright | 🤖 installs | local dev + headless tests | ⏳ Phase A local |

After Tier 0, the loop can build and CI-test all of Phase A locally.

---

## Tier 1 — needed to deploy Phase A (sync goes live)

| # | Connection | Who | Provides | Blocks |
|---|---|---|---|---|
| 4 | **Supabase project** (create at supabase.com) | 🧑 creates · 🤖 runs migrations/functions | `SUPABASE_URL`, anon key, migration-only service-role/DB credentials, narrow function write credentials | ⏳ hosted rule set, auth, sync, entitlement webhook |
| 5 | **Resend** (or SMTP) + verified sending domain | 🧑 (needs DNS) | `RESEND_API_KEY`, sender domain | ⏳ magic-link sign-in (built-in caps at ~2/hr → launch blocker) |
| 6 | Sentry (optional) | 🧑 | `SENTRY_DSN` | crash reporting only |

---

## Tier 2 — needed for the paid unlock + Apple/Safari (Phase B, human-gated)

| # | Connection | Who | Provides | Blocks |
|---|---|---|---|---|
| 7 | **Apple Developer Program** ($99/yr) | 🧑 | team, certs, entitlements (SIWA, IAP) | ⏳ Phase B |
| 8 | **App Store Connect**: create non-consumable `still_sync` ($1.99); generate **In-App Purchase Key (.p8)** + ASC API key; create sandbox testers | 🧑 | product + `.p8` + API key + testers | ⏳ real purchase |
| 9 | **RevenueCat**: project, product, entitlement, offering, webhook + static auth token; upload the `.p8` | 🧑 (dashboard) | `RC_PUBLIC_KEY`, `RC_SECRET_KEY`, `REVENUECAT_WEBHOOK_TOKEN` | ⏳ Phase B purchase. NOTE: the webhook→entitlement path is fully testable in Phase A with a **faked** payload — no Apple needed to prove the bridge. |
| 10 | **Mac + Xcode + Apple device(s)** | 🧑 | Safari build/sign, sandbox purchase test | ⏳ Phase B |
| 11 | **Chrome Web Store** developer account ($5 one-time) | 🧑 | publish the Chromium extension | Chromium store launch |
| 12 | Domain (optional v1) | 🧑 | rule-endpoint alias, privacy policy, marketing | optional |

---

## What the agent CANNOT do (hard human gates)

1. App Store Connect product creation, the `.p8` key, the ASC API key, sandbox testers.
2. Pasting credentials into RevenueCat + creating the entitlement/offering/webhook.
3. `xcrun safari-web-extension-packager` + Xcode build/sign/notarize (first-run provisioning is GUI).
4. The real sandbox/device purchase test.
5. Resend DNS verification; Supabase project creation; production keys.

Everything else — the monorepo, core, Chromium extension, the entire Supabase backend including the webhook (faked-payload tested), the Swift integration *code* + a local `.storekit` config — the agent builds and tests unattended.

---

## Selector canary (U21)

The `selector-canary` Edge Function flags selector rot. It is invoked on a schedule (not by users).
Deploy steps: set `SELECTOR_CANARY_NOTIFY_URL` (a Slack/webhook/email-relay URL) via
`supabase secrets set`, then schedule the function — e.g. a `pg_cron` job that `net.http_post`s the
function URL daily, or the Supabase dashboard scheduler. Without the notify URL it logs and no-ops.
Login-walled services (e.g. Instagram) report as *indeterminate*; a persistent-indeterminate streak
fires its own "needs manual check" alert so they can't rot silently.

## Secrets

All secrets live in `.env` (gitignored); `.env.example` lists every key by name. Supabase Edge Function secrets are set via `supabase secrets set`. Never commit a real key.

## Autonomy / loop posture

`.claude/settings.json` sets `permissions.defaultMode: bypassPermissions` (no prompts). The enforceable guardrails are server-side and environment-side, not convention: **GitHub branch protection on `main`**, secret scanning, keeping production secrets out of the loop environment, and running `/loop` only on a dedicated `build/*` branch/worktree. Branch protection prevents direct damage to `main`; it does not protect any secret or external account credential available to the loop.

### Status (U1)

- **Repo:** `ZackC-1/still-app` — **public** (switched from private on 2026-06-23). Branch protection on a *private* repo needs GitHub Pro; making the repo public unblocked free protection. The extension content-script code ships to users and is inspectable regardless; the genuine secrets live only in `.env.local` / Supabase function secrets, never in the repo.
- **Branch protection:** active via repository ruleset `protect-main` (require PR before merge, require green CI status checks `lint · typecheck · unit · build` + `Playwright on fixtures` with strict up-to-date policy, block force-push (`non_fast_forward`) and branch deletion). `required_approving_review_count = 0` because a solo maintainer cannot self-approve; the PR + green-CI gate is the enforceable checkpoint. Raise the review count once there's a second maintainer.
- **CI:** `.github/workflows/ci.yml` — green on the scaffold. The Playwright `e2e` job self-skips until U16 lands `playwright.config.ts`.
- **Supply-chain note:** the release-age cooldown (`minimumReleaseAge`) is disabled in `pnpm-workspace.yaml` + the CI env, so the autonomous loop's CI doesn't fail when a dependency published a same-day patch. Lockfile integrity hashes remain the real tamper protection. Revisit if a stricter posture is wanted.
