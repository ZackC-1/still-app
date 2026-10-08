# Still v3.1 design system

This document governs the next Still implementation using the latest owner-supplied archive, internally version3.0.1. Earlier V3 visual references are superseded. The reference home is [Still v3.1 redesign](docs/design/Still%20v3.1%20redesign/README.md), with [145 indexed previews](docs/design/Still%20v3.1%20redesign/screens.md), [source handoff](docs/design/Still%20v3.1%20redesign/source/handoff/HANDOFF.md), [coverage ledger](docs/design/Still%20v3.1%20redesign/coverage.md), and [facts still requiring proof](docs/design/Still%20v3.1%20redesign/unresolved.md).

## Authority and implementation

Read reference HTML, tokens, component type contracts and handoff together. Scaled PNG previews aid orientation; generate exact baselines from rendered HTML. Reference demos, mock authentication, simulated success, React/Babel, galleries and native-sheet framing remain outside production bundles. Use the existing Svelte5 screens, lazy host loaders and native StoreKit/rating sheets. Host adapters provide real state/actions; screenshots cannot establish functioning backend support.

Use the actual screen composition when a standalone Gallery example has a different context. The D01 section heading cascade differs from the context-free Gallery card; D03 compact Pro cards omit the full control list, while D18 supplies the complete capability-filtered list. Safari popups use their specified app destination. Preserve these existing screen choices rather than inserting a Gallery specimen into the application. Approved D18 pricing stays in provider checkout; demo prices and failed checkout callbacks cannot establish a usable product offer. Reference focus examples may show several decorative rings; an actual interaction has one keyboard focus target. Record remaining raw comparison failures without changing accepted pixels or claiming they passed.

Retain the product truths in [STRATEGY.md](STRATEGY.md) and [docs/PRODUCT.md](docs/PRODUCT.md). Free YouTube Shorts and Instagram/Facebook Reels removal and TikTok website blocking require no account. Sign-in enables optional free settings sync. The twelve optional Pro extras cannot gate those outcomes. Still operates on supported websites, including Safari on Apple mobile devices; it does not block native social apps. Use "every supported surface" for accurate scope.

## Foundation

Use [CSS/JSON tokens](docs/design/Still%20v3.1%20redesign/source/tokens/tokens.json) and [foundation guidelines](docs/design/Still%20v3.1%20redesign/source/guidelines). Current font/color/spacing/typography token files already match this archive. Keep one token authority and verify emitted assets before deleting legacy paths. Inter variable font is352,240bytes with its supplied OFL license. Service and mark SVGs are reference artwork. The supplied PNG wordmark is corrupt; use a verified central brand asset and record the substitution.

Popups use380px desktop reference width; desktop content caps at600px. Settings use432px reference columns and remain usable at320px and actual supported host widths. Touch targets are44px. Bind system text size using the existing measured CSS ratio and verify1/1.35/1.5/2 scales. Preserve light/dark, safe areas, reduced motion, keyboard order, discoverable unavailable controls and screen-reader names. Dialogs require safe initial focus, Tab containment, Escape and focus return. Settings/popups use compact title-only headers without a logo bar.

## Settings, blocking and access

Treat saved choice, current capability and current access as separate facts. Global or service Off greys related controls while retaining choices. Unsupported features preserve saved choice without offering an operable switch. Keep accordion behavior/local memory from the handoff. Verify each supported service against actual website fixtures and device journeys.

Free rows are Shorts/Reels removal. Pro extras default Off on new installs:

| Service | Optional extras |
|---|---|
| YouTube | Related videos, end suggestions, autoplay, comments, live chat |
| Instagram | Stories/highlights, suggested posts, Explore, Threads |
| Facebook | Stories, Videos/Watch, sidebar ads |

TikTok blocking covers its website service. Temporary allowance is a separate confirmed current-tab action and never becomes a saved/synced preference.

Checking or verification-required access must not show price, Buy or misleading locked rows. Restore pending/failure is distinct from no purchase. Valid local Apple access survives optional linking failure. Expiry/refund/revocation removes only affected rights while choices and free blocking/sync continue. Preserve historical and protected/free-period rights; no purchase or production sales activation is inferred from a redesign.

## Navigation and purchase

Browser locks navigate to the real offer in settings. Safari locks say Still Pro/See Still Pro and open the Still companion app; Safari popup must not show price/Buy. Feature lock accessible names identify the feature and appropriate destination. Remove old paywall-sheet adaptations once the actual destinations are bound.

Apple purchase uses real localized StoreKit/RevenueCat offers and native sheets. A Still account is optional for local Apple purchase. Linking/transfer is explicit and authorized for the intended account; ordinary free sign-in must not silently attach purchase ownership in V3. Restore communicates owned, nothing found, error and verification states accurately.

Web purchase requires a confirmed account and approved managed-only provider support. Provider checkout owns payment entry. D20 is an actual return route bound to immutable account/environment/offer context. Server-confirmed ownership establishes success; a query parameter, closed tab or provider success text does not. Use sandbox/test modes for QA and preserve environment trust isolation.

## Account, privacy and invitations

Settings show actual account confirmation and sync/recovery/sign-out operations. Account deletion confirmation remains scoped to the account the user selected. Account deletion and analytics erasure are separate outcomes; show requested/pending/completed only when supported by actual response/readback. Real help/setup destinations replace archive placeholders. iOS permission uncertainty must remain truthful.

Combined email-plus-usage consent uses equal Share/Don't share actions with verified purposes/providers. Permission is per-device, explicit and fresh for this question. Old consent answers, sign-in, purchase or linking never grant it. Decline/withdrawal fences identity and queued reporting immediately. New analytics events require the existing privacy review; collect no browsing history or page/video/search data.

At most one invitation appears. Sync/linking takes precedence over rating. Rating eligibility uses7days and3used days, once/install and actual owner allowance. Suppress invitations during setup, consent, errors, purchase or Restore. Keep native rating APIs rather than drawing simulated platform sheets.

## Screen contract and QA

| Family | Required integration |
|---|---|
| D01/D02 | Actual local blocking/settings, access/capability, sync recovery, destination navigation |
| D03/D04 | Account, Pro/Restore/link, setup/help, combined consent, deletion outcomes |
| D12/D14 | Real activation, optional sign-in/consent, completion/pinning persistence and relaunch |
| D18–D20/D24/D25 | Native or managed test purchase, confirmation/recovery, Restore and explicit linking |
| D28 | Actual eligibility/allowance, priority, suppression and once-per-install persistence |
| D29 | Extension-owned block page, confirmed tab allowance and lifecycle |
| Gallery/store | Primitive interaction/accessibility and actual candidate-supported release framing |

For each family, record reference, live entry, authority, happy/failure/recovery outcomes, accessibility, artifact revision/configuration and evidence in the coverage ledger. Component fixtures complement real host/provider/device journeys. Same-engine exact captures use the handoff0.5% pixel difference threshold; native and Firefox rendering need their own platform evidence. Missing baseline inventory fails the redesign release gate.

Keep reference PNGs/HTML/Babel/tooling outside runtime imports. Measure total download, popup initial JS/CSS, cold-open/render, settings/native startup and content observer overhead using comparable profiles. Preserve lazy settings/purchase/onboarding boundaries and avoid duplicated encoded artwork.

Delivery follows [the implementation plan](docs/plans/2026-10-07-1118-feat-still-v31-redesign-plan.md): isolated workers, real Claude PR reviews (or the owner-authorized Muse Spark fallback after unsuccessful Claude reviews), valid fixes, relevant repository/backend/native checks, protected merges and exact QA artifacts. Apple device testing uses TestFlight/sandbox and the existing hosted backend with dedicated test accounts and verified sandbox fulfillment; local loopback QA does not satisfy physical-device connectivity. Outstanding provider/device gates remain unfinished work.
