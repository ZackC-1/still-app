# Fresh Session Prompt - Implement Near-Realtime Settings Sync

Use this prompt to start a separate Codex session whose only job is to implement the near-realtime
settings sync spec, open a PR, drive checks to green, and merge it. This work must run in a separate
git worktree so it does not interfere with the active release-testing session in
`/Users/zack/Projects/still-app`.

```text
You are Codex working on the Still app. Your task is to fully implement, test, open a PR for, and
merge the near-realtime settings sync feature.

Repository:
- Main checkout: /Users/zack/Projects/still-app
- GitHub repo: ZackC-1/still-app
- Default branch: main

Important constraints:
- Do not work directly in /Users/zack/Projects/still-app. That checkout is being used by a parallel
  release-testing session and may have unrelated dirty files.
- Create and work from a separate git worktree:
  - cd /Users/zack/Projects/still-app
  - git fetch origin
  - git worktree add ../still-app-sync-pr -b feat/near-realtime-settings-sync origin/main
  - cd ../still-app-sync-pr
- The spec may currently be uncommitted in the main checkout. Copy it into your worktree before
  implementation:
  - cp /Users/zack/Projects/still-app/docs/plans/2026-07-09-001-near-realtime-settings-sync-spec.md \
       /Users/zack/Projects/still-app-sync-pr/docs/plans/2026-07-09-001-near-realtime-settings-sync-spec.md
- Preserve unrelated release-testing changes in the main checkout. Never run destructive git commands
  against /Users/zack/Projects/still-app.

Before coding:
- Read AGENTS.md and obey the project instructions, especially CodeGraph-first rules for code-flow
  questions.
- Read the full implementation spec:
  docs/plans/2026-07-09-001-near-realtime-settings-sync-spec.md
- Read current sync/security context:
  docs/ARCHITECTURE.md
  docs/monetization-design.md
  supabase/migrations/0001_init.sql
  supabase/migrations/0002_rls.sql
  supabase/migrations/0008_profiles_write_requires_entitlement.sql
  supabase/tests/rls_test.sql

Goal:
- Implement server-authoritative, near-realtime, latest-surface-wins settings sync across iOS,
  macOS, Safari extension, Chrome extension, and Firefox extension.
- The server/database must be the ordering authority. Device clocks must not determine the
  cross-surface winner.
- Active signed-in entitled surfaces should converge automatically without manual restore, relaunch,
  or "sync now" actions.

Required implementation outcomes:
1. Database/RLS
   - Add the migration described in the spec.
   - Add server-authoritative profile metadata:
     - settings_version
     - settings_server_updated_at
     - settings_last_write_id
   - Add write_profile_settings(p_settings jsonb, p_write_id uuid).
   - The RPC must derive the user from auth.uid(), verify still_sync entitlement, validate settings
     is a JSON object, increment settings_version, stamp server time, and return the canonical
     settings envelope.
   - Enable profiles for Supabase Realtime.
   - Remove or deny direct authenticated profile insert/update once clients use the RPC.
   - Extend pgTAP/RLS tests to prove entitlement gating, no cross-user writes, direct write denial,
     version increments, timestamp updates, and invalid JSON rejection.

2. Core sync model
   - Add a SyncedSettingsEnvelope/metadata model.
   - Update BackendPort, SupabaseBackendPort.readProfile(), writeProfile(), and realtime subscribe
     support.
   - Profile writes must call the RPC, not direct upsert.
   - Profile reads must return settings plus server metadata.
   - Realtime subscription must be scoped to the signed-in user's own profile row.
   - Defensive parsing: invalid settings/envelopes are ignored safely.

3. Settings cache and conflict resolution
   - Persist cloud sync metadata alongside settings.
   - Add a cloud-aware apply path that uses highest server version as the primary ordering key.
   - Keep local optimistic UI updates immediate.
   - Keep local settings APIs working:
     - setGlobalOn
     - setService
     - pauseHost
     - resumeHost
   - Do not use settings.updatedAt for cross-surface conflict resolution after this feature lands.

4. SyncService orchestration
   - Start realtime after sign-in and entitlement confirmation.
   - Stop realtime on sign-out, delete account, entitlement false, and identity switch.
   - On local edits, coalesce writes but preserve latest local intent.
   - On RPC success, apply the returned server envelope.
   - On RPC failure, keep local optimistic settings and mark cloudReachable false.
   - On higher-version remote event, apply it immediately.
   - If a higher-version remote event arrives while a local write is in flight, remote wins and stale
     write acknowledgements must not overwrite it.
   - On realtime reconnect, run a one-shot readProfile() before trusting the stream as current.

5. Apple surfaces
   - Extend Apple App Group settings storage to persist sync metadata with settings.
   - Maintain backward compatibility with old settings-only App Group records.
   - Ensure WKWebView/app settings writes and remote sync applies update the App Group record.
   - Ensure Safari extension startup/activation reads settings plus metadata before applying rules.
   - Add active-page refresh/reapply behavior where possible so already-open supported pages learn
     updated settings without a manual app relaunch.

6. Chrome/Firefox surfaces
   - Persist settings metadata in extension storage.
   - Ensure popup/options/content scripts observe storage changes.
   - Re-run/debounce rule application after settings changes.
   - Ensure MV3 worker wake/resume rehydrates metadata before writing.
   - Keep Firefox behavior compatible with the Chromium package's Firefox build.

7. Tests
   - Add focused unit tests for metadata ordering:
     - higher version applies;
     - lower version ignored;
     - equal version does not double-notify;
     - invalid envelope ignored;
     - future-skewed device updatedAt does not beat a newer server version.
   - Add SyncService tests:
     - local edit -> RPC -> returned version applied;
     - remote realtime higher version updates local settings;
     - lower version ignored;
     - remote higher version during in-flight local write wins;
     - write failure keeps local optimistic settings and sets cloudReachable false;
     - reconnect reads profile;
     - teardown unsubscribes.
   - Add Apple bridge/storage tests for old and new App Group records.
   - Add Chrome/Firefox storage propagation tests.
   - Extend Supabase RLS tests.

Required verification commands:
- supabase test db
- pnpm --filter @still/core typecheck
- pnpm --filter @still/core test
- pnpm --filter @still/app-webview typecheck
- pnpm --filter @still/ext-safari test
- pnpm --filter @still/ext-safari build
- pnpm --filter @still/ext-chromium test
- pnpm --filter @still/ext-chromium build
- pnpm --filter @still/ext-chromium build:firefox
- apps/apple/scripts/build.sh ios
- apps/apple/scripts/build.sh macos

If a listed command does not exist, find the repository's actual equivalent, update the spec or PR
notes with the correction, and run the equivalent. Do not skip verification silently.

PR workflow:
1. Work only on branch feat/near-realtime-settings-sync in ../still-app-sync-pr.
2. Commit intentionally. Include the spec file in the PR if it is not already on main.
3. Push the branch:
   - git push -u origin feat/near-realtime-settings-sync
4. Open a PR with gh:
   - gh pr create --title "feat: near-realtime settings sync" --body-file <generated-pr-body.md>
5. The PR body must include:
   - Summary of database/RLS changes.
   - Summary of client sync/runtime changes by surface.
   - Security notes.
   - Migration/rollback notes.
   - Full verification command list and results.
   - Any residual risks.
6. Watch GitHub checks:
   - gh pr checks --watch
7. If checks fail, inspect logs, fix the issue, push follow-up commits, and repeat until green.
8. When all required checks are green and the branch is up to date with main, merge the PR:
   - Prefer squash merge unless the repository requires a different strategy.
   - gh pr merge --squash --delete-branch

Autonomy:
- Do not ask the user for implementation choices already specified in the spec.
- Make conservative technical decisions aligned with the existing codebase.
- Do not deploy Supabase migrations/functions to production unless the repository's established PR
  workflow explicitly requires it. Merging the migration is sufficient for this task.
- Do not weaken entitlement gating or expose service-role/narrow-writer secrets to clients.
- Do not alter App Store, RevenueCat, pricing, or release metadata except for documentation updates
  directly required by the sync feature.
- Do not merge if local verification or GitHub checks are failing.

Definition of done:
- The spec is implemented.
- Required tests and builds pass locally.
- The PR is opened with a complete body.
- GitHub checks pass.
- The PR is merged into main.
- The branch is deleted.
- Final response reports the merged PR URL, merge commit/SHA if available, and any follow-up risks.
```
