# Verification layers

Run commands below from the repository root.

| Layer | Location | Run |
|---|---|---|
| Unit and contract tests | Beside package source in `__tests__/` | `pnpm test` |
| Browser fixtures, including store assets | `playwright/` using hand-authored `fixtures/` | `pnpm build`, then `pnpm exec playwright test --project=fixtures` |
| Live-site smoke checks | `smoke/` | `pnpm exec playwright test --project=smoke` after building |
| Native Swift decisions | `apps/apple/StillKit/Tests/` | `swift test --package-path apps/apple/StillKit` |
| Backend handlers/database | `supabase/` | [Backend checks](../supabase/README.md) |

Fixture tests gate CI; live-site smoke checks are separate and non-gating. Raw logged-in page
captures must not be committed as fixtures. Build output and test reports are ignored.
Configured and unconfigured browser fixture runs use separate builds, as defined in
[CI](../.github/workflows/ci.yml). These tests do not replace native/physical-device validation;
record actual coverage in the [release evidence](../docs/release/VALIDATION.md).

## Tool environment inputs

Set these in the shell for the relevant runner, rather than in a shipped application's env file.
Paths and reports remain local; no credential values belong in tracked examples.

| Input | Existing consumer |
|---|---|
| `STILL_QA_BACKEND_ENVIRONMENT`, `STILL_QA_SUPABASE_URL`, `STILL_QA_SUPABASE_ANON_KEY` | [V3 QA build profiles](../scripts/qa/README.md); the hosted profile requires the approved `shared-hosted` arrangement and public client values. |
| `STILL_QA_ACCESS_ENVIRONMENT`, `STILL_QA_ACCESS_PUBLIC_KEYS`, `STILL_QA_REVENUECAT_PUBLIC_API_KEY` | Additional public inputs for the existing [paid-sandbox QA tooling](../scripts/qa/README.md#additional-paid-sandbox-tooling-inputs). Production trust and private signing material are refused. |
| `STILL_DESIGN_PACKAGE` | Visual runners: override the local design/comparator package location. |
| `STILL_VISUAL_REFERENCE_DIR` | Component and real-bundle visual runners: override the reference-frame directory. |
| `STILL_VISUAL_OUTPUT` | Component/store visual runners: override their output directory. |
| `STILL_VISUAL_REAL_OUTPUT` | Chromium and WebKit real-bundle visual runners: override their output directory. |
| `STILL_VISUAL_FIREFOX_OUTPUT` | Real Firefox visual runner and setup: override their output directory. |
| `STILL_VISUAL_SIGN_IN` | Real-bundle comparator: `1` or `0` overrides its detection of compiled sign-in UI. It supplies no credentials and creates no session. |
| `PORT` | Owner-admin's local E2E server: override its default port of 4317. |

Node debug controls (`DEBUG`, `NODE_DEBUG`) and GitHub runner metadata (`GITHUB_ACTIONS`,
`GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `RUNNER_ENVIRONMENT`) are tooling inputs, not app secrets.
Leave runner metadata to CI. These controls do not certify deployment, real purchases or devices.
