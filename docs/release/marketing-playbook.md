# Still 2.0 growth and release messaging

Updated September 14, 2026. The current goal is to grow adoption with a free app. This replaces the
paid-conversion launch plan, which remains available in Git history.

## Objective order

1. Qualified downloads: show exactly which websites and browsers Still supports.
2. Successful activation: users enable blocking without a purchase or account.
3. Continued use: blocking is reliable, regular content stays useful, and optional free sync is clear.
4. Trust: website, store listing, screenshots, support, and actual installed behavior agree.

Use store dashboards, the PostHog "Still growth" dashboard and categorized support feedback.
Product analytics (Still 2.1, [ADR 0004](../adr/0004-first-party-usage-analytics.md)) never includes
pages, videos or searches, and is never used for advertising. Do not promise permanent free pricing.

## Message order

- Homepage outcome: “Do what you came to do.” Preserve the owner-approved wording; store drafts and owner-edited portal descriptions are distinct.
- Proof: remove YouTube Shorts and Instagram/Facebook Reels; block the TikTok website.
- Price and account: all free in Still 2.0, with no account or purchase needed for blocking.
- Optional continuity: sign in to sync settings for free across supported surfaces.
- Mobile boundary: on iPhone and iPad, Safari websites only; native social-media apps are unaffected.

Regular YouTube, Instagram, and Facebook content remains usable. Avoid saying that every part of
all four sites stays available: the TikTok website is blocked.

Use [canonical store copy](store-listing-copy.md) and [public contacts](public-contact-addresses.md).
Homepage and guide sources live directly under `docs/`; the live site deploys from `gh-pages`.

## Assets and publication

Capture the exact 2.0 candidate for every store. Show the real free UI, the enable/permission steps,
all four services, optional sync, and the Safari-only mobile boundary. Use the current
[functional screenshot manifest](screenshots/store-ready/README.md); paid-era assets were removed
or retained only as explicitly labeled history. Preserve owner-approved Apple screenshots already
submitted. Regenerating captions alone does not make an old app screenshot current.

The website sharing image must use the same free 2.0 language. Preserve brand assets that have no
outdated product claims. The old launch video ends with a $1.99 Pro claim and is removed from the 2.0 homepage.
Do not reuse it in store uploads or campaigns; the brand-only poster remains suitable.

The owner approved the current website publication, direct store links and versionless homepage
branding, and removed homepage rollout notices. Preserve that decision and exact supplied homepage
copy. Broad promotion waits for Apple/Chrome rollout; verify each public download/listing before
starting a campaign. Secondary-page scope and rollout notes remain as recorded in the release status.
Do not restore removed homepage notices during a documentation refresh.

Provider privacy, device testing, portal pricing, fresh screenshots, and store submission are tracked
in the [release runbook](README.md). Updating this document does not complete those gates.

## Earlier buyers

Still 2.0 needs no purchase restore. Keep support available for earlier receipts and refunds.
Apple handles Apple purchase refunds under its policies. Previous web purchases have the approved
14-day refund window; the same wording belongs in Terms and support. Public contacts are
support@stillapp.fit, privacy@stillapp.fit, and hello@stillapp.fit.
