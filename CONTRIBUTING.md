# Contributing to Still

Thanks for helping improve Still. This project is public for transparency and focused contributions; it is not a general-purpose extension framework.

## Before opening work

- Use the issue templates for bugs and feature requests.
- Keep security-sensitive reports out of public issues. Follow [SECURITY.md](SECURITY.md).
- Check [CONTEXT.md](CONTEXT.md) for the domain vocabulary before naming new code.
- For larger changes, open an issue first so the module, interface, and verification plan are clear.

## Local setup

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test --project=fixtures
```

Supabase function work also needs the Supabase CLI, Docker, and Deno. Apple work needs Xcode 16+ and the scripts in [apps/apple/scripts/README.md](apps/apple/scripts/README.md).

## Pull request expectations

- Keep PRs focused on one behavior, fix, or documentation update.
- Use descriptive titles in the conventional form when possible: `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `test(scope): ...`, `chore(scope): ...`.
- Include verification steps in the PR body.
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
