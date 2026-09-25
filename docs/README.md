# Still documentation

Start here for product, architecture, release and operations knowledge. For installation and build
commands, use the [root README](../README.md). Each component has a short guide linked from its
repository map.

## Current references

| Document | Purpose |
|---|---|
| [STRATEGY.md](../STRATEGY.md) | Product direction, commercial truth and decision guardrails. |
| [CONCEPTS.md](../CONCEPTS.md) | Canonical domain vocabulary; `CONTEXT.md` is a compatibility pointer. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime modules, interfaces, data flows and verification surfaces. |
| [PRODUCT.md](PRODUCT.md) | Current Still 2.0.0 behavior, supported installations, sync rules and evidence boundaries. |
| [CONNECTIONS.md](CONNECTIONS.md) | Service configuration, secret ownership and deployment gates. |
| [monetization-design.md](monetization-design.md) | Retained purchase and entitlement infrastructure. |
| [production-rule-set-keys.md](production-rule-set-keys.md) | Rule signing and production key management. |
| [SHARED-BRAIN.md](SHARED-BRAIN.md) | Shared repository knowledge workflow across agent runtimes. |
| [MEMORY.md](MEMORY.md) | Shared Mem0 retrieval and checkpoint protocol. |
| [adr/](adr/README.md) | Accepted architectural decisions and consequences. |
| [solutions/](solutions/README.md) | Verified, reusable implementation learnings. |

## Release operations

[release/README.md](release/README.md) is the operational entrypoint. Its tracks cover Apple,
Chrome, Firefox, RevenueCat, future Google Play work and mobile validation. Use
[release/VALIDATION.md](release/VALIDATION.md) and the linked dated release record to distinguish
passed, skipped and outstanding checks. Verify live portal state before an external action.

[app-store-submission.md](app-store-submission.md) is a compatibility summary pointing at the
current Apple runbook and listing copy. Canonical store screenshots and capture instructions live
under [release/screenshots/store-ready/](release/screenshots/store-ready/README.md).

## Website source

The public website's canonical page sources are kept at this directory's root. They are distinct
from the app webview in `packages/app-webview/`.

| Source | Purpose |
|---|---|
| [index.html](index.html) | Homepage and downloads. |
| [setup.html](setup.html) | Device/browser setup instructions. |
| [privacy.html](privacy.html), [support.html](support.html), [terms.html](terms.html) | Public policy, support and terms pages used by the stores. |
| [guides.html](guides.html) | Guide index. |
| [block-youtube-shorts.html](block-youtube-shorts.html), [remove-instagram-reels-safari.html](remove-instagram-reels-safari.html) | Service-specific guides. |
| [short-form-video-blocker.html](short-form-video-blocker.html), [browser-extensions-native-iphone-apps.html](browser-extensions-native-iphone-apps.html) | Product scope and native-app boundaries. |
| `assets/` | Page styles, licensed font, logo and homepage poster. |
| `robots.txt`, `sitemap.xml`, `.nojekyll` | Search discovery and static-site behavior. |

The site publishes separately from the root of `gh-pages`; merging main alone does not publish it.
That branch also holds `CNAME` and the `/privacy/`, `/support/`, `/terms/` and `/setup/` directory
aliases. Preserve those public URLs and compare the page/resource copies during publication.
Do not copy all of `docs/` to a public site: plans, agent knowledge and ignored local evidence are
not website assets. See [Pages publication lessons](solutions/conventions/github-pages-custom-domain-certificate.md).

## Planning, research and history

| Directory | Keep here |
|---|---|
| [plans/](plans/README.md) | Bounded implementation plans with explicit status and verification. |
| `brainstorms/` | Dated product requirements and explored alternatives. |
| [research/](research/README.md) | Dated external research, sources and recommendations. |
| [handoffs/](handoffs/README.md) | Temporary state for unfinished work that another session must resume. |
| [archive/](archive/README.md) | Historical release and testing records, including superseded launch status. |
| `build/` (ignored) | Local working notes, release evidence, artifacts and audit output; never public source. |

The [original v1 specification](Still-Spec-v1.md) and
[pre-refresh references](archive/pre-2.0-reference-refresh/README.md) preserve superseded design
and release procedures. The [reference audit](release/history/2026-09-14-reference-audit.md) records coverage.

History helps explain decisions but does not establish current behavior or store state. Completed
handoffs and execution prompts are retired after their useful knowledge is captured. Preserve
unique decisions and evidence; Git history retains removed material.

## Placement and naming

Use descriptive lowercase directory names and dated `YYYY-MM-DD-topic.md` names for new research,
plans and point-in-time records. ADRs use numbered descriptive names; solution documents follow
[their existing metadata rules](solutions/README.md). Current indexes/references use established
names such as `README.md`, `ARCHITECTURE.md` and `CONNECTIONS.md`. Keep existing reference filenames
such as `monetization-design.md`, `production-rule-set-keys.md` and `Still-Spec-v1.md` stable.

Put implementation tests beside the code they exercise; cross-browser fixture/smoke tests belong
in [tests/](../tests/README.md). Keep build scripts with the component they build. Follow WXT,
Xcode and Supabase conventions inside their component directories rather than renaming framework
inputs for visual consistency. When moving a document, update inbound links and its own relative
links in the same change.
