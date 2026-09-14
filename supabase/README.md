# Supabase backend

| Folder | Purpose |
|---|---|
| `functions/` | Account, settings-support, entitlement, webhook, reviewer sign-in and canary endpoints. Each deployed function has an `index.ts`; shared adapters live in `_shared/`. |
| `migrations/` | Ordered database schema, policies, rule data and retention history. Keep applied migrations; add a migration for a new database change. |
| `tests/` | Database policy checks and the separately invoked disposable-database retention test. |

For local function checks, run from this directory:

```sh
(cd functions && deno lint && deno check */index.ts && deno test)
```

The canonical Deno configuration/lockfile live under `functions/`. For database setup and
integration-test prerequisites, use [connections](../docs/CONNECTIONS.md) and
[counter retention](../docs/release/counter-retention.md). Production deployment is a separate
release operation. Preserve dormant billing infrastructure and historical entitlements while the
paid tier is disabled; see [RevenueCat](../docs/release/04-revenuecat.md).
