# Security Policy

## Supported versions

Security fixes target `main` and the current store-submitted builds. Older unpublished development builds are not supported.

## Reporting a vulnerability

Please do not open a public GitHub issue for a suspected vulnerability.

Use GitHub private vulnerability reporting from the repository Security tab. If the button is unavailable, open a minimal public issue asking for a private security contact and do not include exploit details, secrets, tokens, or user data.

Helpful reports include:

- affected platform or package;
- reproduction steps;
- impact and affected data;
- whether the issue is already public;
- suggested remediation, if known.

## Security posture

- Still never requests `<all_urls>` host access.
- Remote rule sets are signed data, not executable code.
- Entitlements are server-authoritative and written through narrow backend paths.
- Real secrets must stay out of the repository and client bundles.
