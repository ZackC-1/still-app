# Architecture decisions

Accepted decisions explain a lasting boundary and the tradeoff behind it. Current runtime context
lives in [ARCHITECTURE.md](../ARCHITECTURE.md); implementation plans live in `docs/plans/`.

| Decision | Boundary |
|---|---|
| [0001: Hand-routed bridge messages](0001-bridge-message-kinds-stay-hand-routed.md) | Keep explicit dispatch across the native/web bridge. |
| [0002: Packaged CSS and bundled hides](0002-packaged-css-owns-bundled-hides-only.md) | One build formatter; fetched rules retain JS application. |
| [0003: Receipt and server entitlement](0003-entitlement-authority-receipt-and-server.md) | Preserve distinct device/account authorities and stamp policy. |

Add a numbered, descriptive Markdown file for a new accepted decision. Include date, status,
context, decision, consequences and links to relevant evidence. When superseding a decision,
link both records and preserve the earlier rationale. Entitlement decisions describe retained
infrastructure; [current strategy](../../STRATEGY.md) keeps this release free.
