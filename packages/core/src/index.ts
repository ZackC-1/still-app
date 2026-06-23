// @still/core — shared rule engine, content script, storage, sync, and UI.
//
// Submodules are exposed via package.json "exports" subpaths and filled in by:
//   U6  → ./rules    (rule engine)
//   U7  → ./content  (content script + redirect + observer)
//   U8  → ./storage  (settings model + storage adapter)
//   U9  → ./ui       (Svelte settings/paywall UI)
//   U13 → ./sync     (auth + settings sync)

export const STILL_CORE_VERSION = "0.0.0";
