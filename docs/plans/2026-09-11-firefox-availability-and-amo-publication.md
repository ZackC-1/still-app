---
title: Reflect Firefox availability and the observed AMO publication boundary
status: completed
date: 2026-09-11
owner: Codex
branch: docs/firefox-release-availability
---

# Firefox availability and AMO publication

## Outcome and scope

Public-page source and the separately prepared website update distinguish available Firefox 2.0 from
pending Apple/Chrome 2.0. Matching search descriptions preserve that distinction. Capture the
verified AMO Continue behavior in a reusable lesson and link the Firefox runbook to it.

Release verification confirmed the public Firefox API reports version 2.0.0/public after advancing the validated
upload; source and reviewer notes were subsequently saved. This task changes no store state,
runtime code, privacy policy, retention decision or website publication setting.

## References

- [Strategy](../../STRATEGY.md) and [marketing playbook](../release/marketing-playbook.md).
- [Firefox runbook](../release/03-firefox-amo.md).
- [Website branch separation](../solutions/conventions/github-pages-custom-domain-certificate.md).

No existing solution covered the AMO button/publication mismatch. The new lesson records the
observed failure mode and prevention steps without embedding time-sensitive portal status.

## Verification

- Check every public-page availability banner, homepage download label and changed meta description.
- Mirror only those page changes into website PR #173; preserve unrelated preparation.
- Visit public URLs at mobile/desktop widths; verify internal links, assets, anchors and overflow.
- Check new documentation links and `git diff --check`; no app test suite needed for static copy.

## Release boundary

Website publication is separately authorized and coordinated through PR #173. This source merge
does not deploy gh-pages or provide privacy/retention approval.
Coordinate with the independent browser screenshot PR without editing its files.

## Completion evidence

- Nine changed source pages match the staged website byte-for-byte, including three changed directory aliases.
- Local Chromium checked 14 public routes at 375px and 1440px: 28 successful page checks, no
  missing assets, invalid JSON-LD, page errors or horizontal overflow; 33 internal links/anchors pass.
- Privacy remains unchanged and its 320px dark-mode check passes. The 375px download section was
  visually inspected: Firefox available; Apple and Chrome pending; all labels readable.
- All 14 local documentation links resolve; all five changed meta descriptions are at most 160
  characters; stale all-platform pending banners are absent; both diffs pass `git diff --check`.
- App suites were not rerun for static copy. Required repository CI runs on the source PR.
- Website PR #173 was a draft at initial validation; its subsequent owner-authorized publication is
  tracked separately. This source PR itself does not publish the website or approve privacy.
