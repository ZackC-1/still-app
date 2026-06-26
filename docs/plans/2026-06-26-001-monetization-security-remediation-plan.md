# Monetization Security Remediation Plan

Status: active remediation plan for `docs/monetization-design.md`.

This plan converts the second-pass monetization review into implementation-sized fixes. The
priority order is security first, then correctness, then future-proofing and scope cleanup.

## P0. Replace forgeable extension entitlement cache design

Issue: `chrome.storage.session`, service-worker memory, and a client-verified HMAC token are not an
unforgeable server-only entitlement store. A client cannot verify an HMAC token without holding the
same secret that signs it.

Fix:

- Replace the HMAC-token language in the design with a server-signed asymmetric entitlement token.
- Add a token payload model with `userId`, `capabilities`, `issuedAt`, `expiresAt`, and a revocation
  version or `revokedAfter` hook.
- Require clients to verify the token with a bundled public key and require server-side issuance from
  authenticated reconcile/checkout flows only.
- Explicitly state the threat model: this prevents settings/profile self-grants and storage edits;
  it does not cryptographically prevent a user from patching their own local extension binary.

Validation:

- Unit-test token verification, expiration, subject mismatch, tampering, and wrong-key rejection.
- Extension test: editing settings or entitlement-like fields in local storage must not unlock Pro.

## P0. Move RevenueCat Web Billing checkout creation server-side

Issue: Passing `auth.getSession().user.id` from the client into checkout still lets a malicious client
alter the `app_user_id` at the RevenueCat boundary.

Fix:

- Add an authenticated `create-web-checkout` Edge Function.
- Derive the checkout subject only from the verified Supabase JWT `sub`.
- Do not accept `user_id`, `app_user_id`, product id, or price from the request body.
- Return a hosted checkout URL/session for the authenticated UUID.

Validation:

- Function tests prove body-supplied ids are ignored and invalid JWTs fail.
- Web flow tests prove checkout starts only after a valid session.

## P1. Harden offline token replay and lifecycle semantics

Issue: A token over only `(userId, expiresAt)` is replay-prone and cannot evolve with future
capabilities, revocation, or subscriptions.

Fix:

- Encode `capabilities`, `issuedAt`, `expiresAt`, and `tokenVersion`.
- Clear cached tokens on sign-out, account deletion, and identity switch.
- Verify the token subject matches the current Supabase session before using it.
- Add a 30-day TTL constant and make expiry-while-offline downgrade to free.

Validation:

- Tests cover replay under a different signed-in user, expired tokens, sign-out clearing, and offline
  downgrade after TTL.

## P1. Keep local receipt fast-path UI-only unless server confirms

Issue: RevenueCat local `CustomerInfo` can provide immediate purchase feedback, but engine gating is
supposed to be server-authoritative.

Fix:

- Specify and implement fast-path as paywall UI optimism only.
- Pro engine gating and cross-device sync must require a server response or valid server-signed token.
- If a temporary local unlock state is added, give it a short pending window and reconcile before
  persisting any Pro state.

Validation:

- Purchase success shows immediate feedback.
- Pro content blocking is not persisted unless reconcile/token issuance succeeds.

## P1. Whitelist settings parsing across TypeScript and Swift

Issue: `parseSettings()` currently returns the original object after a minimal shape check, preserving
unknown fields such as `entitlement`.

Fix:

- Reconstruct settings from whitelisted fields only.
- Validate/normalize `services` and `pauses` instead of accepting arbitrary object shapes.
- Mirror the same behavior in Swift `SettingsBridge.parse`.
- Sanitize cloud profile settings before applying them to `SettingsCache`.

Validation:

- TypeScript and Swift tests prove unknown fields are stripped.
- Tests prove malformed `services`, malformed `pauses`, and prototype-like keys do not pass through.

## P1. Make all existing YouTube Shorts surfaces always-free

Issue: The design says the “YouTube Shorts surface” is always free, but current Shorts blocking is
implemented as multiple surfaces.

Fix:

- Tag every existing YouTube Shorts seed surface as `tier: "free"`.
- Add an always-free allowlist for all current YouTube Shorts surface ids so stale or missing tags do
  not break the free promise.
- Default unlabeled non-allowlisted surfaces to Pro.

Validation:

- Engine tests prove every current YouTube Shorts surface remains active for free users even with
  missing or stale tier tags.
- Engine tests prove Instagram, TikTok, Facebook, and future unlabeled surfaces are gated for free users.

## P1. Convert entitlement reads from boolean to tri-state

Issue: Current `BackendPort.readEntitlement()` returns `false` on missing data and ignores Supabase
errors, collapsing offline/error into not-entitled.

Fix:

- Introduce `EntitlementRead = "entitled" | "not-entitled" | "unknown"`.
- Return `unknown` for network/function/database errors.
- Only downgrade on a successful server response of not-entitled or on cached-token TTL expiry.
- Update `SyncService` and UI state handling accordingly.

Validation:

- Tests cover offline/error retaining cached Pro within TTL and downgrading after TTL.

## P2. Correct identity terminology

Issue: The design says “canonical key = email,” but the secure canonical key is the Supabase UUID.

Fix:

- Update the design to say the canonical account key is the Supabase auth user UUID.
- Treat verified email only as a login/contact/linking attribute.
- Keep authenticated-only `linkIdentity` and no silent merge.

Validation:

- Design review only; implementation should already use UUID for RevenueCat and backend reconcile.

## P2. Minimize RevenueCat webhook PII retention

Issue: The webhook stores the raw RevenueCat payload. Web Billing may introduce billing or subscriber
metadata that should not be retained wholesale.

Fix:

- Redact or reduce stored webhook payloads to event id/type, UUID candidates, product/entitlement ids,
  event time, and diagnostic fields needed for support.
- Add a retention policy for `revenuecat_events`.
- Update export/privacy docs if the stored shape changes.

Validation:

- Webhook tests prove full raw payload content is not persisted.
- Export tests reflect the minimized shape.

## P2. Replace binary `tier` with capability-oriented gating

Issue: `tier: "free" | "pro"` and a single `entitled` boolean will not scale cleanly to granular
surfaces, subscriptions, or future product bundles.

Fix:

- Keep RevenueCat ids unchanged, but translate server grants into capabilities.
- Add `requiredCapability` to rule surfaces, defaulting conservatively to Pro-only unless always-free.
- Let UI lock states derive from capabilities.

Validation:

- Tests prove adding a new premium surface requires only a capability tag, not new engine branching.

## P2. Specify per-browser entitlement cache support

Issue: The design assumes `chrome.storage.session`, but Safari and Firefox support differs and local
storage is not a security boundary.

Fix:

- Document per-browser storage choices.
- Store only signed tokens or derived verified state, never unsigned Pro booleans.
- Use local storage persistence only with token verification and TTL.

Validation:

- Browser/extension tests cover Chrome and Safari paths at minimum.

## P3. Correct TRANSFER scoping

Issue: The design says TRANSFER handling is “real work,” but the existing webhook already reconciles
`transferred_from` and `transferred_to`.

Fix:

- Update the design to say TRANSFER support exists and must be preserved/covered by tests when the
  token issuance path is added.

Validation:

- Existing webhook tests plus a new token-store regression if token issuance is implemented.
