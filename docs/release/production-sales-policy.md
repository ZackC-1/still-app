# Production sales policy

`production-sales-policy` is a closed operation in the protected **Supabase production deploy**
workflow. It publishes only the fixed production body. It accepts `policy_mode=on` or `off` and
the current production sales revision from PROD-01 as `policy_expected_revision`.

The first `on` appends the sales policy and writes the immutable `still-free-v2` cutoff in the same
transaction. Its benefits are exactly `facebook.reels`, `instagram.reels`, `tiktok.all` and
`youtube.shorts`, approved by the owner on 21 October 2026. Subsequent on/off operations preserve
that cutoff. They never modify rights, purchase records, settings, roles or sandbox policy rows.

The candidate admission list is Chrome and Firefox desktop `3.0.0`, Apple mobile/macOS hosts
`3.0`. Android is excluded. **The on operation remains provisional and refuses production apply**
until the final packaged version strings have been checked against this list and the provisional
reason is removed in a reviewed change. It can be planned and rehearsed before that gate clears.
The off operation remains available independently so a release hold cannot prevent stopping sales.

Use the standard workflow sequence: pin a reviewed commit on main, run plan-only, inspect the
exact body and cutoff in its summary, then request apply of that same plan through the protected
environment. Migrations and function lists remain empty. The plan binds the SQL and verification
bytes by hash. The operation checks the expected revision under the policy advisory lock; a stale
revision or a body differing from the reviewed plan rolls back without writes.

`off` stops new sales. It does not revoke paid access, erase the cutoff, interrupt free sync or
prevent recovery of already-paid checkout attempts. Roll forward with another reviewed revision
when ready; never edit or delete the immutable cutoff.

Disposable PostgreSQL rehearsals exercise the actual operation code with an existing sandbox
policy and cutoff, negative inputs, append-only revisions, repeat detection and off/on recovery.
Production and QA use fixed SQL files and opposite environment guards. The shared planner and
rehearsal reduce duplication; no caller selects an arbitrary environment, build list or cutoff.
