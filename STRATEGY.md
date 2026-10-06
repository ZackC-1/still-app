# Still strategy

Status: product-direction source of truth  
Owner: Cadmus Labs  
Last reviewed: 2026-10-06 (V3 commercial direction incorporated; 2.x remains the shipped release)

This document gives every human and coding agent the same product direction. It explains what Still
is trying to achieve and which promises must survive implementation details, store constraints, and
short-term experiments. It does not replace the product specification, architecture map, ADRs, or
release runbooks.

## Mission

Still gives people a quieter web by removing the invitations into short-form video while preserving
the useful parts of the sites they intended to visit.

The desired future state is not "more blocking controls." It is opening YouTube, Instagram, Facebook,
or TikTok for a purpose, doing that thing, and leaving without being pulled into an accidental scroll.

## Product position

Still is:

- A focused short-form-video remover for supported websites.
- Calm infrastructure that makes distracting surfaces feel absent.
- Free core in every release: YouTube Shorts, Instagram and Facebook Reels removal, and TikTok website blocking.
- Usable without an account, with optional free sign-in for cross-device settings sync.
- Still Pro (V3 direction): twelve optional extras behind a one-time $9.99 lifetime purchase. Free core never requires it.
- Privacy-conscious by design, with narrow host access and no browsing-history collection.

Still is not:

- A general-purpose website blocker, ad blocker, parental-control product, or accountability system.
  TikTok is the specific whole-website block among the four supported services.
- A timer, streak, shame loop, hard lock, or willpower test.
- A native-app blocker on iPhone or iPad.
- A promise to work on every device, browser, or surface without qualification.

## Objective order

1. **Qualified downloads.** Attract people who understand the supported surfaces and want the free
   blocking outcome across the four supported services.
2. **Successful activation.** Help them enable the extension and experience blocking without an account
   or purchase.
3. **Continued use.** Make blocking reliable and settings understandable. Offer free sync when users
   want their choices to follow them across supported devices.
4. **Durable trust.** Minimize refunds, scope-related support, privacy surprises, and inconsistent
   claims across product, website, and stores.
5. **Operational learning.** Convert verified launch, architecture, security, and support lessons
   into repository knowledge so each iteration starts smarter.

Raw install volume must never be optimized by hiding the mobile boundary (websites in Safari on
iPhone and iPad, and in Firefox on Android) or implying native-app blocking. A smaller group of
correctly informed users is more valuable than mismatched downloads that generate refunds and
negative reviews.

## Commercial model

| Feature | User outcome | Account requirement |
|---|---|---|
| Free blocking | Removes YouTube Shorts and Instagram/Facebook Reels; blocks the TikTok website. | None. Settings can remain local. |
| Free settings sync | Carries Still settings across supported browsers and devices. | Optional email sign-in on the devices to sync. |
| Still Pro (V3) | Twelve optional extras (Related videos, end-of-video suggestions, autoplay prevention, comments hiding, live chat hiding, Explore, Stories/Highlights, suggested accounts, Threads links, Facebook Stories/Videos/sidebar ads), fresh installs Off. | Purchase required; one qualifying purchase covers supported surfaces via the approved Restore flow. |

Still 2.x shipped free to grow adoption, with both paid-tier flags disabled. The V3 direction,
approved in [D514](docs/release/history/v3/README.md), activates paid behavior deliberately:
a $9.99 US-base one-time lifetime Pro offer with a seven-day voluntary web refund window
(Apple purchases follow Apple's refund process). This replaces the standing "do not enable paid
behavior" guard for V3 preparation only; 2.x artifacts in review or in the stores keep their
free behavior and must not gain paywalls through documentation or tooling commits.
The immutable entitlement identifier remains `still_sync`; it is not a blocking or sync
requirement. Preserve old product IDs and historical mappings; verified legacy payments map
to frozen Pro and zero/free-era use maps to frozen released-free protection.

## Supported-surface truth

| Surface | Launch behavior |
|---|---|
| Chrome and Chromium browsers on desktop | Free WebExtension blocking and optional free settings sync. |
| Firefox on desktop | Free WebExtension blocking and optional free settings sync. |
| Safari on iPhone and iPad | Safari Web Extension inside the Still container app. |
| Safari on Mac | Safari Web Extension inside the Still macOS app. |
| Firefox on Android (V3, evidence-gated) | Free WebExtension blocking on websites, from V3 builds only. |
| Native social-video apps | Not supported. Still cannot remove video inside the native YouTube, Instagram, Facebook, or TikTok apps. |

Any new surface must earn its way into this table through implementation, verification, privacy
review, store approval, and updated messaging.

## Experience principles

- **Sell the calm state, prove it with concrete scope.** Lead with the feeling of being free to leave;
  immediately support that promise with the exact surfaces Still removes.
- **Value without a gate.** All blocking works without a purchase or account.
- **Remove the invitation, preserve the site.** Regular YouTube, Instagram, and Facebook content
  should remain useful; the TikTok website is blocked.
- **Quiet, not gamified.** No attention dashboards, celebratory streaks, guilt, or pressure.
- **Free core, paid extras.** Blocking and sync never require a purchase or account. Still Pro extras are optional and clearly sold, never gating the free outcome. Do not promise permanent pricing.
- **Disclose at the decision point.** Mobile Safari and native-app limitations belong near download
  calls to action, not only in legal copy.
- **Private by construction.** Still never records the pages, videos or searches people view. Product
  analytics (from 2.1) uses a closed event schema, no fingerprinting and a per-device off switch,
  and is never used for advertising ([ADR 0004](docs/adr/0004-first-party-usage-analytics.md)).

## Messaging hierarchy

1. Future state: “Do what you came to do” (owner-approved homepage heading).
2. Immediate proof: Shorts and Reels disappear, and the TikTok website is blocked, all for free.
3. No barrier: blocking needs no purchase or account.
4. Continuity: optional free sign-in syncs settings across supported surfaces.
5. Optional depth (V3): Still Pro adds twelve extras for a one-time payment; the free outcome above never requires it.
5. Boundary: on mobile, Still works in Safari websites and not inside native social apps.

Canonical store copy and asset instructions live in
[`docs/release/marketing-playbook.md`](docs/release/marketing-playbook.md) and
[`docs/release/store-listing-copy.md`](docs/release/store-listing-copy.md). Do not create competing
canonical copy inside implementation plans or handoffs.

## Architecture and trust principles

- Keep the rule engine shared and platform shells thin.
- Treat remote rule updates as signed data, never executable code.
- Keep entitlement server-authoritative and separate from client-writable settings.
- Keep free behavior useful offline and require sign-in only for account-backed functionality.
- Limit host permissions to the supported services; never request `<all_urls>` by default.
- Prefer explicit typed outcomes across platform boundaries over matched strings.
- Preserve testable decision logic outside UI and platform framework glue.
- Mirror security and correctness fixes across parallel purchase, auth, and platform paths.

The current behavior specification is [`docs/PRODUCT.md`](docs/PRODUCT.md).
The original v1 specification is historical and does not override the free release.
The current runtime map is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Accepted architectural
decisions live in [`docs/adr/`](docs/adr/), and implementation learnings live in
[`docs/solutions/`](docs/solutions/). Per-release records (plans, build plans,
screenshots, release files by version) live in [`docs/release/history/`](docs/release/history/);
the [V3 record](docs/release/history/v3/README.md) carries the approved Pro direction.

## Launch posture

The current store and deployment state is operational data and changes frequently. Consult
[`docs/release/README.md`](docs/release/README.md) and verify
live portals before acting.

While a store submission is pending, do not replace a build, edit locked assets, or resubmit merely
to align documentation or another platform. Record the discrepancy and wait unless the reviewer or
a verified launch blocker requires action.

## Success signals

- A user successfully enables Still and observes free blocking on their chosen supported websites.
- Store visitors understand the product before installing.
- Users can keep blocking without an account and choose free settings sync when useful.
- Refunds, uninstall reasons, reviews, and support requests do not reveal a recurring scope mismatch.
- Store listing, website, in-product copy, privacy declarations, and support guidance tell the same
  product truth.
- Reusable engineering and operational lessons are captured in `docs/solutions/` and remain current.

Use store dashboards, the PostHog "Still growth" dashboard and categorized support feedback.
Any new analytics event or property must be reviewed against Still's privacy promise and ADR 0004
before implementation, and the privacy policy and store declarations updated with it.

## Decision hierarchy

When repository documents disagree, use this order and fix the stale lower-level document:

1. Verified current behavior, tests, and live external state.
2. This strategy for product direction and promises.
3. Accepted ADRs and current product specifications.
4. Current architecture and release runbooks.
5. Active approved implementation plans.
6. Durable solution documents.
7. Handoffs, brainstorms, archived plans, and chat transcripts.

Escalate a decision when it would change the mission, commercial model, privacy posture, supported-
surface promise, or objective order. Agents may make local implementation decisions inside those
guardrails but must document durable architectural choices.
