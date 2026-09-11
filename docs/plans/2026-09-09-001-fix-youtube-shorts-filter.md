# YouTube Shorts filter and continuation loop

Status: implementing. Owner: Codex. Branch: fix/youtube-shorts-filter.

The live desktop search chip now uses a role=tab button with text Shorts and no title attribute.
The existing yt-chips rule misses it. Selecting it while Shorts and advertising slots are removed
exposes YouTube's continuation trigger, causing repeated search requests without a page reload.
A fresh Chromium profile reproduced requests increasing from 2 to 19 in 12 seconds after collapsing
ad slots. The owner's Mac Safari session exhibits the same empty-results/loading symptom.

Keep the existing rule set and content-script boundaries (CONTEXT.md and ADR0002). Mark the semantic
Shorts chip for the authored hide rule. If an enabled blocker encounters an already-selected Shorts
search chip, activate the same bar's All tab once; preserve search text and other sites. Off switches
must restore the chip. Do not change general pagination, advertising rules, account flows or providers.

1. Add failing real content-script and built-extension regressions for the current chip markup,
   selected-filter recovery, no repeated reset, off-state restoration and ordinary filter preservation.
2. Implement and regenerate the bundled development signature/CSS using the existing tools.
3. Run focused and full checks, repeat the live isolated reproduction, and obtain independent reviews.
4. Build a distinct signed Mac candidate; repeat the owner's Safari scenario before claiming fixed.

Risks: YouTube DOM reuse and selector drift; resetting a filter must be bounded and remain in the
same search bar. Keep downloaded signed-rule overrides authoritative. Rollback is the prior preserved
candidate 09851c0; never relabel its artifacts. No production or store actions are part of this change.

The owner explicitly noted that supported sites continually change. Maintain site-specific observed
markup fixtures and live smoke checks as recurring release work. This change does not introduce a
new remote-update architecture or promise permanent coverage.

Verification: focused content-script tests pass; deleting the production chip-protection call makes
the regression fail, with source restored byte for byte. Lint, typecheck and the full JavaScript
suite pass. Live public YouTube recovered to All, kept the construction query and 17 visible regular
videos, and held search requests at 4 for 12 seconds. Final bundle fixtures, independent review and
owner Safari verification are still required.
