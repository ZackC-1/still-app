# Concepts

> **Still 2.0:** All four blocking services and optional settings sync are free. Sign-in gates
> sync only. Both paid-tier flags are disabled. Purchase and entitlement descriptions below
> document retained infrastructure, not a requirement to use this release.

Shared domain vocabulary for this project — entities, named processes, and status concepts with
project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and
ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

Originally seeded from the July 16 monetization/release learning capture. The implementation
vocabulary formerly maintained in `CONTEXT.md` is consolidated below.

## Product and entitlement

<a id="surface"></a>

### Supported surface
A place where Still can remove short-form video: a supported website open in a supported browser.
*Avoid:* platform, everywhere

Surfaces are always web surfaces. Still does not act inside native apps, so "mobile support" means a
supported website opened in Safari, not the corresponding phone app. The set of surfaces is
deliberately finite and enumerated; claims about coverage say "every supported surface" and never
"everywhere," because the difference is a support burden and a review risk, not a style preference.

### Still Pro
The dormant paid tier: a one-time purchase, never a subscription, that historically extended Still beyond free
YouTube-Shorts removal to Reels removal, TikTok website blocking, and settings sync across surfaces.

In the retained paid model, Pro is a property of an Entitlement, not of an account: Apple receipt
ownership can work without an account, while an account carries entitlement between supported
surfaces. Current 2.0.0 access requires neither form of entitlement.

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

## Implementation vocabulary

A **supported surface** above describes where the product works. A **Surface** in rule-set data
below describes one authored blocking unit within a service. These are different levels of scope.
The entitlement lane entry describes the account/server path; the receipt path and stamp policy
are governed by [ADR 0003](docs/adr/0003-entitlement-authority-receipt-and-server.md).

- **Rule set** — the signed, versioned DATA describing what to block: services → surfaces →
  selectors/actions. Never code. The bundled **seed** (`packages/core/rules/seed.json`) is the
  trusted offline floor; fetched sets are Ed25519-verified against build-scoped trusted keys.
- **Surface** — one authored blocking unit under a service (e.g. `yt-home-shelf`), with an action
  (`hide`/`remove`/`redirect`/`placeholder`/`blockSite`) and a monetization `tier`.
- **Tier** — the ONE monetization axis (`free` | `pro`), authored per surface in the seed. With paid flags enabled, the
  engine gates by it, the CSS generator buckets by it, and service-row locking derives from it
  (`core/rules/tiers.ts`). In 2.0.0 those access gates are bypassed by the disabled paid flags.
  `requiredCapability` is reserved authored data, deliberately unread.
- **Rule-set loader** (`core/rules/loader.ts`) — the one extension wiring for the signed rule-set
  pipeline: background fetch → verify → cache; content applies the newest of {cached, bundled}.
  Shared by Safari, Chromium, and Firefox builds.
- **Engine** (`core/rules/engine.ts`) — pure decisions + DOM application. `applyDom` is the full
  hide+remove walk; **`applyRemovals`** is the per-mutation-frame fast path used when the packaged
  manifest CSS owns every hide surface (applied rule set = bundled seed).
- **Settings** (`StillSettings`) — global/per-service choices. Initial sync uses a guarded timestamp
  comparison; subsequent sync uses server-row version/timestamp/write-ID anchors and account isolation,
  as specified in [PRODUCT.md](docs/PRODUCT.md#settings-sync-and-account-safety). Client-writable;
  never carries entitlement. The legacy pause field does not expose a current pause feature.
- **Entitlement** — the server-authoritative "is this account Pro" bit (RevenueCat →
  `revenuecat-webhook` → Supabase `entitlements.still_sync` → reconcile). Reaches the Safari
  extension via the App-Group **entitlement lane** (StillKit `EntitlementBridge`), stamped with the
  last authoritative receipt/server confirmation time so the 30-day offline TTL is real. User-facing name: **Still Pro**;
  immutable internal id: `still_sync`.
- **Apple session orchestrator** (`core/sync/apple-session.ts`) — the tested auth/purchase/
  entitlement spine of the WKWebView app: sign-in exchange, double-charge + offline guards,
  pending-vs-authority purchase states, restore, Ask-to-Buy recheck, teardown parity. The
  app-webview entrypoint is thin wiring around it.
- **Extension UI factory** (`core/ui/extension-setup.ts`) — the one popup/options controller
  wiring every extension build shares. Purchase/auth capabilities are an OPTIONAL injection
  passed only by ext-chromium entrypoints — the uninjected default (Safari) stays purchase-free
  by construction (guideline 3.1.1).
- **Extension session orchestrator** (`core/sync/extension-session.ts`) — the apple-session
  mirror for Chrome/Firefox: background-owned Supabase session, OTP sign-in, reconcile→
  entitlement-record writes, web-checkout hand-off with a persisted checkout-pending lifecycle,
  nudge gating (24h staleness / 6h throttle), `resume()` from cached entitlement on worker wake,
  and one shared voluntary-teardown helper. The ext-chromium background entrypoint is thin
  wiring around it; entitlement reaches Chrome/Firefox through this lane the way the App-Group
  entitlement lane serves Safari.
- **App-Group bridge** — the Swift↔web↔extension seam on Apple: settings lane (`SettingsBridge`,
  sync metadata/epochs and local timestamp ordering) + entitlement lane (`EntitlementBridge`,
  app-written after receipt or server confirmation through `StampPolicy`). Safari reads entitlement;
  it does not become its authority.
- **Auth gate** (`supabase/functions/_shared/auth.ts`) — the one authenticated-request preamble
  every browser/app-called function wraps its body in (`withAuthenticatedUser`): OPTIONS preflight →
  POST-only → Bearer shape → `verifyJwt` (HS256/ES256 + defense-in-depth claims) → UUID subject.
  The subject UUID never comes from the request body (KTD5 IDOR defense); handler bodies receive
  only what the gate proved. `AuthDeps` is the shared auth slice per-function Deps extend.
- **Design contract** — the visual invariants every distributed UI host (extension popups/options,
  WKWebView app, native onboarding, docs pages) must share: self-hosted InterVariable, Still Blue,
  system dark mode, no CSS `zoom`. Enforced as file-content assertions in
  `core/ui/__tests__/design-contract.test.ts`, not manual parity review. Note "host" here — a
  rendered UI destination — is distinct from the rule-set **Surface** above (a blocking unit).
- **Hero card** — the global on/off card at the top of the shared core UI (`core/ui/App.svelte`).
  Its headline says whether Still is on; its secondary line states the current *outcome* and must
  stay truthful for the global and enabled-service state. Free 2.0.0 uses the all-service outcome;
  entitlement-specific copy remains dormant. The earlier paid-mode state-matrix lesson is retained in
  `docs/solutions/ui-bugs/free-tier-hero-copy-ignores-service-toggle.md`.
- **Install generation** — the per-install id the app stamps into the App Group on launch
  (StillKit `InstallGeneration`, idempotent) and returns inside every entitlement-lane reply. The
  Safari extension purges its cached entitlement only when the id it last saw CHANGES (reinstall
  detected — Safari's extension storage survives app deletion, issue #63); an absent/unreadable id
  is never a purge signal (offline never-downgrade), and a null `entitled` in the reply envelope is
  never read as entitled (it gates a paid feature). The marker key must never be bumped as a soft
  reset — every device would look reinstalled and mass-relock Pro; migrate the value forward instead.

## Usage analytics

Still's first-party product analytics: a closed event schema, no pages or videos, sent by one
serialized client per surface. These terms have precise meanings in that client and its hosts.

- **Install id** — the id of one installation of Still on one device, carried on every event as
  the device id. Made once and never changed. Distinct from **Install generation** above, which is
  the entitlement lane's reinstall detector.
- **Anchor id** — the anonymous person id shared across a person's installs through their own sync
  store (browser sync storage, iCloud), so signed-out use on two devices can still be one person.
  Never changed once made and never aliased; a sign-in's `$identify` is the only merge. After a
  sign-out the install reports under a fresh anonymous id rather than the anchor, so later use is
  not attributed to the account that signed out.
- **Confirmation** — the host establishing who is signed in (an account, or nobody) and telling the
  client, which installs that account, attributes every waiting event in storage, and only then
  allows sends. Until confirmed, events queue with no person and nothing leaves; a timeout never
  counts as confirmation. A confirmation that cannot be installed withdraws the previous one, and
  the client keeps the host's latest ask and retries it before the next send.
- **Forget** — a confirmation that the account is gone (deleted, or its session ended elsewhere):
  the account is recorded as forgotten before its queued events are dropped, the drop is verified,
  and no queued event is sent until it is done, in that process or the next. Asking to forget fences
  the account at once: the request in flight is abandoned and every send asked for before that
  moment sends nothing. Distinct from a plain sign-out, which keeps the account's queued events.
- **Quiet event** — an event recorded when a background wakes, which on the extensions usually
  means someone opened a supported site. It carries only its local day, not the moment, and does not
  trigger a send; it waits for the next ordinary send (a Still screen) or the randomly timed flush,
  so neither the event nor its arrival says when a site was visited.
- **Server attach** — the once-per-account server call that puts the signed-in account's email on
  its analytics person, made only from an ordinary (not quiet) moment with a confirmed account and
  sharing on. It never changes the account, re-checks the account after every awaited read, and
  records completion per account so it is not repeated.
- **Pending install** — the local record that an install (or update) happened while sharing was
  off or unreadable, kept so it can still be counted on its real day once sharing allows, and
  cleared only after every milestone it stands for has been queued.
