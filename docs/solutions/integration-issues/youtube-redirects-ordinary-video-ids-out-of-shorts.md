---
title: YouTube itself sends /shorts/<id> to the watch page when the ID is an ordinary video
category: integration-issues
track: knowledge
problem_type: integration_issue
module: packages/ext-chromium
applies_when: A check of the YouTube Shorts switch, or of any Shorts redirect, uses a live youtube.com /shorts/<id> address
date: 2026-10-20
status: active
tags:
  - youtube
  - shorts
  - qa
  - declarative-net-request
---

## Symptom

QA (ISS-0078, packages 2.1.1.385 and 2.1.1.400, Chrome and Firefox) turned the free YouTube "Shorts"
row Off on the Settings page, left the YouTube Blocker On, and opened a direct
`https://www.youtube.com/shorts/<id>` link. The tab still ended on `/watch?v=<id>`, so the switch
looked ignored on both browsers. The links used were `dQw4w9WgXcQ` and `aqz-KE-bpKQ`.

## Cause

Neither ID is a Short. YouTube's own server answers `/shorts/<id>` for an ordinary video with
`303 See Other` to `/watch?v=<id>` (sometimes with an extra `&pp=` parameter), whatever extension is
installed. A real Short's ID is served at `/shorts/<id>` with `200`. Checked with curl, Chrome and
Firefox user agents, on 20 October 2026:

| ID | Kind | `/shorts/<id>` answer |
|---|---|---|
| `dQw4w9WgXcQ` | ordinary video | 303 to `/watch?v=dQw4w9WgXcQ` |
| `aqz-KE-bpKQ` | ordinary video | 303 to `/watch?v=aqz-KE-bpKQ&pp=...` |
| `_wogmiwYknY` | Short (from `youtube.com/@YouTube/shorts`) | 200 |

Still's code honours the row. The unsigned 2.1.1.385 and 2.1.1.400 Chrome artifacts were loaded in
Chromium against live YouTube, with every other host unresolvable. Each run then checked the
declarativeNetRequest state and the main-frame response chain:

- Shorts On: session rules 1, 2, 11-14, 21, 22, static `youtube-shorts-redirect` disabled. Both IDs
  get Still's `307` internal redirect to `/watch`.
- Shorts Off: session rules 11-14, 21, 22 (no YouTube rule), static ruleset disabled. The real Short
  plays at `/shorts/_wogmiwYknY` (`200`). The ordinary video still reaches `/watch` through
  YouTube's own `303`.

The static ruleset is doubly gated: even on the legacy lane, `isServiceEnabledGlobally` reads
`sites["youtube.shorts"]` for schema-2 settings. So a saved Shorts Off can keep it on only if the
settings record cannot be read at all, and that case is the deliberate fail-safe.

## Guidance

- Use a real Short's ID for any live Shorts check. Take one from a channel's Shorts tab, and confirm
  `curl -s -o /dev/null -w "%{http_code}" https://www.youtube.com/shorts/<id>` prints `200`.
- Read the declarativeNetRequest state only after the background has settled. Straight after
  install, before its first pass, the state is the static ruleset enabled and no session rules. That
  looks like a Shorts switch being ignored, but the first pass corrects it within about a second.
- Read the main-frame response chain before blaming the extension. Still's network redirect is a
  `307` internal redirect, while YouTube's own is a `303` (often adding `&pp=`). The content
  script's redirect is a `location.replace` after the page committed.
- Offline fixtures (`tests/playwright/navigation-dnr.spec.ts`) fulfil every request locally, so they
  never see YouTube's own redirect. The spec now drives the Settings page's "Shorts" row (Off leaves
  a direct Shorts link alone at the network layer and in the content script, On redirects again).
  The format-2 lane runs it and the configured legacy lane skips it. A build that gates the static
  ruleset on the YouTube master alone fails it.

## Related

- `packages/ext-chromium/lib/navigation-dnr.ts` (static ruleset gate and session rules)
- `packages/core/src/rules/navigation-dnr.ts` (`planNavigationDnr`)
- `packages/core/src/rules/engine.ts` (`isServiceEnabledGlobally`, the format-2 classifier)
- `docs/solutions/ui-bugs/youtube-shorts-search-continuation-loop.md`
