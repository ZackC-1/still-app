# Still v2 (2.0 / 2.1) — release record

Status: shipped. Still 2.x is the free release: YouTube Shorts and
Instagram/Facebook Reels removal plus TikTok website blocking, with optional
free settings sync. No account or purchase required. Both paid-tier flags
disabled.

## Plans

- Release and verification planning lives in dated records below and in
  [docs/plans/](../../../plans/README.md) (September 2026 entries: sync recovery,
  Facebook Reels fixes, usage analytics, homepage work).

## Release status and certification

- [2026-09-14 release status](../2026-09-14-release-status.md) — submitted artifacts,
  public availability, verification.
- [2026-09-25 release status](../2026-09-25-release-status.md) — Apple 2.1.0 build 9,
  Chrome/Firefox 2.1.x state.
- [2026-09-08 certification](../2026-09-08-still-2-certification.md) — device coverage
  and accepted exceptions (physical iPad skipped/unverified).

## Screenshots (committed, on GitHub)

- Current store finals: [store-ready/](../../screenshots/store-ready/README.md)
  (chrome, firefox, iphone, ipad, mac, web, instagram, apple).
- 2.0 archive: [archive/2.0/](../../screenshots/archive/2.0/browser-free-2-capture.md)
  (chrome, firefox, browser-v3 captures and notes).

## Release files (local only, never committed)

Per-version store packages live in Git-ignored `release-builds/` at the repo root:

- `release-builds/2.0.0/` (apple, chrome, firefox + upload manifest)
- `release-builds/2.1.0/` (apple, chrome, firefox + manifests)
- `release-builds/2.1.1/` (chrome, firefox + manifest)

These directories are intentionally absent from GitHub. A fresh clone will not
contain them; do not rebuild or resubmit pending artifacts merely to
synchronize documentation.

## Note

The current canonical docs (`STRATEGY.md`, `docs/PRODUCT.md`,
`docs/ARCHITECTURE.md`) still describe this 2.x free release. Step 3 of the
docs refresh updates them to the V3 contract in
[v3/README.md](../v3/README.md).
