# Context dossier: extension content/background entry factory (deepening candidate 3)

- **Status**: context for planning — no implementation done.
- **Grounded at**: commit `5470713` (main, 2026-07-14). Verify line anchors before editing.
- **Origin**: `/improve-codebase-architecture` review, 2026-07-14. Goal: pre-release hardening.

## The problem

The per-build extension entrypoints are near-duplicate wiring with zero test coverage:

- `packages/ext-safari/entrypoints/content/index.ts` (89 lines) and
  `packages/ext-chromium/entrypoints/content/index.ts` (75 lines) are ~90% identical.
- `ruleSetEndpointFromEnv()` is byte-identical in both backgrounds (safari `:26-32`, chromium
  `:46-52`; doc comments differ by one trailing clause).
- No test imports any entrypoint file's `main()` — the wiring layer (DNR gate hookup, hydration
  ordering, Safari reconcile listeners, sender validation) has never executed in a test.
- The repo already solved this exact problem once for popup/options: the **Extension UI factory**
  (`core/src/ui/extension-setup.ts`, born in commit `e74ad0d` "Collapse the duplicated popup
  wiring into one core factory"). This candidate is its content/background sibling.
- `docs/solutions/conventions/mirror-fixes-across-parallel-paths.md` documents the project
  convention: route siblings through one hardened helper instead of re-implementing.

## Included bug: the Safari reconcile-nudge leak (fix first, independently)

`packages/ext-safari/entrypoints/content/index.ts:70-87`: the content script fires a
`{kind:"reconcile"}` nudge on `start().then`, immediately, at +500ms, on `focus`, on `pageshow`,
on `visibilitychange`, AND on a `setInterval(..., 15_000)` while visible. Verified precisely:

- The `setInterval` id is **discarded** (`:85`) — nothing can ever `clearInterval` it.
- The three listeners (`:80-84`) are registered outside `createContentScript`'s teardown array
  (`core/src/content/index.ts:145-147` pops only nav hooks, observer, cache/entitlement subs).
- The entrypoint never calls `script.stop()` at all; the Safari background's
  `reconciler.stop()` is likewise never called.

Impact: per-tab native `sendNativeMessage` round-trips every 15s forever (battery + IPC on iOS —
the platform under App Review). This is a small standalone fix (capture the interval id, route
teardowns through the handle, or justify the polling with a bounded stop) that should NOT wait
for the factory refactor. A planning agent may fold it into the factory design as the shape of
the "Safari nudge machinery" injection, but the leak itself is fixable today.

## Divergence map (verified line-by-line)

### Content entrypoints — identical except:

| Block | Divergence |
|---|---|
| Imports | same set, 3 lines reordered |
| Header comment | prose differs (Safari explains no-DNR + KTD1/KTD4; Chromium explains DNR split) |
| `defineContentScript` config | byte-identical (matches, `runAt:"document_start"`, `cssInjectionMode:"manifest"`) |
| cache/entitlement construction | identical (`SettingsCache(new ChromeStorageAdapter())`, `EntitlementCache(new ChromeEntitlementAdapter())`) |
| `earlyShortsRedirect` call | identical body; Chromium gates it `if (import.meta.env.FIREFOX)` (`:39`), Safari unconditional (`:42-47`) |
| rule-set resolution | ONE token differs: `browser.storage.local` (Safari `:55`) vs `chrome.storage.local` (Chromium `:55`) |
| `createContentScript({...})` deps block | identical incl. `manifestCssOwnsHides: source === "bundled"` and inline comment |
| Tail | genuinely divergent: Chromium = `void script.start()` + one fire-and-forget nudge (`:70-73`); Safari = the nudge machinery above (`:70-87`) |

Namespace note: Safari uses the WXT ambient `browser` global; Chromium uses ambient `chrome`.
Neither file imports them. Chromium background already does `import { browser } from "wxt/browser"`
(`background.ts:2`) — precedent for explicit import in shared code.

### Backgrounds — a thin shared core, large genuine divergence:

| Section | Safari | Chromium |
|---|---|---|
| `ruleSetEndpointFromEnv` | `:26-32` | `:46-52` — VERBATIM duplicate |
| rule-set refresh wiring (`ruleSetFetchConfig` + `refreshRuleSetCache`) | `:86-90` | `:55-61` — same shape, storage global differs |
| `{kind:"reconcile"}` nudge listener | `:71-77` → `reconciler.reconcile()` + `pullEntitlementFromApp()` | `:74-80` → `refreshRuleSetCache` + `session?.onNudge()` — same guard, different bodies |
| App-Group reconcile + native settings push + entitlement pull | `:44-57, :64-68, :79-81` | — | Safari-only |
| Session spine + privileged router + sender validation | — | `:63-121, :139-238` | Chromium-only |
| DNR gate | — | `:123-137` | Chromium-only |
| Settings hydration (`cache.watch()`/`hydrate()`) | (via reconciler) | `:64-66` | shapes differ |

Planner takeaway: the CONTENT factory is high-value (near-total duplication); the BACKGROUND
factory is thin — possibly just moving `ruleSetEndpointFromEnv` + the refresh wiring into
`core/rules` (see open question 6).

## Constraints (build system — WXT)

- WXT `^0.20.27`; `defineContentScript`/`defineBackground` are auto-import globals; the config
  block (`matches`/`runAt`/`cssInjectionMode`) must remain statically analyzable in the
  entrypoint file. A core factory can return the `main()` callback; the entrypoint keeps the
  `defineContentScript({ ...staticConfig, main })` wrapper.
- One package builds Chromium AND Firefox: `wxt build` vs `wxt build -b firefox`
  (`ext-chromium/package.json:7-16`); there is no ext-firefox package. The Firefox manifest
  branch lives in `wxt.config.ts:48-78` (`isFirefox`: drops DNR permission + rule_resources,
  adds `browser_specific_settings`; `manifestVersion: 3` forced; `cssHash` override for AMO
  reproducible builds).
- `import.meta.env.FIREFOX` (the early-redirect gate) and `import.meta.env.PROD` must stay
  statically visible to the bundler for dead-code elimination — confirm behavior if the gate
  moves into core (open question 3).
- Env: `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` feed `ruleSetEndpointFromEnv`,
  `createSessionSpine` (chromium bg `:148-149`), and `extensionPurchaseDeps`
  (`purchase-wiring.ts:47-48`). Core currently never reads `import.meta.env` — the existing
  convention passes values in (session spine precedent).
- `RULESET_ID = "youtube-shorts-redirect"` (chromium bg `:44`) must equal the manifest
  `rule_resources` id (`wxt.config.ts:75`) — two string literals, no shared constant today.

## The precedent to mirror: Extension UI factory

`core/src/ui/extension-setup.ts` (110 lines): `createExtensionUiController(purchase?, options?)`.
Purchase capabilities are an OPTIONAL injection passed only by ext-chromium entrypoints; the
uninjected default (Safari) stays purchase-free **by construction** (App Review 3.1.1 — code
not reachable, not merely disabled). Its tests (`core/src/ui/__tests__/extension-setup.test.ts`,
241 lines) lead with the Safari no-injection pin and use a hand-rolled in-memory
`chrome.storage.local` + `onChanged` stub (`installChrome()`, `:22-46`, via `vi.stubGlobal`).

Injection call shapes today:
- chromium popup/options: `createExtensionUiController(extensionPurchaseDeps())`
- safari popup/options: `createExtensionUiController(undefined, { onLocalSettingsCommit: (r) => void pushSettingsToApp(r) })`

The content factory should follow the same discipline: platform-specific behaviour
(Safari nudge machinery, Firefox early-redirect flag) enters as optional injections; the
uninjected default is the smallest correct build.

## Ordering/lifecycle invariants the factory must preserve (all currently in comments/tests)

1. Content `start()` order (`core/src/content/index.ts:129-143`): hooks installed synchronously
   at document_start (reapplies no-op until hydrated) → observer → cache/entitlement subscribe →
   `await hydrate` → watch → `hydrated = true` → first `reapply()`.
2. `earlyShortsRedirect` fires BEFORE the rule-set storage read (both entrypoints; core doc
   `:175-186`), awaits only `cache.hydrate()`, and re-reads `win.location.href` after the await
   (stale-URL guard, `:192-194`).
3. **Shared dedupe cell**: the SAME `RedirectDedupe` object must be passed to both
   `earlyShortsRedirect` and `createContentScript` (`core:45-51` doc — prevents double
   `location.replace` for one navigation).
4. Chromium background: `cache.watch()` before `hydrate()` (`:65-66`); DNR
   `cache.subscribe(syncRuleset)` registered before `hydrated.then(syncRuleset)` (`:135-136`);
   `session?.resume()` gated on hydration (`:121`); DNR capability guard early-return (`:124`).
5. Message listener contract: `sendResponse` + `return true` is "the one contract both Chrome
   MV3 and Firefox's chrome-namespace listeners honor" (chromium bg `:89-92`).

## Test infrastructure facts

- Both ext packages: vitest `environment: "node"`, `include: ["lib/**/*.test.ts"]` — entrypoints
  are structurally excluded. Core's vitest handles DOM-ish tests (redirect.test.ts runs jsdom).
- No fakeBrowser/wxt test utils in use; the established patterns are `vi.stubGlobal("chrome"|
  "browser", ...)` and injected fakes (`app-group-reconcile.test.ts` fakeLocal).
- A factory living in `core/src/content/` (or `core/src/extension/`) gets core's test rig and
  jsdom; that is where the currently-untestable wiring becomes ordinary unit tests: DNR-gate
  hookup, `manifestCssOwnsHides` branch selection, nudge lifecycle/teardown, hydration ordering.

## ADR-0001 tension (answer the "does it earn a factory" question)

ADR-0001 keeps the WKWebView bridge hand-routed because the kind set is small, changes rarely,
and **both sides have parse-reject tests**. The content-entry wiring is the opposite case:
~90% duplication maintained by hand (the "mirror fixes" convention exists because of exactly
this class of drift), zero tests on either copy, and a live divergence bug (the Safari nudge
leak) sitting in the duplicated tail. Deletion test: deleting the duplicated wiring and
concentrating it in one tested factory makes the complexity reappear in ONE place — it earns
its keep. The background side is closer to ADR-0001 territory (small shared core, large genuine
divergence) — recommend factoring only the genuinely shared pieces there.

## Open questions for the planning agent

1. Factory shape: e.g. `createExtensionContentEntry({ storage, earlyRedirect: boolean,
   nudge?: NudgeMachinery })` returning the `main()` body — exact injection unit TBD. Does the
   Chromium fire-once nudge become the uninjected default or an explicit injection?
2. Canonical namespace in the factory: injected storage/runtime params vs
   `import { browser } from "wxt/browser"` in core. (Injection matches the repo's port
   discipline and keeps core WXT-free; the chromium bg import is precedent for the other way.)
3. Verify the bundler still dead-code-eliminates per-target when `import.meta.env.FIREFOX` is
   evaluated in the entrypoint and passed as a boolean into the factory (it should — the gate
   stays in the entrypoint; only the gated CODE moves).
4. Nudge leak: fix inside the factory design (teardown array threading + a `stop()` the
   entrypoint owns) or as a pre-factory hotfix? (Recommend hotfix first; see bug section.)
5. Background factory scope: full factory vs just moving `ruleSetEndpointFromEnv` + refresh
   wiring into `core/rules` with env values passed in. (Recommend the minimal move.)
6. Should `RULESET_ID` get one shared home (core constant imported by both background and
   wxt.config)? Check WXT config can import from core at config-eval time.
7. Where do the factory's tests live and what do they pin first? (Suggest: the four ordering
   invariants above + the Safari-uninjected-purchase-free-by-construction analog.)

## Relationship to other dossiers

- Touches the same content entrypoints as dossier 002 (which edits the
  `manifestCssOwnsHides`/CSS-import area) and consumes the engine interface dossier 003 may
  change. Recommended order: 002's deletion → this factory → 003's hot-path work (so hot-path
  changes land against a single wired call site). The nudge-leak hotfix is independent — do it
  immediately.
