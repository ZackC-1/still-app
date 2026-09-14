# Still 2.0.0 release runbook

Start with [September 14 release status and owner decisions](2026-09-14-release-status.md).
It records the latest known store observations, source/website integration, completed owner checks,
accepted privacy policy and remaining certification. Portal state must be checked live before action;
a dated record is not a claim of current approval.

Still removes YouTube Shorts and Instagram/Facebook Reels and blocks the TikTok website for free.
Blocking works without an account; optional email-code sign-in enables free settings sync.
On iPhone/iPad, Still works in Safari websites, not native social apps. See [PRODUCT.md](../PRODUCT.md).

## Current release boundaries

- The owner submitted Apple iOS/macOS 2.0.0 build 8 and Chrome 2.0.0 for review; Firefox 2.0.0 was
  verified public. Preserve exact submitted packages, source archives and owner-edited portal text.
- Website changes are published separately from `gh-pages`. The current site describes free Still;
  the owner will wait for the store rollout before broad promotion.
- Issues #149–#152 were completed and closed. Migration 0013, reviewed Edge revisions and the
  later review-sign-in logging update were deployed. The approved retention policy was published.
- Existing Mac/iPhone tests remain credited to their actual scope. Physical iPad is explicitly
  skipped/unverified under the owner's accepted exception; do not request that unavailable device again.
- Issue #153 remains for hosted disposable-account lifecycle evidence and final certification.
  Synthetic tests, a package upload and public availability are separate kinds of evidence.

## Tracks and references

| Track | Reference |
|---|---|
| Apple iOS/macOS + Safari | [Apple runbook](01-apple-app-store.md): submitted build provenance, free reviewer flow, legacy IAP presentation and manual release. |
| Chrome desktop | [Chrome runbook](02-chrome-web-store.md): configured ZIP, free listing/privacy and public verification. |
| Firefox desktop | [Firefox runbook](03-firefox-amo.md): complete reproducible sources, consent declaration and publication boundary. |
| Mobile Safari | [Mobile validation](06-mobile-blocking-validation.md): expected behavior and exact evidence boundaries. |
| RevenueCat | [Retained infrastructure](04-revenuecat.md): identity/receipt/webhook continuity; paid gates remain disabled. |
| Auth and reviewer access | [Account/reviewer reference](extension-purchase-deploy-checklist.md): OTP and private fixed-code configuration. |
| Backend retention | [Counter runbook](counter-retention.md): current behavior, safe maintenance and recovery. |
| Marketing and assets | [Listing drafts](store-listing-copy.md), [screenshot manifest](screenshots/store-ready/README.md), [public contacts](public-contact-addresses.md). |
| Evidence | [Validation index](VALIDATION.md), [September 8 historical candidate](2026-09-08-still-2-certification.md), [September 11 contact candidate](2026-09-11-public-contact-update.md). |

## Next release actions

1. Check Apple/Chrome review state. After approval, complete the selected publication steps and
   verify each public version, free-feature wording, screenshots and download destination.
2. Complete or locate hosted disposable-account seed/switch/export/delete/re-create evidence for
   #153. Use only approved disposable accounts; preserve already-completed user tests.
3. Keep physical iPad coverage marked skipped/unverified. Check email capacity before promotion.

Do not rebuild or resubmit solely to align Git. Current source's Apple build default is 7, while
submitted Apple artifacts are build 8. A future new build needs a deliberate unused number,
frozen source/configuration and its own hashes/tests. Later documentation/dependency commits do
not retroactively become the source of submitted binaries.

## Stable identifiers

| Item | Value |
|---|---|
| Apple app / extension | `com.chartash.still` / `com.chartash.still.Extension` |
| App Group / team | `group.com.chartash.still` / `UM9HVDH3P3` |
| Firefox add-on | `still@chartash.com` |
| Retained entitlement / Apple product | `still_sync` |
| Retained web product | `still_sync_web` |
| Website host permissions | YouTube, Instagram, Facebook and TikTok only |

No Android or native social-app blocking is advertised. Historical runbooks remain in
[the reference archive](../archive/pre-2.0-reference-refresh/README.md) and dated records retain
original observations. They do not override current behavior or reopen completed gates.
