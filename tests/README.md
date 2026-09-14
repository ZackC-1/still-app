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
