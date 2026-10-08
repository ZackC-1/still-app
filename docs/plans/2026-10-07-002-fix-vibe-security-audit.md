# Vibe Security audit and remediation

Status: implemented and locally verified; protected merge results are recorded on the linked PRs.

Audit baseline: `e7cab90d` (current origin/main on October 7, 2026).

Workspace: isolated `fix/vibe-security-audit-20261007`; owner checkout preserved.

## Scope and evidence

Owner requested the Vibe Security audit, prioritization, a fix plan, one PR per issue,
protected merges to main and functionality verification. Review covers committed secrets,
Supabase access policies, JWT/auth boundaries, endpoint abuse controls, payments, Apple bridge
trust, deployment configuration, and external-input validation. Still has no application LLM
integration. The mobile review applies to the actual native/WebKit implementation, not Expo.

Baseline Deno handlers: 364 passed, 125 steps, one ignored certificate integration case.
Gitleaks 8.30.1 scanned all 1,062 main-history commits with secret output redacted. Fourteen
hits were reviewed: synthetic test secrets, public throwaway development signing keys,
documentation placeholders and code/comment matches. No production credential exposure was
confirmed. Production rule trust excludes the development key. Private configuration stays
ignored and is outside this audit's output.

Migration review found owner-scoped profile/entitlement reads, revoked direct profile writes,
private purchase/analytics tables, RLS and narrow server-only RPC grants. Handler auth uses
signature verification and derives account identity from verified JWT subjects. Checkout uses
server-selected configuration, and RevenueCat webhooks require the configured static token.
Apple rights verify signed transactions and current provider state; native bridge requests
require bundled main-frame trust. These checks establish reviewed source boundaries, not
hosted deployment state or physical-device certification.

## Prioritized issues

### 1. Medium: unbounded public request ingestion

Locations at baseline:

- `supabase/functions/analytics-erasure/handler.ts:83`: byte limit exists, but an incomplete
  stream or unresolved cancellation can hold the function indefinitely before its IP limiter.
- `supabase/functions/review-signin/handler.ts:89`: `req.json()` has no byte or time bound,
  before the review allowlist/rate limit.
- `supabase/functions/analytics-identify/handler.ts:79`: `req.text()` consumes the entire body
  before a character-count check, and oversized bodies without `originProof` enter the legacy
  side-effecting path.

An unauthenticated caller can hold public erasure/review workers with a slow unfinished body;
an authenticated caller can force identify to buffer oversized bodies. This consumes memory
and worker capacity before business limits apply. Local probes confirmed a stalled erasure
request remained pending before the limiter, a 100 KB review body was processed, and a 100 KB
identify body returned 200 and executed its legacy path.

Before:

```ts
const text = await req.text();
// Or await req.json(), or reader.read() without a deadline.
```

After:

```ts
const text = await readBoundedBody(req, { maxBytes: 1024, timeoutMs: 2000 });
// Failed reads return the handler's existing invalid-request response;
// cancellation is started but never awaited.
```

PR #357 adds a small shared transport reader and migrates the three affected handlers.
Keep complete, small legacy bodies compatible. Reject over-limit, aborted, errored,
malformed UTF-8 and unfinished transport input before any account/provider work. Preserve
OPTIONS/method responses and every existing successful request contract.

Verification: demonstrate failing regression tests first; prove byte limits on real chunks,
absolute deadlines (including a trickle), aborts, errored streams and cancellation that never
resolves. Run existing review, identify, device/account erasure tests and full Deno gates.

### 2. Medium: legacy analytics identification bypasses abuse limits

Locations: `supabase/functions/analytics-identify/handler.ts:113` and `index.ts:61`.
Only `identifySubject` consumes a limiter. Any valid account can instead post `{}` (the
released 2.1 contract) and repeatedly invoke service-role account lookup/metadata work and
PostHog ingestion. Reproduction: five requests with an exhausted injected subject limiter
returned five 200s, made five account reads and five sends, and consumed zero limiter slots.
The attacker controls only their own identity; this is availability/cost abuse, not IDOR.

Before:

```ts
if (proof !== null) return identifySubject(...); // Only this path is limited.
const account = await deps.accounts.account(userId);
```

After:

```ts
const limited = await enforceRateLimit(limiter, "analytics-identify", userId, req, policy);
if (limited) return limited;
const account = await deps.accounts.account(userId);
```

PR #358 wires the existing narrow PostgreSQL limiter into the legacy path with
per-account/per-network windows. Missing/unavailable limiter configuration must refuse
side-effecting identify while the unconfigured analytics no-op remains available. Preserve
the released response contract, subject erasure behavior, and existing event schema. No
new events, personal data or credentials are introduced.

Verification: repeated valid legacy requests exhaust the budget; 429 includes Retry-After;
no account lookup, metadata write or PostHog send runs when limited; both per-user and
per-network limits apply; failure/missing configuration fails closed; auth rejection and
subject-route behavior remain covered. Verify the production entrypoint wiring.

### 3. Low application exposure: vulnerable transitive devalue dependency

Location: `pnpm-lock.yaml:1114` pins `devalue@5.9.2` through Svelte.
`pnpm audit --prod` reports six advisories (three High, two Moderate, one Low upstream).
The affected serialization APIs occur in Svelte's server renderer; Still ships client-side
Svelte applications, not an SSR service, and no attacker-accessible application call to those
APIs was found. Upstream severity is not a demonstrated Still exploit.

References: [maintainer advisory](https://github.com/sveltejs/devalue/security/advisories/GHSA-j22f-vq7h-c4qm),
[patched release](https://github.com/sveltejs/devalue/releases/tag/v5.9.3).

Before: resolved `devalue@5.9.2`. After: pin compatible `devalue@5.9.3` through the existing
workspace override mechanism and regenerate the lockfile. One dependency PR addresses this
single vulnerable dependency; list all six resolved advisories in its description.

Verification: frozen install, zero production advisories, lint/types/unit/build, browser
fixtures and native logic checks. No framework or unrelated dependency upgrade.

## Delivery and functionality

Implement and publish each issue independently, in priority order. Commit scoped files only;
protect owner untracked skill/configuration and other agents' work. Review actual final diffs,
repair valid findings, require successful repository checks and use normal protected PR
merges with the exact reviewed head. Fetch and merge current main into subsequent issue branches.
Do not bypass protections or deploy hosted functions/store artifacts as a side effect of Git.

Final evidence records lint, full typecheck, workspace tests, production build, Playwright
fixtures, Deno lint/check/tests and relevant StillKit tests. Tests cover free accountless
blocking, supported fixture routes, auth/session isolation, local settings/sync, purchases and
restoration through existing synthetic boundaries. Real hosted account/payment journeys,
signed store builds, physical Safari/Firefox Android and native-app installation require
their existing release gates. A passing suite cannot establish perfect functionality.

## Completion evidence

| Priority | Issue | Scoped PR |
|---|---|---|
| Medium | Bound actual request bytes and total ingestion time | [#357](https://github.com/ZackC-1/still-app/pull/357) |
| Medium | Meter released-client analytics identification before side effects | [#358](https://github.com/ZackC-1/still-app/pull/358) |
| Low application exposure | Patch the single vulnerable transitive dependency | [#359](https://github.com/ZackC-1/still-app/pull/359) |

The first issue's six handler regressions failed before the fix and passed afterward. Four
reader tests cover exact bytes, trickles and cancellation. Four legacy analytics security
regressions likewise failed before the second fix. Six final analytics-limit tests cover
budgets, IPv6 network keys, outages, no-op/auth behavior and the actual production entrypoint.

Recorded local verification:

- Workspace lint, full typecheck and ordinary production builds passed on the body-reader and
  patched-dependency branches. Analytics-limit workspace lint/typecheck also passed.
- Both full workspace runs passed 5,601 unit tests with 39 configured skips, plus 53 visual-runner
  tests with one skip. The patched dependency passed frozen installation and production audit
  with zero advisories.
- Updated PR #358's Linux CI passed 5,549 workspace tests with 81 skips, 53 visual-runner tests
  and all 117 release/versioning checks. Its additional skips are the macOS-only compiled
  native authority, migration and lifecycle tests, which ran in the local macOS suite above.
- Both local Playwright fixture runs passed 307 tests with 21 configuration-specific skips.
  PR #357's required GitHub job also passed both lanes: unconfigured 307 passed/21 skipped,
  configured 186 passed/142 skipped. Each lane excludes scenarios for the opposite build.
- Real Firefox 156 passed all 15 fixture tests in a disposable profile.
- Explicit local V3 builds passed for Chrome, Firefox, Safari and Apple web view, including
  with the patched dependency. These are credential-free QA artifacts, not signed store builds.
- Native StillKit passed all 417 tests. The actual Apple certificate/JWS boundary passed two
  tests with 25 steps using ephemeral synthetic keys; no real purchase/provider was contacted.
- Individual Deno suites passed: body-reader branch 374 tests/125 steps; analytics-limit branch
  370 tests/125 steps. Each skipped the separately executed certificate case. Both passed Deno
  lint and all 14 function entrypoint checks.
- After integrating the merged body-reader fix into the analytics-limit branch, the combined
  suite passed 380 tests and 125 steps with zero failures and one separately executed
  certificate case skipped. Deno lint and all 14 entrypoint checks also passed together.

Each PR requires the repository's three protected checks: lint/typecheck/unit/build,
Playwright fixtures, and Deno functions. Later branches incorporate merged main before their
final checks. PR checks and merge records are the authoritative evidence for protected merges.
No hosted function, production database, store artifact or payment configuration is deployed
by this work. The existing analytics-erasure or entitlement-writer database URL provides the
narrow limiter connection; missing or unavailable limiter configuration fails closed for
side-effecting identification. Deployment and live verification must follow the existing
release procedures.

Mem0 retrieval failed due to its monthly quota. Repository documents and the local work-state
tracker hold this task's evidence; no successful remote memory write is claimed.
