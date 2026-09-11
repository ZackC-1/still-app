# Sync recovery and visible account identity

Status: implemented and independently reviewed; physical cross-surface retest in progress.
PR branch: fix/account-sync-status, stacked on fix/149-sync-lifecycle. Base candidate: 2dcadc7.

The owner observed Facebook on in the Mac app while the iPhone app remained off. Read-only
snapshots confirmed the mismatch. Restarting the iPhone did not recover it. A Mac screenshot
showed the existing cloud-unreachable message, and restarting the Mac restored the saved change
on both devices. The exact transport error is unknown; do not label it a credential or server bug.

The owner additionally requires a visible account email and understandable sync status across
supported surfaces. Use the authenticated account's email as the user-facing identity; retain the
existing internal account IDs and account-switch safety rules. Never imply that a successful local
upload proves every other device has received it.

Required behavior:
- Retry a transient failed settings upload without requiring another edit or app restart. Bound
  retry frequency and prevent overlapping work, cross-account writes, stale-result application,
  or loss of the latest local edit. Preserve existing account-wins reconciliation semantics.
- Show the signed-in email in Apple apps and Chrome/Firefox. Safari must show the containing app's
  account identity and meaningful local-extension sync state, clearing it on sign-out/switch.
- Distinguish working, successful, unsent/offline and signed-out states. Only show a successful
  sync time after a real successful settings exchange, and describe the scope truthfully.
- Keep all blocking free without an account. Paid flags and dormant purchase behavior stay intact.
- Do not log account emails, credentials or settings payloads. Add no browsing permissions,
  production database changes, dependency upgrades or unrelated refactors.

Verification: reproduce failed upload with no realtime reconnect at the real SyncService boundary;
exercise teardown/account switch during retry, repeated failure, latest-edit preservation, recovery,
and accurate status. Verify account identity across sign-in, restart, sign-out and account switch;
use synthetic accounts only for automated tests. Check native bridge parity with real Swift tests,
UI fit with long emails at existing popup sizes, full relevant repository gates and independent
spec/standards/security reviews. Build distinct signed local Apple candidates and repeat the live
Mac-to-iPhone toggle sequence, including Safari enforcement. Keep the earlier Safari reload-only
failure separate from the sender upload failure.

Publication and production actions remain outside this local implementation/testing scope.


Verification evidence: the integrated candidate `cc12c5323b3424ba227845d57cde2e35f194cf31`
passed lint, typecheck, 786 JavaScript tests (39 existing paid-tier skips), 131 Swift tests and
50 configured browser fixtures. Configured Chrome, Firefox, Safari and app-webview bundles built.
Signed development archives/exports succeeded for macOS and iOS. The Mac install preserved its
settings, and the owner confirmed the correct email and successful sync status. The iPhone was
updated in place; iOS required unlocking before launch and the remaining human sync retest.

The candidate also contains the separately reviewed popup sizing, branding and YouTube filter
fixes. This PR is stacked on the session-isolation fix; final popup geometry verification must use
the integration containing the popup sizing fix as well. These results do not close the broader
release certification or authorize store upload or production changes.
