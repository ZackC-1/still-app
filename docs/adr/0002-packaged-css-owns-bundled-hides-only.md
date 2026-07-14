# ADR-0002: Packaged CSS owns bundled hides only

Date: 2026-07-14 · Status: accepted

## Context

Still injects free and Pro hide CSS from extension manifests at `document_start`. The content
orchestrator can skip JS hide-selector sweeps for the bundled seed because that exact rule set
generated those stylesheets. A previous `generateHideCss` export suggested a runtime CSS adapter
for fetched rule sets, but no caller used it and it duplicated the build formatter.

## Decision

Keep `packages/core/scripts/gen-content-css.mjs` as the only formatter and remove the unused
runtime formatter. `manifestCssOwnsHides` is true only for the bundled seed; fetched or cached
rule sets use the complete JS DOM sweep for hide and remove actions.

## Consequences

- OTA rule sets continue to update all supported surfaces through JS without a second CSS injection
  mechanism.
- Packaged CSS can be stale relative to an OTA set. If an OTA set retracts a bundled hide selector,
  the packaged selector may still hide content while the active root class is present until a store
  release ships regenerated CSS. This layering limitation is accepted for now.
- The generated-artifact test runs the production formatter rather than maintaining a second copy
  of its bucketing logic.
