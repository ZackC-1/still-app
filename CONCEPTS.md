# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with
project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and
ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

> Seeded 2026-07-16 from a monetization/release learning capture, so it currently covers only that
> area. A repo-wide pass over the rest of the domain (blocking engine, sync, extension surfaces)
> belongs to `ce-compound-refresh`.

## Product and entitlement

### Surface
A place where Still can remove short-form video: a supported website open in a supported browser.
*Avoid:* platform, everywhere

Surfaces are always web surfaces. Still does not act inside native apps, so "mobile support" means a
supported website opened in Safari, not the corresponding phone app. The set of surfaces is
deliberately finite and enumerated; claims about coverage say "every supported surface" and never
"everywhere," because the difference is a support burden and a review risk, not a style preference.

### Still Pro
The paid tier: a one-time purchase, never a subscription, that extends Still beyond free
YouTube-Shorts removal to Reels removal, TikTok website blocking, and settings sync across surfaces.

Pro is a property of an Entitlement, not of an account — it can be bought and used with no account at
all on Apple platforms. An account only becomes necessary to carry Pro *between* surfaces.

### Entitlement
The fact that Pro is unlocked, together with where that fact came from.

An Entitlement has a source, and the source determines who can revoke it and how quickly a change
propagates: a purchase receipt on the device is self-contained and works signed out, while a
server-held entitlement is tied to an account and can travel between surfaces. The same purchase can
be represented by both. Because a device-held Entitlement is trusted for a bounded window rather than
re-proven continuously, revocation is eventually consistent — a refund is not instantaneous
everywhere, and that staleness is an accepted, documented bound rather than a defect.

### Review Sign-In
A sign-in path that accepts a fixed, pre-agreed verification code for one designated address, so an
App Store reviewer can exercise account features without receiving email.

It exists because the normal sign-in emails a one-time code, and a reviewer cannot read the mailbox it
goes to — an untestable feature reads to a reviewer as a broken one. The mechanism is deliberately
narrow and fails closed: it is scoped to a single address, is disabled entirely when its configuration
is absent, refuses unknown addresses indistinguishably from unconfigured ones, and sends no email on
this path. It is expected to be retired once the review that needs it concludes; leaving it live past
that is a standing risk, not a convenience.
