# Still Documentation

This directory holds the product, architecture, release, and operations notes for Still. If you are reading the repository from the outside, start here after the root README.

## Start here

| File | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime map of the main modules, interfaces, data flows, and verification surfaces. |
| [Still-Spec-v1.md](Still-Spec-v1.md) | Product specification for what Still blocks and how it should behave. |
| [CONNECTIONS.md](CONNECTIONS.md) | External service checklist, secret ownership, and deployment gates. |
| [monetization-design.md](monetization-design.md) | Still Pro entitlement and purchase design. |
| [production-rule-set-keys.md](production-rule-set-keys.md) | Rule-set signing and production key notes. |
| [release/README.md](release/README.md) | Store and backend release runbooks. |
| [release/VALIDATION.md](release/VALIDATION.md) | Current automated and manual release-validation evidence. |

## Operational docs

The `release/` directory is the canonical launch checklist. Each file is scoped to one track: Apple App Store, Chrome Web Store, Firefox AMO, RevenueCat, Google Play future work, and mobile blocking validation.

The `solutions/` directory records durable implementation learnings. These are not status notes; they are reusable decisions and patterns that future maintainers should preserve.

The `plans/` and `brainstorms/` directories are historical planning artifacts. They are useful when reconstructing why a feature exists, but the current behavior should be checked against code, tests, and the release runbooks.

The `archive/` directory contains dated session handoffs and agent prompts retained for historical
traceability. It is not operational guidance and may describe superseded repository or store state.

## Public pages

- [privacy.html](privacy.html) is the public privacy policy page used by store submissions.
- [support.html](support.html) is the public support page used by store submissions.
