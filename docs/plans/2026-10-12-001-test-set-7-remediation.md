---
title: Test set 7 remediation (owner QA findings from test set 6)
date: 2026-10-12
status: implemented (all packets merged; test set 7 built from main 4b94f2c8, owner retest pending)
---

# Test set 7 remediation

Owner QA of test set 6 (main `bbf9ef50`, Chrome/Firefox 2.1.1.335, Apple 2.1.0 (9)) found that a
signed-out, never-bought person sees no Still Pro locks and no way to buy on any browser surface,
plus a set of copy and layout changes the owner approved on 12 October. This plan fixes those and
delivers test set 7 for retest. Base: `origin/main` `44bb75c9`.

## Work packets

| Packet | Issue | Seam | Branch | Status |
|---|---|---|---|---|
| P1-browser | ISS-0030 on Chrome, Firefox, Firefox for Android | `ext-chromium` background access context, `entitlement/account-access-transport.ts` | `fix/c7-p1-browser-20261012` | merged (#411) |
| P1-safari | ISS-0030 on Safari (Mac, iPhone) | StillKit entitlement bridge, Safari background/native bridge | `fix/c7-p1-safari-20261012`, `fix/c7-p1-safari-followup-20261012` | merged (#410, #413) |
| P1b | ISS-0033, ISS-0034 Instagram Reels nav item and profile Reels tab/grid holes; ISS-0035 Facebook Reels entries | free Instagram and Facebook rules and fixtures | `fix/c7-p1b-instagram-20261012`, `fix/c7-p1b-facebook-20261012` | merged (#414, #416) |
| P1c | ISS-0036 TikTok and Reels blocking stays free when the paid tier is on | free rule channel | `fix/c7-p1c-tiktok-20261012` | merged (#421) |
| P2-web | ISS-0029 items 1-8, 11, 12 (shared Svelte UI incl. the Apple app Settings web view) + ISS-0031 | `packages/core/src/ui/v3/`, first-run page, ADR 0004 amendment | `fix/c7-p2-web-20261012` | merged (#412) |
| P2-apple | ISS-0029 items 7, 9, 10 (native onboarding) | `apps/apple` SwiftUI onboarding | `fix/c7-p2-apple-20261012` | merged (#409) |
| P3 | ISS-0032 Still Pro entry on every popup and Settings | after P1 and P2 | `feat/c7-p3-safari-handoff-20261012`, `feat/c7-p3-web-20261012` | merged (#417, #418) |
| Follow-ups | ISS-0037 site-access warning; ISS-0038 Instagram Explore Reels; ISS-0039 Facebook typed /reels on Firefox and Safari | popups and Settings; free rules | `fix/c7-site-access-20261012`, `fix/c7-ig-explore-20261012`, `fix/c7-fb-firefox-20261012` | merged (#420, #422, #419) |
| Build | Apple build number 9 to 10 for test set 7 | `version.json` | `chore/c7-apple-build-10-20261013` | merged (#423) |
| Freeze | Test set 7 browser build ids (2.1.1.351) in the sandbox sales bodies | `scripts/backend/deploy/operations.mjs` | `qa/c7-freeze-build-ids-20261013` | this change; the owner approves the protected deploy that activates it |
| P4 | ISS-0028 iPhone sandbox account | owner setup | n/a | owner question |
| P5 | QA programme and recorder | local `docs/build/` only | n/a | local, outside the repository |

Packets that share a seam merge serially: P1-browser before P3; P2-web before P3.

## ISS-0030 root cause (Chrome/Firefox)

The background's verified-session reader returned "verification unavailable" (`undefined`) when the
browser had no Still session at all, instead of the authoritative signed-out value (`null`). The
transport's evidence status only reported conclusive absence for a signed-in account with a fresh
"none" answer, so a signed-out install resolved every Pro row to `verification_required`: a disabled
switch, no lock chip, no purchase offer, and "needs to be verified again" in Settings.

## Verification scenarios

- Signed out, never bought: every supported Pro row shows the "Still Pro" lock chip and the purchase
  offer; Settings shows Get Still Pro (Chrome, Firefox, Firefox for Android, Safari Mac, Safari iPhone).
- Signed in, server unreachable / expired proof / no app answer on Safari: stays "verify", never a
  false locked or purchased.
- Paid purchase recognised within a minute; refund removes Pro; signed-in "verify again" fix holds
  (ISS-0022/0023/0024 retests CH-50, CH-58).
- Every ISS-0029 string identical on all five surfaces; site order Instagram, Facebook, YouTube, TikTok.
- Usage sharing: one switch, existing on stays on, existing off stays off; Firefox permission flow unchanged.
- Gates: lint, typecheck, test, build, Playwright fixtures in both CI lanes; StillKit tests and
  Xcode builds for Apple changes.

## Retest step IDs

CH-02..06, CH-13, CH-15, CH-16, CH-50, CH-58, FX-04..06, AND-03..05, MAC-02..05, MAC-07, IOS-02..06, and the Session 9
visual steps on each surface.
