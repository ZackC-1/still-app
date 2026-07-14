# Context dossier: the hide-CSS seam (deepening candidate 2)

- **Status**: context for planning — no implementation done. A planning agent should read this
  end-to-end, resolve the open questions, and produce a plan.
- **Grounded at**: commit `5470713` (main, 2026-07-14). Line references are anchors — verify
  before editing; concurrent PRs may shift them.
- **Origin**: `/improve-codebase-architecture` review, 2026-07-14. Goal: pre-release hardening —
  app as functional and efficient as possible. Vocabulary: domain terms per `CONTEXT.md`;
  "module/interface/seam/adapter/depth/locality" per the architecture-review glossary (a **seam**
  is where an interface lives; an **adapter** is a concrete thing satisfying the interface there;
  one adapter = hypothetical seam, two = real).

## The problem

The hide-CSS seam was designed for two adapters and only one was ever built:

1. **Build-time adapter (exists)**: `gen-content-css.mjs` generates `still.css` (free) +
   `still-pro.css` (pro) from the bundled seed; both are manifest-injected at `document_start`.
   When the applied rule set IS the bundled seed (`source === "bundled"`), the content script
   sets `manifestCssOwnsHides: true` and the per-frame path runs `applyRemovals` (removes only —
   CSS owns hides). This is the hot-path win 100% of users get today.
2. **Runtime adapter (never built)**: `generateHideCss` (`packages/core/src/rules/engine.ts:218-235`)
   exists for "runtime-injected [CSS] for fetched ones" per its own doc comment — but it has
   **zero runtime callers** (verified: only `engine.test.ts` references it) and no runtime style
   injection exists anywhere in the repo (grep for `insertCSS|adoptedStyleSheets|insertRule|`
   `createElement("style")` in product code: none).

Consequences:

- **The OTA performance cliff**: the moment a fetched/cached rule set applies
  (`source !== "bundled"`), `manifestCssOwnsHides` is false and the content script runs
  `applyDom` — a full hide-selector `querySelectorAll` sweep over the whole growing document
  every mutation frame. An OTA selector hotfix silently downgrades the hot path for every user.
- **Triplicated formatter**: the "hide selector → CSS rule" logic exists in three hand-synced
  copies: `engine.ts:218-235` (`generateHideCss`, dead), `gen-content-css.mjs:30-40` (real),
  and `content-css.test.ts:14-28` (`expectedCss`, drift-detection mirror). PR #64 already caught
  the chromium committed CSS drifting a seed version behind.
- **Four committed generated artifacts**: `still.css`/`still-pro.css` are checked into BOTH
  `ext-safari/entrypoints/content/` and `ext-chromium/entrypoints/content/`, byte-identical,
  regenerated only by `build`/`zip`/`gen-css` scripts (NOT by `dev`), pinned only by a vitest
  byte-match test.

## Decision required (the design fork)

**Option A — make the runtime adapter real.** Wire runtime CSS injection for fetched sets
(inject `generateHideCss(fetchedSet)` output into the page at apply time), so `applyRemovals`
stays the per-frame path regardless of rule-set source. The seam becomes real (two adapters).

**Option B — delete the hypothetical seam.** Delete `generateHideCss`, single-source the
formatter (e.g. `gen-content-css.mjs` becomes the one home, and the drift test asserts against
it rather than re-implementing), and record an ADR: "OTA rule sets accept the per-frame JS hide
sweep; revisit when OTA is actually exercised in production."

**Recommendation: Option B now, Option A as a post-release follow-up.** Rationale:

- The hot path for ~100% of real users today is the bundled seed (fast path already). The OTA
  path is likely **dormant in production**: it activates only if store builds were compiled with
  `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` set AND a prod-signed set strictly newer than the
  bundled seed (v1.0.4) exists — the documented prod-published set is v1.0.1
  (`docs/production-rule-set-keys.md`, `supabase/migrations/0006_prod_rule_set.sql`), which
  `resolveRuleSet`'s strictly-newer rule would ignore.
- Option A adds new code on a security-relevant path (injecting styles derived from fetched
  data) days before release; Option B is a deletion plus test consolidation — near-zero risk,
  and it removes the drift-prone triplication, which is the live pre-release danger (PR #64
  precedent).
- The user should confirm this fork explicitly before implementation.

## Current architecture (verified)

**Generator** — `packages/core/scripts/gen-content-css.mjs` (52 lines). Reads
`packages/core/rules/seed.json` (currently v1.0.4). For every surface with
`action === "hide" && enabledByDefault && selectors`: selector → `html.still-active {sel}` when
`tier === "free"`, else `html.still-pro-active {sel}`, each `{display:none!important}`. Writes
`still.css` + `still-pro.css` per target dir with a "do not edit by hand" header. NOTE: it
buckets purely on `tier === "free"` — it does NOT apply the engine's `ALWAYS_FREE_SURFACE_IDS`
runtime safety net (deliberate; header comment at `:1-12` explains the seed always tags
surfaces, and the runtime net exists for fetched sets with stale tags).

**Invocation**: `gen-css` script in both extension packages; prepended to ext-chromium
`build`/`build:firefox`/`zip`/`zip:firefox` and ext-safari `build`. NOT run by any `dev` script;
Safari has no `zip`. CI runs `pnpm build` in both the check and e2e jobs, so CI always
regenerates. No `git diff --exit-code` gate — drift is caught only by the vitest byte-match.

**Loading**: both content entrypoints `import "./still.css"` / `import "./still-pro.css"`
(lines 1-2 in each) with `cssInjectionMode: "manifest"`, `runAt: "document_start"`. Both
stylesheets ship unconditionally in the manifest; **pro gating is by root class, not injection**:
free rules scope under `html.still-active`, pro rules under `html.still-pro-active`, and the
content script toggles those classes (`core/src/content/index.ts:77-82`, `:96-124`) with
`pro = deps.entitlement?.current() ?? false` (`:93`, fail-closed to free).

**The branch**: `manifestCssOwnsHides: source === "bundled"` set identically in both content
entrypoints (`:53-69` in each). Used at `core/src/content/index.ts:109-119`:
`(deps.manifestCssOwnsHides ? applyRemovals : applyDom)(ruleSet, cache.current(), url, doc, opts)`.
`applyDom` = `applyActions(..., includeHide: true)` (`engine.ts:141-150`); `applyRemovals` =
`applyActions(..., includeHide: false)` (`engine.ts:160-168`, doc comment at `:152-159` states
the fast-path rationale verbatim). The hide sweep in `applyActions` (`engine.ts:170-202`) is
`querySelectorAll(sel)` per selector across the whole document + inline
`style.setProperty("display","none","important")` per node, per rAF-coalesced mutation frame.

**When is `source !== "bundled"`?** Only when `browser.storage.local["still:ruleset"]` holds a
cached set that passes schema+Ed25519 verification against this build's trusted keys
(`readCachedRuleSet`, `loader.ts:67-82`, re-verified on every read) AND is strictly newer than
the bundled seed (`resolveRuleSet`, `fetch.ts:124-139`). The cache is written only by the
background's `refreshRuleSetCache` (`loader.ts:109-127`, single-flight, strictly-newer write
gate) on a previous load. **A fetched set never applies mid-page** — the content entrypoints
resolve once at document_start and close over the result; there is no storage listener for
`still:ruleset`.

**Endpoint config**: `ruleSetEndpointFromEnv()` (duplicated verbatim: `ext-safari/entrypoints/`
`background.ts:28-32`, `ext-chromium/entrypoints/background.ts:48-52`) reads
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`. Blank env → no endpoint → `ruleSetFetchConfig`
returns null → no fetch (documented intent in `ext-chromium/.env.example`). Prod trusted key
`still-prod-1` is populated in `trusted-keys.ts:13-15` — the "empty prod keys" fail-safe prose
at `loader.ts:18-21` is stale.

## Invariants that must survive any change

1. **KTD2 no-flash**: the root classes are added only post-hydration and only when the service
   is on; with no class, no packaged CSS matches. Pinned by
   `core/src/content/__tests__/redirect.test.ts:165` ("off-user: the root class is absent at
   document_start AND after hydration"), `:180`, `:188`, `:205`; orchestrator header comment at
   `core/src/content/index.ts:22-29`. Playwright: `tests/playwright/fixtures.spec.ts:32,56`.
2. **Free users never get pro hides**: pro rules only under `still-pro-active`; entitlement
   fail-closed (`?? false`). Pinned by `content-css.test.ts:32,44` and fixtures `:67,103`.
3. **Drift pin**: committed CSS must byte-match the seed-derived expectation
   (`content-css.test.ts:60-63`; covers BOTH packages via a loop — there is no chromium twin).
4. **OTA correctness**: a fetched set's hide selectors must still hide (today via `applyDom`).
   Whatever option is chosen, an OTA set must not silently stop hiding.
5. **Strictly-newer version discipline** (`fetch.ts:136`, `loader.ts:119`) and re-verify-on-read
   (`loader.ts:67-82`) are security properties — do not weaken while touching the loader.

## Facts a planner needs (with evidence)

- `generateHideCss` full refs: definition `engine.ts:218-235`; barrel re-export
  `core/src/rules/index.ts:29`; tests `engine.test.ts:9,395-415`. Nothing else. Its doc comment
  (`engine.ts:213-217`) describes the never-built runtime-injection design — stale.
- Its bucketing diverges from the real generator: it takes a single `rootClass` param and
  applies `surfaceEnabledForTier` (which includes the `ALWAYS_FREE_SURFACE_IDS` net); the mjs
  hard-codes the two root classes and ignores the net. If Option B consolidates, decide which
  semantics are canonical for CSS (see open questions).
- Security note (relevant to Option A): `generateHideCss` interpolates selectors into CSS with
  no `isSafeSelector` guard of its own; fetched sets are schema-validated (`schema.ts`,
  `isSafeSelector`) and signature-verified upstream, but a runtime-injection adapter should
  treat selector safety as part of its interface, not an ambient assumption.
- Stale-CSS layering (relevant to Option A's value and Option B's ADR text): manifest CSS
  cannot be un-injected at runtime. When a fetched set applies, the OLD bundled hide rules are
  still active on top. A fetched set that only ADDS selectors is fine; one that RETRACTS an
  over-hiding selector cannot retract it from the packaged CSS on that page load. Neither
  option fixes this; the ADR should state it as an accepted limitation of OTA (over-hiding
  persists until a store release), or Option A's design must scope runtime CSS to replace, not
  augment (not possible for manifest CSS — only root-class scheme changes could do that).
- History: `c40c8c2` (applyRemovals fast path — commit message documents the design),
  `ae4b5c1` (collapsed per-extension generators into the one core script), `7e9e6b4` (PR #64
  drift fix + byte-parity pin; message explains how stale chromium CSS made the issue-#58 rule
  silently inert in zips).

## Test inventory (current)

- `engine.test.ts:395-415` — `generateHideCss (KTD2)`: scoping, hide-only, free-only exclusion.
  These die (Option B) or move to the new adapter's interface (Option A).
- `engine.test.ts:245-254` — `applyRemovals` leaves hides alone, removes removes.
- `content-css.test.ts` (ext-safari, covers both packages) — free/pro split + byte parity.
- `redirect.test.ts` — flash/root-class/hydration (listed above).
- Playwright fixtures — bundled path only. **Nothing anywhere exercises the fetched-set content
  path end-to-end, and nothing pins the `manifestCssOwnsHides ? applyRemovals : applyDom`
  branch selection at the orchestrator level** (grep: no test passes `manifestCssOwnsHides`
  into `createContentScript`).

## Gaps to close regardless of option

1. Add an orchestrator-level test: `createContentScript` with `manifestCssOwnsHides:true` skips
   hide sweeps; with false/omitted, hides apply via JS. (Closes the branch-selection blind spot.)
2. De-triplicate the formatter: after the fork decision, exactly one implementation should
   exist, with the drift test asserting against IT (not a third copy).
3. Doc drift fixes: `engine.ts:213-217` doc comment; `loader.ts:18-21` stale fail-safe prose;
   `docs/production-rule-set-keys.md` cites deleted `packages/ext-safari/lib/rule-set.ts` (logic
   now in `core/src/rules/loader.ts`); `docs/monetization-design.md:96-101` still names
   `generateHideCss` as the generator.
4. Consider a CI `git diff --exit-code` after gen-css (or a `dev`-time regen) so committed
   artifacts can't drift between builds — currently only the vitest pin guards this.

## Open questions for the planning agent

1. Confirm the fork (A vs B) with the user — recommendation above is B now / A post-release.
2. Is production OTA actually live? (Store builds' env at compile time is not verifiable from
   the repo; live prod rule-set version needs a Supabase check: `get_current_rule_set()`.)
3. If B: where does the canonical formatter live — keep `gen-content-css.mjs` self-contained
   (plain node, no TS build needed) or move to an importable TS module both the script and the
   drift test consume? (The mjs currently can't import TS from core/src.)
4. If B: should the ADR also record the stale-CSS layering limitation (over-hiding persists
   until a store release retracts a packaged selector)?
5. Should `ALWAYS_FREE_SURFACE_IDS` apply to CSS bucketing? (Today: no, deliberately. Keep the
   asymmetry documented wherever the formatter ends up.)

## Relationship to other dossiers

- **Dossier 003 (engine page session)**: shares the hot path; if both proceed, land this one's
  deletion first (small), then the hot-path work — they touch `engine.ts` in overlapping regions.
- **Dossier 004 (extension entry factory)**: touches the same content entrypoints that set
  `manifestCssOwnsHides`; sequence to avoid churn (see index doc).
