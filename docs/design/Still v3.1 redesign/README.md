# Still v3.1 redesign references

This is the reference home for the owner's **Still Design System latest.zip**, SHA-256 `957c50516ff306b305f20b893105104bdd4512bf5fa7abaa06553287706fb3a3`. The archive calls its design version **3.0.1**. The project label **Still v3.1 redesign** identifies this new implementation and supersedes earlier V3 visual references.

Start with [the implementation design contract](../../../design.md), [source README](source/readme.md), [handoff](source/handoff/HANDOFF.md), [screen index](screens.md), and [inventory/provenance receipt](inventory.json). Original relative paths are preserved under `source/`.

The intake contains315 files;313 are retained, including145 screen/gallery/store preview PNGs. Two excluded files remain represented by size/hash/reason in the inventory: the corrupted supplied wordmark and an unrelated macOS Save-dialog upload. Do not restore the broken wordmark as a baseline. Repair production branding from verified artwork and document that substitution.

The latest HTML, tokens, component contracts and handoff jointly define the design. Preview PNGs are scaled orientation aids. The existing `screens.json` contains unresolved dynamic captions/width placeholders; exact visual baselines require rendered DOM inventory and deterministic same-engine captures. Source gallery/demo authentication, fake operations, native sheet framing, React/Babel and this folder's SKILL.md are reference content, not runtime code or active agent instructions.

Keep this directory outside all production asset imports and build roots. Reference assets do not establish working feature support: every screen needs a live authority and outcome check in the [coverage matrix](coverage.md). See [existing implementation and remaining integration](existing-implementation.md) and [unresolved facts](unresolved.md) before filling reference placeholders.
