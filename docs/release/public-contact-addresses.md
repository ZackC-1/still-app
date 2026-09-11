# Public contact addresses

Use these addresses for Still's website, apps, customer-facing messages and store listings.
They receive mail through the owner's configured Namecheap forwarding. Keep the destination
mailbox and private operator/reviewer credentials out of customer-facing copy.

| Purpose | Public address |
|---|---|
| App support, refunds and purchase recovery | `support@stillapp.fit` |
| Privacy and personal-data requests | `privacy@stillapp.fit` |
| General enquiries and company contact | `hello@stillapp.fit` |

The shared app support address is `SUPPORT_EMAIL` in `packages/core/src/ui/config.ts`.
Website sources are in `docs/`; the live site is published separately from `gh-pages`.
Publish both the `.html` and directory URLs for support, privacy and setup; publish the
Terms source at `/terms/` while preserving its existing `.html` redirect.

## Store upload checklist

Apply this checklist to each new submission and listing update. These are the intended values;
this document does not establish that a live portal has already been updated.

| Destination | Customer-facing contact values |
|---|---|
| Apple App Store — iOS | Support URL `https://stillapp.fit/support/`; Privacy Policy URL `https://stillapp.fit/privacy/`; use `support@stillapp.fit` wherever customer support email appears in copy |
| Mac App Store — macOS | The same URLs and support email; check the macOS version's metadata separately |
| Chrome Web Store | Public support/contact email `support@stillapp.fit`; support URL `https://stillapp.fit/support/`; privacy URL `https://stillapp.fit/privacy/` |
| Firefox Add-ons | Support email `support@stillapp.fit`; support website `https://stillapp.fit/support/`; use `privacy@stillapp.fit` in privacy-policy contact text |

- Verify each live portal's current review state before editing or uploading. Check every published
  localization, listing description and customer-visible developer/trader contact field. Complete
  any email verification requested by the portal.
- Keep private App Review contacts, store account logins and the designated review sign-in account
  separate from public support aliases. Do not change credentials as part of a contact-copy update.
- Keep the permanent Firefox ID `still@chartash.com`; it is an application identifier, not a mailbox.
- Confirm the submitted package and complete Firefox source archive correspond to the reviewed
  candidate. A source edit does not update an existing ZIP, IPA or PKG. Compare rebuilt payloads
  and artifact hashes; preserve earlier evidence with its original candidate.
- Send forwarding tests from an address other than the destination mailbox, and confirm receipt
  for all three aliases before relying on them for customer support. DNS alone cannot prove delivery.

## Outgoing email

Forwarding receives mail; it does not configure sending from these addresses. The Supabase Auth
sender and any email-service templates need a separate verified sending-domain/SMTP configuration.
Replies from an existing work mailbox retain that mailbox's sender unless its mail provider has a
verified send-as configuration. Do not change authentication sender settings or claim delivery was
tested based only on a forwarding screenshot.
