# Website copy and direct downloads

Status: implementation and publication completed  
Owner: Codex / founder-directed copy review  
Created: 2026-09-14  
Source branch: `docs/homepage-heading-20260914`  
Publishing branch: `docs/publish-homepage-heading-20260914`

Update the homepage wording supplied by the owner, expose direct store links, let the outcome
heading span its section, center the download heading, reduce vertical section spacing, and call
the product Still throughout public website copy.

Follow [strategy](../../STRATEGY.md), the [release runbook](../release/README.md), and the
[separate Pages publishing guidance](../solutions/conventions/github-pages-custom-domain-certificate.md).
Present all platforms equally with a short free-update rollout notice and keep the Safari-only
iOS boundary accurate. Preserve
historical refund/retention terms, runtime versions, submitted store assets and owner store text.

1. Apply owner homepage copy, store links, scoped heading width/centering and reduced vertical
   spacing to both website branches. Keep every section; the owner withdrew the removal request.
2. Remove public version branding from secondary pages, aliases and the website sharing image.
3. Verify desktop/phone rendering, exact store URLs, page/source parity and public copy scan.
4. Merge reviewed source and publishing PRs; verify Pages deployment and live content.

Acceptance: visitors see the requested headings, can navigate directly to each store, understand
free blocking/optional sync and pending updates, and see natural heading wrapping at phone width.

Rollback: revert only these website changes through PRs. Publication is authorized by the owner;
no store-submission changes are included.

Evidence so far: root visually checked homepage at 1280px and 375px. The outcome heading spans
its 1160px section and the download heading is centered at 640px. Desktop height fell from 5143px
to 4366px; neither viewport overflows horizontally. Secondary-page/source/alias parity passed,
28 route/viewport checks passed, and the regenerated 1200×630 sharing image was visually reviewed.
Refund and privacy-retention blocks are unchanged. Pages deployment 34879915337 passed, and live homepage bytes match the reviewed publishing
branch after PR190. Source integration is tracked by PR189 and its required checks. Existing Pages solution guidance covers this workflow;
no new solution document is needed.

Publication: [PR190](https://github.com/ZackC-1/still-app/pull/190).
Source integration: [PR189](https://github.com/ZackC-1/still-app/pull/189).
Independent review passed for source/publishing parity, 87 internal links/anchors, unchanged
retention/refund terms and scoped public assets. No new unit tests were needed for these static
copy and CSS changes; browser evidence and the normal CI gates cover the relevant checks.
