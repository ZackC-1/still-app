# Expected log noise from older 2.1 apps after new sync

Status: **expected behavior, no action needed.** Nothing here is a fault, and nothing in Still
changes because of it. This page tells whoever reads the Supabase logs what the noise is, so it is
not mistaken for an outage.

## Why it appears

Still 2.1 (and 2.0) save settings by sending the whole settings document. New sync saves one setting
at a time. Once a person's account has used new sync (or its settings were written by a newer client), the
database refuses those old whole-document saves on purpose, so an old app can never overwrite newer per-setting changes. The refusal changes
nothing in the account.

For the person using the old app, blocking is unaffected: it keeps using the settings on that device.
The old app shows its existing "saved on this device" message and quietly tries again about every
30 seconds while Still is open. Each try is refused the same way, so a few open old devices produce a
steady trickle of the same log lines.

This is by design and cannot be quieted from the server side without changing what old apps receive.
Their behavior must not change, so the lines are filtered when reading logs rather than removed.

## What it looks like

| Where | What you see |
|---|---|
| Postgres logs | `ERROR` with SQLSTATE `40001` and the message `settings client upgrade required`, from the `write_profile_settings` function |
| API gateway (edge) logs | An HTTP `500` on `POST /rest/v1/rpc/write_profile_settings` (per the API layer's documentation, SQLSTATE `40001` maps to 500; confirm against the first real line you see) |

No identifiers are involved in the message itself. If a line like this appears with any other message
text, it is something else: do not filter it.

## Filtering it in the Supabase log explorer (owner steps)

These are read-only views in the dashboard: Project, Logs, Logs Explorer, then **Save query** so the
view is one click next time. Nothing here changes the project. Field names are as the log explorer
documents them; if a query is rejected, open the table's schema panel in the explorer and adjust the
field name.

1. **See only the expected noise** (to confirm it is the old apps), Postgres logs:

   ```sql
   select
     cast(postgres_logs.timestamp as datetime) as timestamp,
     parsed.error_severity,
     event_message
   from postgres_logs
   cross join unnest(metadata) as m
   cross join unnest(m.parsed) as parsed
   where event_message like '%settings client upgrade required%'
   order by timestamp desc
   limit 100
   ```

2. **See real database errors without the noise**, Postgres logs. Save this as the everyday error view:

   ```sql
   select
     cast(postgres_logs.timestamp as datetime) as timestamp,
     parsed.error_severity,
     event_message
   from postgres_logs
   cross join unnest(metadata) as m
   cross join unnest(m.parsed) as parsed
   where parsed.error_severity in ('ERROR', 'FATAL', 'PANIC')
     and event_message not like '%settings client upgrade required%'
   order by timestamp desc
   limit 100
   ```

3. **See real API errors without the noise**, API gateway logs. Save this as the everyday 5xx view:

   ```sql
   select
     cast(edge_logs.timestamp as datetime) as timestamp,
     response.status_code,
     request.method,
     request.path
   from edge_logs
   cross join unnest(metadata) as m
   cross join unnest(m.request) as request
   cross join unnest(m.response) as response
   where response.status_code >= 500
     and request.path not like '%/rest/v1/rpc/write_profile_settings'
   order by timestamp desc
   limit 100
   ```

   This hides every 500 on that one function. Run the same query without the last `and` line now and
   then; a surge there that does not match query 1 would be a real problem.

If an alert or log drain is ever set up, exclude the same message text and path in it rather than
changing the function.

## How long it lasts

It fades on its own. As people update to the Still version that uses new sync, their devices stop
sending whole-document saves. The trickle shrinks with each update and ends once the last old app is
closed or updated. There is nothing to deploy or clean up.

Reference: the guard is in migration `0015_settings_sync_per_field.sql` ("0015 guard"). Do not edit
applied migrations to change this.
