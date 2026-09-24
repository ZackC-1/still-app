# Still product specification — 2.0.0

Status: current reference. Reviewed September 14, 2026 against source and the owner's release
decisions. [STRATEGY.md](../STRATEGY.md) defines product direction;
[the release record](release/2026-09-14-release-status.md) distinguishes submitted artifacts,
public availability and verification. This specification describes behavior, not store approval.

## Included functionality

Still removes short-form video from supported websites. All four services and optional settings
sync are free in this release. Blocking requires neither an account nor a purchase. There is no
promise of permanent pricing.

| Service | Behavior while enabled |
|---|---|
| YouTube | Remove Shorts shelves and entry points; open direct Shorts links in the normal watch player. Preserve ordinary videos, search and navigation. |
| Instagram | Remove Reels surfaces and block direct Reels routes. Preserve ordinary posts and messages. |
| Facebook | Remove Reels surfaces and block direct Reels routes. Preserve ordinary posts and messages. |
| TikTok | Block the whole website, including its web profiles and messages. The native app is unaffected. |

Controls consist of a global switch and one switch per service. A fresh install defaults to all
four services enabled. Choices persist locally and are read without waiting for the network.
The previous pause-on-this-site UI is removed; the legacy `pauses` field remains compatible storage
data and is normalized/ignored by current blocking. There are no per-surface user toggles, timers,
schedules, counters or hard locks. Users can disable Still or revoke its website permissions.

## Supported installations

| Installation | Scope |
|---|---|
| Chrome/Chromium extension | Desktop websites; Chrome Web Store package. |
| Firefox extension | Desktop websites; separate Firefox build from the same WXT project. |
| Still for Mac | Native container app and Safari Web Extension. |
| Still for iPhone/iPad | Native container app and Safari Web Extension; websites opened in Safari only. |

Install Still separately on every browser/device. The Apple app does not install the Chrome or
Firefox extensions. There is no Android app or Google Play artifact; mobile Chrome/Firefox and
native YouTube, Instagram, Facebook and TikTok apps are outside this release's support scope.

Source deployment targets are iOS/iPadOS 15.0 and macOS 12.0. The Firefox manifest sets desktop
`strict_min_version: 140.0` and omits `gecko_android`. A deployment target or supported-platform
claim is not proof that each OS/device combination was physically tested. Physical iPad coverage
is explicitly skipped/unverified under the owner's accepted exception.

## Setup and optional account

1. Install the appropriate store package. On Apple, enable Still's Safari extension and allow
   access to the supported websites. Follow [setup](https://stillapp.fit/setup/).
2. Use the global and service switches. No account or payment screen is required.
3. Optionally sign in with the same email address on installations whose settings should sync.
   The documented cross-platform path uses an emailed six-digit code. Do not describe Google
   sign-in or a magic-link click as the current shared sign-in flow.
4. The account view reports sync state and supports sign-out and account deletion. Data-export
   requests go to `privacy@stillapp.fit`; an authenticated export endpoint exists, but the product
   does not promise a visible export button.

The Apple native Sign in with Apple integration is retained in source; it is not a requirement to
activate blocking or the same-email sync instructions. Review-only fixed-code sign-in is restricted
to the privately configured reviewer address. Ordinary users receive normal OTP email.

## Settings sync and account safety

One settings document belongs to each Supabase account UUID; there is no separate desktop/mobile
profile. Entitlements are separate from settings and never accepted from client-writable preferences.
Migration `0012_profiles_write_free_sync.sql` allows authenticated users to sync without an entitlement.

Initial account reconciliation is deliberately more precise than “latest device clock wins”:

| Situation | Result |
|---|---|
| Empty account; local settings have never belonged to another account | Seed the account from this device. |
| Empty account; the device retains another account's identity or a prior cloud anchor | Start from Still's defaults, preventing cross-account copying. |
| Existing account; another person last synced here | Adopt the account's settings. |
| First sync with an existing account; no cloud anchor | A believable strictly newer local timestamp may win; ties, invalid/future local timestamps and unreadable server timestamps go to the account. |
| Previously synced device | Compare the saved complete server-row state. Publish local edits only if the account has not advanced; otherwise adopt the account. |

The server stamps accepted writes with a timestamp, version and write ID. Realtime updates,
local storage notifications and the Apple App Group bridge propagate changes to active contexts.
Failed uploads retry with bounded backoff and recover on reconnect; an old acknowledgement must
not overwrite a newer local edit. A displayed last-sync time means an exchange with the account,
not confirmed delivery to every device.

Sign-out stops this installation's sync and clears its local session, including when remote
revocation fails; it does not deliberately sign out other devices. Local blocking continues.
The last-synced-account marker survives sign-out/deletion to prevent settings leaking between users.
Session-lifecycle guards discard delayed work from a previous sign-in, including A → B → A changes.
Offline blocking continues from local settings and trusted rules; syncing needs connectivity.

## Retained purchase infrastructure

`PAID_TIER_ENABLED` and `MonetizationConfig.paidTierEnabled` are both `false`. Purchase/restore UI
and actions are dormant. Receipt checks, RevenueCat identity, historical entitlements and webhook
processing remain present. An entitlement, purchase restore or RevenueCat response is not needed
for free blocking or sync. Do not grant fake Pro entitlements to implement free access.

Keep the internal `still_sync` entitlement/Apple product and `still_sync_web` web product identities.
Apple configures RevenueCat anonymously, then uses the Supabase UUID for account identity;
browser extensions do not initialize a RevenueCat SDK. The Apple product's zero-price observation
is recorded separately from the disabled client gates and from app-download pricing in the
[dated release record](release/2026-09-14-release-status.md#store-snapshot).

See [retained monetization design](monetization-design.md) and
[ADR 0003](adr/0003-entitlement-authority-receipt-and-server.md). Future monetization requires an
explicit product decision, coordinated client/server/store changes and fresh verification.

## Privacy and operations

Blocking executes on-device; Still does not collect browsing history. Host permissions are limited
to YouTube, Instagram, Facebook and TikTok. Configured clients may fetch signed rule data, and
optional account use sends authentication/settings data. The retained Apple RevenueCat SDK and
service-provider logs mean “nothing ever leaves the device when signed out” is not a valid claim.

From 2.1, usage analytics goes to PostHog under [ADR 0004](adr/0004-first-party-usage-analytics.md):
installs and updates by store, returning installs, setup, toggles, the sign-in funnel and active
days. Nothing about the sites people visit is ever sent: no page, video, search or visit. It starts on
with a one-time notice and a per-device **Share usage data** switch on Chrome and the Apple apps
(the Safari extension follows the app); Firefox sends nothing until its optional
`technicalAndInteraction` permission is granted. Signed-in usage is linked to the account, and the
server attaches the email. Account deletion also deletes the PostHog person and events.

Account deletion removes active auth/settings/account-entitlement records, linked security
counters and the account's PostHog usage record. Separate support emails and historical billing/event records remain until separately
deleted; provider logs/backups expire on their own schedules. Temporary shared-connection counters
finish their short security window. Do not promise immediate erasure of all provider copies.
Use the published [privacy policy](https://stillapp.fit/privacy/) and
[retention runbook](release/counter-retention.md).

Public contacts: `support@stillapp.fit`, `privacy@stillapp.fit`, `hello@stillapp.fit`. Earlier web
purchases have a 14-day refund window; Apple handles Apple purchase refunds. The owner currently
uses manual operational monitoring; check email capacity before a large campaign.

## Version and evidence boundaries

Browser packages are version 2.1.0. Xcode's checked-in marketing version is 2.1.0 and its default
build number is 9. The 2.0.0 Apple packages in App Store Connect are build 8, as recorded in the
release evidence; 2.1.0 has not been built or submitted yet.
These are distinct facts. A new build must use a valid unused portal build number and record its
exact source, configuration and hashes. Do not rebuild or resubmit pending artifacts to synchronize
documentation, and do not claim submitted binaries were built from later documentation/tooling commits.

The owner has already performed extensive Mac/iPhone testing. Preserve its recorded scope; do not
restart that program because an older checklist has empty boxes. The hosted disposable-account
lifecycle/final certification remains tracked in issue #153; physical iPad coverage remains
skipped/unverified. Store rollout is separate from CI and device certification.

## Implementation references

- Flags: `packages/shared-types/src/entitlement.ts`, `apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift`.
- Settings/reconciliation: `packages/shared-types/src/settings.ts`, `packages/core/src/sync/service.ts`,
  `packages/core/src/storage/cache.ts`, `supabase/migrations/0012_profiles_write_free_sync.sql`.
- Apple propagation: `apps/apple/StillKit/Sources/StillKit/SettingsBridge.swift`, `StillSettings.swift`.
- Browser platforms: `packages/ext-chromium/wxt.config.ts`; Apple targets: `apps/apple/Still/Still.xcodeproj/project.pbxproj`.
- [Architecture](ARCHITECTURE.md), [sync isolation](solutions/logic-errors/invalidate-sync-work-by-session-lifecycle.md),
  [sync recovery](solutions/logic-errors/recover-settings-uploads-without-losing-newer-edits.md),
  [local sign-out](solutions/security-issues/supabase-signout-leaves-local-session-on-revoke-failure.md).

The [original v1 specification](Still-Spec-v1.md) is preserved as historical design input. It does
not override this specification or current strategy.
