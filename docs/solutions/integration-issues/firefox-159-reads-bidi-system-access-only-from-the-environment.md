---
title: Firefox 159 reads BiDi system access only from MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, not the flag
category: integration-issues
track: bug
problem_type: integration_issue
module: tests/firefox
applies_when: The real-Firefox lane fails with "Navigation to moz-extension://… is not allowed in this context", or a chrome-scope BiDi call says system access is required
date: 2026-11-07
status: active
tags: [firefox, bidi, webdriver, test-harness, ci]
---

## Symptom

Every lane test that opens an extension page (`StillFirefox.openExtensionPage`, and through it
`waitForModernSettings` and `inExtension`) failed at `browsingContext.navigate` with
`unsupported operation: Navigation to "moz-extension://…/options.html" is not allowed in this
context`. The lane passed on Firefox 158.0.1 (2 Nov 2026) and failed from the first run on
Firefox 159.0 (6 Nov 2026). The runner's `firefox --version` step shows the change. No harness or
manifest change caused it.

## Cause

BiDi refuses navigation to a URL that is not `http`, `https`, `file`, `blob` or `about:blank`
unless the Remote Agent has system access (`RemoteAgent.allowSystemAccess` in
`chrome/remote/content/webdriver-bidi/modules/root/browsingContext.sys.mjs`). Firefox 159 sets
system access only from the environment variable `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`. It ignores the
`--remote-allow-system-access` command-line flag, which the harness used to pass, without a warning.
The same loss also blocks the chrome scope (`browsingContext.getTree` with `moz:scope: "chrome"`)
that `_qa-capture.ts` and the QA reinstall helper use.

## Fix

`launchFirefox` in `tests/firefox/_bidi.ts` starts Firefox with
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in its environment and still passes the flag, so older and newer
releases both get system access. `tests/firefox-android/run-spike.sh` already set both for
GeckoView.

## Rejected approach

Open Settings through `runtime.openOptionsPage` and find the tab with `browsingContext.getTree`.
This needs an extension page to call from, which is the thing that cannot open. It also reuses one
Settings tab, but some tests open two Settings tabs at once, and `openExtensionPage` also opens
`popup.html` and `first-run.html`. It treats the symptom, not the lost system access.

## How to check

- `FIREFOX_BIN=<firefox 159> pnpm test:firefox`: 39 passed. The same command on Firefox 158.0.1:
  39 passed.
- To confirm where a new Firefox reads system access, unzip its `omni.ja` and search
  `chrome/remote/content/components/RemoteAgent.sys.mjs` for `allowSystemAccess`.

## Prevention

- Pass every Remote Agent option both ways (environment variable and flag) when Firefox has both.
- When the lane breaks with no harness change, compare the `Show Firefox version` step of the last
  green run and the first red run before changing test code.
