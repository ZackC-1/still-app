# Privacy notice draft — security counters and local account safety

**DRAFT — not approved for publication.** Issue #152. Replace the conflicting existing claims only
after deployed behavior and provider retention have been verified and the founder has approved the
complete public notice. This draft does not change `docs/privacy.html` or publish anything.

## Proposed reader-facing wording

Still removes short-form video on supported websites. Blocking works without an account. Signing
in is optional and enables settings sync. On mobile, Still works on websites opened in Safari;
it does not remove content inside native YouTube, Instagram, Facebook or TikTok apps.

We do not collect browsing history or page content. Operating network services can still involve
connection information such as an IP address. We use the information needed to provide account
access, settings sync and service security. This distinction replaces the current statement that
we collect nothing whenever someone is signed out.

To limit abusive requests, our application temporarily stores security counters. These contain a
count, a short time window and a derived identifier for an account, email address or internet
connection. Our counter database does not store raw IP addresses. Connection identifiers change
between windows and are not linked to an account history. The derivation is an additional safeguard;
it does not by itself make this information anonymous.

Our counters use windows of one minute or ten minutes. We remove expired counters and their
window-specific keys automatically, even when no further request arrives. With the cleanup service
operating normally, deletion happens by the end of the window plus up to one minute and five
seconds, so the longest normal retention is eleven minutes and five seconds. An outage or a failed
cleanup can delay deletion; we treat that as a service incident and remove overdue records when
cleanup recovers. Provider logs and backups have separate handling, described below.

Deleting your account removes its synced settings, account entitlement record and account-linked
security counters from our active application database along with the authentication account.
Temporary connection counters can finish the same short security window after account deletion.
This prevents deleting an account from resetting protection for other people using the same
internet connection. We do not create an account-to-IP history to perform deletion.

A minimal last-synced-account marker remains on the device after sign-out or account deletion. It
prevents settings from one account being copied into a different account on a shared device. This
marker is not an IP address or browsing history. Blocking settings can continue to work locally.

## Provider paragraph — publication blocked pending verification

Do not publish an invented maximum here. Complete the inventory in
[counter-retention.md](counter-retention.md), then write the actual provider names, data categories,
retention periods, deletion limits and backup handling. Account deletion has **not** been shown to
erase Supabase auth/edge/database logs, SMTP events, underlying Apple/RevenueCat purchase records,
application billing-event identifiers, WAL or backups. The approved temporary security-counter
exception does not approve indefinite retention of these records.

The final notice must reconcile those findings with the approved functionality-only retention and
IP-deletion policy. If a provider cannot meet it, the founder must resolve that specific limitation
before publication. Avoid a blanket statement that all account data or all IP copies are immediately
erased. Avoid assuming that GDPR or CCPA applies, or claiming legal compliance from this code change.

## Publication checklist for the owner

- Confirm migration 0013 and the reviewed Edge revision are deployed and cleanup runs successfully.
- Resolve provider retention/deletion limitations and use verified periods in the final notice.
- Preserve the local safety-marker explanation and supported-websites/Safari scope.
- Reconcile purchase-provider wording with the intentionally retained platform identity plumbing.
- Obtain explicit approval for the final full public page, update its date, then publish through the
  existing website/store process. Keep this draft out of store submissions until then.
