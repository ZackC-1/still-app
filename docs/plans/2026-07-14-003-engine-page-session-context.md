# Context dossier: Engine per-frame hot path — prepared page session (deepening candidate 1)

- **Status**: context for planning — no implementation done.
- **Grounded at**: commit `5470713` (main, 2026-07-14). Verify line anchors before editing.
- **Origin**: `/improve-codebase-architecture` review, 2026-07-14. Goal: pre-release hardening —
  this is the efficiency-critical candidate. Highest-care item of the four; recommended to land
  LAST, against the strengthened test net from the other dossiers.

## The problem

`evaluate` and `applyDom`/`applyRemovals` were extracted as independent pure functions (good:
the whole engine is jsdom-testable), but the content script calls them back-to-back on every
rAF-coalesced mutation frame, and each independently re-derives everything from scratch. On an
infinite feed the DOM grows without bound, and the per-frame cost with it. Verified per-frame
work in `reapply` (`core/src/content/index.ts:84-125`):

1. `new URL(win.location.href)` allocated every frame (`:88`) even when the URL is unchanged.
2. `evaluate` (`engine.ts:100-139`) calls `resolveActiveService` (`:106`) → `resolveService`
   (`match.ts:38-45`), which iterates all 4 services × match patterns, and `pathMatches`
   (`match.ts:32-36`) compiles a **fresh `RegExp` per pattern per call**.
3. The chosen apply verb calls `resolveActiveService` **again** (`applyActions`,
   `engine.ts:180`) — the full service resolution runs twice per frame. `cache.current()` is
   also read twice (`index.ts:95` and `:114`).
4. `evaluate` re-filters surfaces by tier every frame (`:109`), and `applyActions` re-checks
   `surfaceEnabledForTier` per surface again (`:184`).
5. The redirect loop runs `safeExec(s.redirect.urlMatch, path)` → `new RegExp(pattern)` per
   redirect surface per frame (`engine.ts:126`, `:273-279`) — on a scrolling `youtube.com/feed`
   page the Shorts pattern recompiles every frame despite never matching.
6. `applyActions` runs `doc.querySelectorAll(sel)` per selector over the WHOLE document per
   frame (`:187`, `:194`). The observer callback **discards its `MutationRecord[]`**
   (`observer.ts:30-34`) — no scoping to added subtrees.
7. `isServiceActive` → `isPaused` → `etldPlusOne` string work also runs twice per frame
   (`engine.ts:53-55`, `match.ts:47-57`).

**There is no memoization anywhere in the hot path** (verified: no compiled-regex cache, no
resolved-service cache, no filtered-surface cache, no URL-parse cache in `rules/` or
`content/`). The only "caches" are the settings/entitlement snapshot caches (O(1) `current()`
reads — those are fine).

## The deepening direction (to be designed, not prescribed)

Deepen the Engine's interface with a *prepared page session*: compile what is immutable once,
re-derive what changes only when it changes, and expose a small per-frame apply. Three natural
tiers of preparation, keyed by what actually varies (see invalidation table below):

- **Per rule set (fixed for the page)**: compiled `matches` path patterns, compiled
  `urlMatch`/`redirect.urlMatch` regexes, per-service surface groupings by action.
- **Per (URL, settings, entitlement)**: resolved active service, tier-filtered surface list,
  the decision (redirect/placeholder/apply/noop).
- **Per frame**: only the DOM walk over the precomputed selector list.

On the bundled-seed fast path (`manifestCssOwnsHides:true` — ~100% of users today), the
per-frame work for YouTube free could reduce to: "walk 14 precomputed remove selectors" —
nothing else.

## Inputs and invalidation (verified)

| Input | Read at | Changes mid-page? | Invalidation signal |
|---|---|---|---|
| `ruleSet` | closed over, `index.ts:68` | **No** — resolved once at document_start, no `still:ruleset` storage listener | none needed |
| `manifestCssOwnsHides` | `index.ts:112` | **No** — fixed at construction | none needed |
| URL | `index.ts:88` | Yes (SPA nav) | compare `location.href` string before re-parsing |
| Settings snapshot | `index.ts:95,114` | Yes (storage/cloud writes) | LWW replaces the WHOLE snapshot object (`storage/cache.ts:90,117,139`) — object identity is a valid dirty check; `cache.subscribe` already fires reapply (`index.ts:134`) |
| Entitlement `pro` | `index.ts:93` | Yes (can flip mid-page; Playwright does this) | boolean compare; `entitlement.subscribe` already fires reapply (`:135`) |
| `hydrated` | `index.ts:87` | Flips false→true once | existing gate stays |

Reapply triggers (none share coalescing with each other): observer (rAF-latched,
`observer.ts:25-34` — at most one observer-driven reapply per frame), navigation hooks
(`redirect.ts:46-73`, synchronous), settings subscribe, entitlement subscribe, post-hydration
one-shot (`index.ts:130-143`). A settings write + mutation + pushState in one tick = 3 full
passes today.

## Blast radius (verified — favorable)

- `evaluate`, `applyDom`, `applyRemovals`, `resolveActiveService`, `resolveService` have **no
  production callers** outside `createContentScript.reapply` (`index.ts:95,112`) and
  `earlyShortsRedirect` (`index.ts:195`). `app-webview` does not use the engine at all. All are
  re-exported from `rules/index.ts:19-38` but have no external importer.
- The only coupling to the current shape is `rules/__tests__/engine.test.ts` (~40 direct call
  sites building `(ruleSet, settings, url[, doc][, opts])` by hand). The interface can change
  shape freely if those tests are migrated or the pure functions are kept as thin wrappers over
  the session internals.
- **No test pins the resolution count** — consolidating the double-resolve is guarded only
  indirectly by outcome tests. Conversely, nothing breaks from consolidating it.

## Invariants that must survive (verbatim anchors)

1. Engine purity: "Pure functions over a rule set + settings + a DOM, so the whole thing is
   unit-testable in jsdom without a browser" (`engine.ts:4-6`). A session object must stay
   jsdom-constructible with injected inputs.
2. The one-contract rule: `resolveActiveService` is "the single place `evaluate()` and
   `applyDom()` agree on 'a valid active service'" (`engine.ts:79-84`); pinned by the U6 test
   (`engine.test.ts:31-49`). A session makes this contract structural — the test should evolve
   to pin it at the new interface, not disappear.
3. Fail-closed monetization: `pro = deps.entitlement?.current() ?? false` (`index.ts:89-94`);
   `surfaceEnabledForTier` semantics incl. `ALWAYS_FREE_SURFACE_IDS` net (`engine.ts:204-211`).
   Precomputed tier-filtered lists must recompute when `pro` flips.
4. Hydration gating and flash correctness (`index.ts:85-87`, `:22-29`); pinned in
   `redirect.test.ts:165,180,299-335`.
5. Redirect dedupe: shared `RedirectDedupe` cell between early redirect and reapply
   (`index.ts:45-51,99-102`); stale-URL re-read after awaits (`index.ts:192-194`).
6. Selector-failure isolation: "a selector the engine can't parse must not abort the whole
   pass" (`engine.ts:285`) — per-selector try/catch must survive precompilation.
7. Placeholder re-render loop guard (`engine.ts:242-243`) — `renderPlaceholder` no-ops when
   already rendered because replaceChildren feeds the observer.
8. `applyRemovals`-vs-`applyDom` split semantics (`engine.ts:152-159` doc; pinned by
   `engine.test.ts:245-254`) and the `manifestCssOwnsHides` selection (`index.ts:112`,
   doc `:52-58`).

## Scale facts (seed v1.0.4)

4 services, 20 surfaces, 48 selectors, **29 of them use `:has()`**. YouTube (the only free
service, the scale case): 7 surfaces / 22 selectors — 3 remove surfaces (14 selectors, 8 with
`:has()`), 4 hide surfaces (CSS-owned on the fast path), 1 redirect
(`^/shorts(?:/([\w-]+))?/?$`). One `blockSite` (TikTok), two `placeholder` URL-matchers
(IG/FB). `ALWAYS_FREE_SURFACE_IDS` = exactly the 7 YouTube surface ids (`engine.ts:69-77`).

## Test inventory

- **Survives unchanged (black-box)**: all of `redirect.test.ts` and `observer.test.ts` — they
  assert DOM/redirect outcomes through `createContentScript`, never internal call counts.
  Playwright fixtures (16 tests, bundled path) likewise.
- **Couples to the current shape**: `engine.test.ts` direct calls — navigation-decision matrix
  (`:73-124`), toggle matrix (`:127`), safety model (`:144-179`), monetization gating
  (`:182-392`), the U6 contract (`:31-49`), applyRemovals split (`:245-254`). Migration or
  wrapper-preservation is a planning decision.
- **Missing**: any perf signal. No benchmark or call-count test exists (grep confirmed). A
  planner should define the acceptance signal — e.g. a call-count assertion ("N frames on an
  unchanged URL compile zero regexes / resolve the service once") via injected counters, which
  the session interface makes possible for the first time.

## Design considerations / open questions for the planning agent

1. **Mutation-scoped apply is a trap — treat as out of scope.** 29 of 48 selectors use
   `:has()`: a newly-added descendant can flip a `:has()` match on an EXISTING ancestor, so
   scoping `querySelectorAll` to `addedNodes` subtrees is not semantics-preserving. The
   whole-document sweep per frame stays; the win is everything AROUND it (resolution, regex,
   filtering, allocation) plus possibly cheaper selector lists.
2. **Invalidation**: snapshot object identity (settings) + boolean compare (pro) + href string
   compare (URL) appears sufficient — LWW replaces the whole settings object. Confirm no code
   mutates the snapshot in place.
3. **Coalescing across triggers**: should nav-hook/subscribe reapplies share the observer's
   rAF latch? Caution: the redirect decision path is deliberately synchronous-ish (early
   redirect must beat paint; `index.ts:178-186`). Redirect and apply may need different
   cadences — a planner should decide whether coalescing is in scope at all or a follow-up.
4. **Where compiled patterns live**: cache on the (immutable) rule-set object at session build,
   not module-global (avoids cross-test leakage; rule set is fixed per page).
5. **Fate of the pure exports**: keep `evaluate`/`applyDom`/`applyRemovals` as thin wrappers
   building a throwaway session (zero test churn, keeps the public surface), or migrate
   `engine.test.ts` to the session interface. Recommend wrappers first, migrate tests
   opportunistically.
6. **Placeholder/blockSite pages**: the observer keeps firing full `evaluate` every frame on a
   page whose outcome is idempotent (`renderPlaceholder` guards the render, not the compute).
   With a session, the cached decision makes this nearly free — decide whether
   disconnecting the observer on blocked pages is worth the added lifecycle complexity
   (probably not; the cache suffices).
7. **`Object.entries` service-iteration order** (`match.ts:39`) is deterministic for a fixed
   rule set (JS own-property order) — caching the resolved service per URL is safe.
8. **`earlyShortsRedirect`** duplicates the match/regex work (`index.ts:187-204`); it runs once
   pre-hydration, so leaving it outside the session is fine — but if the session compiles
   patterns at rule-set load, it can share them for free.

## Relationship to other dossiers

- Land AFTER dossier 002 (both edit `engine.ts`; 002's recommended option deletes
  `generateHideCss` and consolidates tests in the same file) and after 004 (so the hot path
  changes land against a single wired call site with factory-level tests).
- The `manifestCssOwnsHides` orchestrator-level test that dossier 002 calls for is also the
  regression net this refactor needs — build it first regardless of sequencing.
