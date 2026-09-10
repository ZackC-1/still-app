# Preserve ordinary mobile YouTube filters

Status: investigating Home-topic blank results

Base: installed candidate `cc12c5323b3424ba227845d57cde2e35f194cf31`.
Working branch: `fix/mobile-youtube-filters`.

## User requirement

On iPhone Safari, suggested YouTube filters must remain tappable and retain their selected result
view with Still enabled. Hide only the Shorts filter when present. Preserve Shorts removal,
ordinary video playback, and the existing bounded recovery from Shorts-only search.

## Scope and verification

Reproduce using the shipping bundle and current public mobile markup, comparing Still on/off in
an isolated browser. Obtain the affected page and tap behavior from the owner. Test through the
existing content-script DOM and built-extension browser seams; include ordinary filter selection,
Shorts-only recovery, unchanged query, settings off/on, rerendered chips and existing desktop controls.
Do not assume desktop renderer markup or attribute semantics also apply on mobile. Automated mobile
emulation and WebKit checks are distinct from the physical iPhone Safari confirmation.

Implement only the reproduced cause; no rule-engine refactor, dependencies, auth or paid-tier changes.
Record red/green proof, regression sensitivity, independent spec/standards review, full relevant checks,
and a signed candidate build for the existing authorized in-place iPhone upgrade. Preserve installed
candidate and user account/settings. No release-branch or production updates.

## Evidence

Pending. Private live captures and build records belong under
`docs/build/release-gates/implementation/mobile-youtube-filters/` in the original checkout.

Initial observations: public signed-out mobile pages lack the reported filter row. In a separate
phone-width touch test of the desktop layout, the actual Unwatched tab selects successfully with
Still enabled and disabled. These are Chromium controls, not physical Safari proof. Awaiting the
affected page/row and tap behavior from the owner before changing production code.

Owner screenshots establish that taps select Home topics (Premier League, Boat building, Music),
but the feed is empty with Still active. Refresh clears the filter and restores regular videos.
Owner on/off control passes with Still disabled. The defect is missing results after topic selection,
not failure to accept a tap. Public mobile search SPA navigation is a healthy control. USB Web
Inspector is prepared; awaiting owner enablement and foreground page for direct evidence.

## Implemented candidate

Bundled rule version 1.1.9 adds CSS hiding for existing mobile Shorts selectors under `ytm-app`.
Existing removal selectors exclude that mobile root; desktop removal and Shorts-chip recovery
remain unchanged. No engine or auth code changed. Generated CSS and development signature updated.

The new synthetic renderer-ownership fixture reproduces selected Music with no topic results on
the installed base: both built bundles fail, while the Still-disabled control passes. With the
rule correction both bundles pass. Expanded checks cover repeated topics, off/on restoration and
reused cards becoming ordinary videos. The fixture is explicitly a model, not captured YouTube
renderer source. The owner’s exact phone rendering exception remains unobserved.

Full gates and independent review running. Physical iPhone verification remains required.
