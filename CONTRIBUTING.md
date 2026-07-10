# Contributing to Still

Thanks for helping improve Still. This project is public for transparency and focused contributions;
it is not a general-purpose extension framework.

## Source-available status

Still is source-available, not open-source licensed. The public repository permits inspection and
GitHub-hosted forks under GitHub's terms, but it does not grant general reuse or derivative-work
rights. Open an issue before preparing a code contribution so the maintainer can confirm scope and
permission. See [LICENSE](LICENSE) for the controlling terms.

## Before opening work

- Use the issue templates for bugs and feature requests.
- Keep security-sensitive reports out of public issues. Follow [SECURITY.md](SECURITY.md).
- Check [CONTEXT.md](CONTEXT.md) for the domain vocabulary before naming new code.
- Open an issue before code changes so scope, permission, and the verification plan are clear.

## Local setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test --project=fixtures
```

Supabase function work also needs the Supabase CLI, Docker, and Deno. Apple work needs Xcode 16+ and the scripts in [apps/apple/scripts/README.md](apps/apple/scripts/README.md).

The normal TypeScript/WebExtension workflow does not require production credentials. Copy a
package-level `.env.example` only when testing auth, sync, or purchase integration, and use local or
development values. Never request or reuse production secrets for a pull request.

Useful focused commands:

| Area | Command |
|---|---|
| Chromium extension | `pnpm --filter @still/ext-chromium build` |
| Firefox extension | `pnpm --filter @still/ext-chromium build:firefox` |
| Safari extension | `pnpm --filter @still/ext-safari test && pnpm --filter @still/ext-safari build` |
| Supabase database | `supabase migration up && supabase test db` |
| macOS app | `apps/apple/scripts/build.sh macos` |
| iOS simulator | `apps/apple/scripts/build.sh ios-sim` |

## Pull request expectations

- Keep PRs focused on one behavior, fix, or documentation update.
- Use descriptive titles in the conventional form when possible: `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `test(scope): ...`, `chore(scope): ...`.
- Include verification steps in the PR body.
- Run the smallest relevant tests while developing, then the full local checks above before review.
- Update docs when the public interface, privacy posture, release process, or architecture changes.
- Do not commit generated outputs such as `dist/`, `.output/`, `.wxt/`, coverage, Playwright reports, or local Xcode build products.
- Do not commit real secrets. Use `.env.example` and package-level `.env.example` files for names only.

## Architecture expectations

Still favors deep modules with narrow interfaces. New code should improve locality: callers should not need to know platform quirks, entitlement internals, or rule-set validation details unless that is the module's interface.

If a new seam has only one adapter, be cautious. A second real adapter is usually the evidence that the seam is paying for itself.

## Privacy and security expectations

- Do not expand host permissions without a clear product need and README/privacy updates.
- Do not introduce remote executable code.
- Keep entitlement server-authoritative.
- Keep client-bundled keys public-only.
- Add or update tests for blocking, entitlement, sync, and account flows.
