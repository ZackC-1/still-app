# Still Documentation

This directory holds the product, architecture, release, and operations notes for Still. If you are reading the repository from the outside, start here after the root README.

## Start here

| File | Purpose |
|---|---|
| [../STRATEGY.md](../STRATEGY.md) | Product mission, objective order, commercial truth, and decision guardrails. |
| [SHARED-BRAIN.md](SHARED-BRAIN.md) | Cross-harness Compound Engineering memory and synchronization workflow. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime map of the main modules, interfaces, data flows, and verification surfaces. |
| [Still-Spec-v1.md](Still-Spec-v1.md) | Product specification for what Still blocks and how it should behave. |
| [CONNECTIONS.md](CONNECTIONS.md) | External service checklist, secret ownership, and deployment gates. |
| [monetization-design.md](monetization-design.md) | Still Pro entitlement and purchase design. |
| [production-rule-set-keys.md](production-rule-set-keys.md) | Rule-set signing and production key notes. |
| [release/README.md](release/README.md) | Store and backend release runbooks. |
| [release/VALIDATION.md](release/VALIDATION.md) | Current automated and manual release-validation evidence. |

## Operational docs

The `release/` directory is the canonical launch checklist. Each file is scoped to one track: Apple App Store, Chrome Web Store, Firefox AMO, RevenueCat, Google Play future work, and mobile blocking validation.

The [`solutions/`](solutions/README.md) directory records durable implementation learnings. These are
not status notes; they are reusable decisions and patterns that future maintainers should preserve.

The [`plans/`](plans/README.md) and `brainstorms/` directories contain dated planning artifacts. They
are useful when reconstructing why a feature exists, but the current behavior should be checked
against code, tests, ADRs, and release runbooks. New active plans should follow the plan template and
record status explicitly.

The [`handoffs/`](handoffs/README.md) directory is temporary cross-agent state. A handoff exists only
to resume unfinished work; reusable lessons belong in `solutions/`, and completed operational state
belongs in the relevant current runbook.

The `archive/` directory contains dated session handoffs and agent prompts retained for historical
traceability. It is not operational guidance and may describe superseded repository or store state.

## Public pages

- [privacy.html](privacy.html) is the public privacy policy page used by store submissions.
- [support.html](support.html) is the public support page used by store submissions.
