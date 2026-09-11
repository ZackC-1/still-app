# Public contact email update

Status: in progress

## Scope

Replace customer-facing personal contact addresses with `support@stillapp.fit`,
`privacy@stillapp.fit` and `hello@stillapp.fit`, following the owner's configured forwarding.
Cover shared app configuration, website aliases including the Terms page, and store submission
materials. Preserve private account/reviewer identities and permanent application identifiers.
No legal-policy, pricing, SMTP, store-portal or submission changes are included.

## Delivery and verification

- Update all tracked customer contact strings and add the existing published Terms source to main.
- Link a canonical contact/store checklist from each release track and submission-copy reference.
- Run lint, types, tests, production builds and required PR CI; inspect the diff for unintended edits.
- Compare rebuilt app payloads with the prior release packages and record whether replacement
  artifacts are needed. Update complete AMO sources whenever the source candidate changes.
- Merge through a PR, synchronize local main, and publish only the reviewed website contact changes
  to gh-pages. Verify HTTPS pages and both `.html`/directory aliases contain the intended links.
- Record delivered work, artifact implications and remaining provider/portal steps.
