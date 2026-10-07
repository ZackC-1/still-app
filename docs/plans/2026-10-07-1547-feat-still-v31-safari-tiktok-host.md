---
title: Still v3.1 redesign Safari TikTok host continuation
status: implemented and locally verified; exact review and physical Safari evidence pending
---

The approved redesign plan U10 requires the D29 extension-owned blocked page and confirmed current-tab action on Safari. The maintained Chromium/Firefox producer already exists; this continuation preserves it and its demonstrated lifecycle repairs. Safari background/content composition currently has no D29 producer. This plan proposes a narrow equivalent transport; it does not establish support or authorize weaker verification.

Prerequisite: current main3e02952a plus immutable host1dbc0415 and TikTok lifecycle e75f335e, staged tree98d9c0b3b94fb03a6c07aefc63c50a7f1f3eaa9b. Original review trees remain unchanged.

## Verified constraints

[Mozilla runtime compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/runtime.json) reports Safari has no runtime.getContexts; native MessageSender.documentId starts at18.4. [Storage data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/storage.json) places session storage at16.4; [tabs data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/tabs.json) includes tab removal/replacement APIs. Capability must be observed at runtime, not inferred from an OS version or a mocked browser.

[The Port contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port) supplies the receiving background with a browser-owned MessageSender. Both ends can exchange messages and disconnect. Inference to test: a strictly scoped connection from the packaged blocked page, with native document identity and a fresh bounded challenge, can prove the current endpoint without getContexts. Port lifecycle behavior and same-URL replacement still need real Safari verification.

## Bounded implementation

1. Reuse the existing shared route, tab authority, blocked presentation/host and navigation policy. Avoid importing Chromium package code into Safari or duplicating its authority. If necessary, expose the platform-neutral browser adapter through core with a compatibility re-export for existing Chromium callers; preserve signatures and run existing route/authority tests.
2. The Safari extension-owned blocked page connects using a fixed private port name. Background accepts only its own runtime ID, top frame, exact packaged path, valid browser tab ID and native document ID. Never take tab/document/URL identity from message payload. Unknown capability continues blocking and makes the action unavailable.
3. Registry is bounded and keyed by actual tab/document/connection generation. Fresh unpredictable challenge replies are valid only on that same live connection. Recheck generation after every await. Timeout, disconnect, replacement, pagehide, malformed answer and stale challenge fail closed. A new connection retires pending work for the previous document. Do not emulate getContexts using cached sender metadata alone.
4. The page retires host and disconnects on pagehide. Persisted restoration reloads/rebinds before any action. Existing owned-tab allowance remains in extension-only session storage, never settings/local durable storage/sync. Tab close/replacement/browser restart clear it according to the existing contract. Background wake cannot resurrect stale document proof.
5. Add the actual Safari V3 background, content and blocked page composition under the existing V3 build selection. Preserve ordinary 2.x behavior, narrow host permissions, free blocking without account and existing native settings/access/analytics lanes. No native API, new SDK, account, purchase, host permission or browsing telemetry is required.

## Required proof

Meaningful regressions for foreign/content/subframe senders; absent native document/session APIs; stale/malformed/late/wrong-connection challenges; same-URL new document; pagehide during confirmation/reopen; port disconnect/replacement; tab removal; background wake and browser session restart; committed-setting changes; genuine request/confirm/grant/readback. Remove important guards to reproduce failures, restore exact bytes and rerun. Existing Chromium/Firefox route and authority tests must still pass.

Build/type/lint and actual Safari bundle fixtures prove only source/bundle behavior. Signed Safari Mac and iPhone installation must separately prove native sender fields, connection identity/lifecycle, fresh current-tab allowance, disposal and restart. Old unsupported capabilities must be reported honestly; no feature parity or release PASS is claimed before that evidence. Physical iPad remains the owner's recorded exception. Include payload size and ordinary 2.x dead-code qualification.

Review scope is the owned continuation delta; actual Claude review remains required before merge. The current weekly quota prevents a new Claude pass; independent source review is useful but does not satisfy that gate. No provider/store deployment or public publication is part of this implementation unit.

## Implemented continuation and recorded verification

Safari V3 now composes the existing route and session tab authority with a fixed native Port and fresh challenge. The shared browser adapter moved into core; Chromium keeps its original import and factory signature through a thin compatibility export. Each allow operation captures one connection, and every subsequent proof retains that generation. The page disconnects on pagehide, stops its host on disconnect, and reloads a persisted restoration. Missing native document identity, session storage or lifecycle APIs keeps the optional allowance unavailable.

The actual Safari background reads `adapter.readNativeAuthority()` for committed settings. `adapter.get()` on this host reads an auxiliary projection and cannot establish freshness for confirmation. Native-read failures grant nothing. This reuses the existing native read contract; no Swift implementation, purchase, provider, permission or analytics changed.

Final restored checks: 172 core cases across six files (including the previously verified 138), 60 existing Chromium route/authority/gate cases, nine Safari composition cases, and three actual Safari V3 bundle fixtures pass. The latter load the Safari JavaScript in Blink with controlled native settings replies; they establish packaged composition, genuine route confirmation, same-tab readback, pagehide disposal and native-read failure handling. They do not establish Safari engine or native message behavior. Seven installed Chromium current-tab cases pass, with one configured-2.x-only skip. Core, Chromium and Safari types, scoped lint, ordinary Chromium/Firefox builds and ordinary/V3 Safari builds pass.

Five removed-guard controls fail as expected: removing the native current-document proof hook; ignoring connection generation after a delayed final tab read; removing native request-document binding; removing the actual Safari entrypoint's pagehide listener (unexpected TikTok navigation); and substituting the browser projection for native committed reads (stale confirmation permitted). Each source was restored exactly and final checks rerun. The ordinary Safari output matches all files from immutable prerequisite tree `98d9c0b3b94fb03a6c07aefc63c50a7f1f3eaa9b` byte for byte: 898,652 bytes. No dependency was added.

Safari V3 raw output is 1,083,311 bytes versus 1,043,125 in the prerequisite. An unsigned compression estimate is 577,802 bytes versus 562,638 (+15,164 bytes); this is not a signed store download or startup measurement. The packaged page reuses the existing shared components, font and assets. Permission and four-service host lists match the prerequisite.

Remaining acceptance: real signed Safari Mac/iPhone observation of background native sender fields and Port disconnect/pagehide/new-document/replacement/wake/browser-restart behavior; latest reference comparison and accessibility/performance acceptance; cross-device/provider QA outside this unit; root integration and actual Claude review after its quota resets. Physical iPad remains the owner's exception. The Port equivalence premise is still conditional on real Safari evidence, and the all-surface U10 requirement remains open.
