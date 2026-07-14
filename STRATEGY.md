# Still strategy

Status: product-direction source of truth  
Owner: Cadmus Labs  
Last reviewed: 2026-07-14

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
- Free for the clearest first win: removing YouTube Shorts.
- A one-time paid upgrade for broader removal and settings continuity across supported surfaces.
- Privacy-conscious by design, with narrow host access and no browsing-history collection.

Still is not:

- A whole-site blocker, ad blocker, parental-control product, or accountability system.
- A timer, streak, shame loop, hard lock, or willpower test.
- A native-app blocker on iPhone or iPad.
- A promise to work on every device, browser, or surface without qualification.

## Objective order

1. **Qualified downloads.** Attract people who understand the supported surfaces and want the free
   YouTube Shorts outcome.
2. **Successful activation.** Help them enable the extension and experience that free outcome before
   asking them to pay.
3. **Still Pro conversion.** Explain the broader result and one-purchase portability at the moment a
   user expresses intent for a locked service.
4. **Durable trust.** Minimize refunds, scope-related support, privacy surprises, and inconsistent
   claims across product, website, and stores.
5. **Operational learning.** Convert verified launch, architecture, security, and support lessons
   into repository knowledge so each iteration starts smarter.

Raw install volume must never be optimized by hiding the Safari-only mobile boundary or implying
native-app blocking. A smaller group of correctly informed users is more valuable than mismatched
downloads that generate refunds and negative reviews.

## Commercial model

| Tier | User outcome | Account requirement |
|---|---|---|
| Free | YouTube Shorts surfaces are removed on supported websites. | None. Settings remain local. |
| Still Pro | Instagram and Facebook Reels are removed, the TikTok website is blocked, and settings sync across supported surfaces. | Same-email sign-in is required for sync and cross-surface restoration. |

Still Pro is a $1.99 USD one-time purchase. The immutable internal entitlement identifier is
`still_sync`. Apple uses a non-consumable in-app purchase; supported browser extensions use
RevenueCat Web Billing. Both paths resolve to the same RevenueCat entitlement.

The approved promise is: **one purchase, every supported surface, using the same Still account.**

## Supported-surface truth

| Surface | Launch behavior |
|---|---|
| Chrome and Chromium browsers on desktop | WebExtension blocking and optional Pro sign-in/purchase. |
| Firefox on desktop | WebExtension blocking and optional Pro sign-in/purchase. |
| Safari on iPhone and iPad | Safari Web Extension inside the Still container app. |
| Safari on Mac | Safari Web Extension inside the Still macOS app. |
| Native social-video apps | Not supported. Still cannot remove video inside the native YouTube, Instagram, Facebook, or TikTok apps. |

Any new surface must earn its way into this table through implementation, verification, privacy
review, store approval, and updated messaging.

## Experience principles

- **Sell the calm state, prove it with concrete scope.** Lead with the feeling of being free to leave;
  immediately support that promise with the exact surfaces Still removes.
- **Value before upgrade.** The free YouTube result should be observable before the primary Pro ask.
- **Remove the invitation, preserve the site.** Normal videos, posts, messages, and pages should
  remain useful.
- **Quiet, not gamified.** No attention dashboards, celebratory streaks, guilt, or pressure.
- **One understandable purchase.** No subscription language and no fragmented platform upgrades.
- **Disclose at the decision point.** Mobile Safari and native-app limitations belong near download
  and purchase calls to action, not only in legal copy.
- **Private by construction.** Do not add behavioral analytics merely to make a dashboard easier.

## Messaging hierarchy

1. Future state: open for what you came for and leave when you are done.
2. Immediate proof: YouTube Shorts disappear for free.
3. Paid expansion: Still Pro quiets Reels and TikTok and syncs settings.
4. Portability: purchase once and use the same Still account across supported surfaces.
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

The current runtime map is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Accepted architectural
decisions live in [`docs/adr/`](docs/adr/), and implementation learnings live in
[`docs/solutions/`](docs/solutions/).

## Launch posture

The current store and deployment state is operational data and changes frequently. Consult
[`docs/release/launch-progress-2026-07-13.md`](docs/release/launch-progress-2026-07-13.md) and verify
live portals before acting.

While a store submission is pending, do not replace a build, edit locked assets, or resubmit merely
to align documentation or another platform. Record the discrepancy and wait unless the reviewer or
a verified launch blocker requires action.

## Success signals

- A user successfully enables Still and observes the free YouTube outcome.
- Store visitors understand the product before installing.
- Locked-service intent progresses through Pro explanation, sign-in, checkout, entitlement, and
  restoration without ambiguity.
- Refunds, uninstall reasons, reviews, and support requests do not reveal a recurring scope mismatch.
- Store listing, website, in-product copy, privacy declarations, and support guidance tell the same
  product truth.
- Reusable engineering and operational lessons are captured in `docs/solutions/` and remain current.

Use store dashboards, purchase state, and categorized support feedback for the initial baseline.
Any future analytics proposal must be reviewed against Still's privacy promise before implementation.

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
