---
title: Bind v3.1 QA packages to reviewed source and sandbox configuration
date: 2026-10-07
status: in_progress
---

QA receipts must describe the actual source, configuration and packaged resources. The paid
sandbox profile enables both paid constants only in a disposable source clone; the shipped source
keeps both constants false. Free blocking and optional sync remain independent of purchases.

- [x] Preserve dirty source, deletions and executable modes in the clone; reject inherited Git overrides.
- [x] Require bounded public sandbox configuration and matching packaged resource/plist identities.
- [x] Require Apple-anchored signatures from the reviewed team for archive targets.
- [x] Defer all receipts until selected targets and source preservation checks finish.
- [x] Refuse paid-enabled source in local/test profiles and preserve nested linked worktrees.
- [x] Pass 65 focused Node checks, including real cold offline development-dependency installation
  and an ad-hoc signature rejection; pass the repository ESLint command directly.
- [x] Complete independent full-scope Claude review and narrow final Muse review with no remaining findings.
- [ ] Pass protected PR CI before merge.

Verification is source/tooling evidence. A real cold paid build, positive signing, hosted provider
acceptance and physical-device journeys still require release configuration and separate evidence.
This implementation does not perform uploads, deployments or purchases. See
[the durable packaging checks](../solutions/security-issues/bind-qa-receipts-to-isolated-source-and-packaged-bytes.md).
