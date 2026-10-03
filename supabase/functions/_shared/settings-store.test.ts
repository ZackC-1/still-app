import { assertEquals } from "@std/assert";

Deno.test("settings limiter changes only the retained surface allowlist", async () => {
  const historical = await Deno.readTextFile(
    new URL("../../migrations/0013_counter_retention.sql", import.meta.url),
  );
  const candidate = await Deno.readTextFile(
    new URL(
      "../../../scripts/backend/sql/settings-sync-candidate.sql",
      import.meta.url,
    ),
  );
  function body(source: string) {
    const start = source.indexOf(
      "create or replace function public.consume_rate_limit(",
    );
    const end = source.indexOf("\n$$;", start);
    if (start < 0 || end < 0) throw new Error("Retained limiter missing");
    return source.slice(start, end + 4);
  }
  const original = body(historical);
  assertEquals(
    body(candidate),
    original.replace(
      "('checkout', 'reconcile', 'review-signin:request', 'review-signin:verify')",
      "('checkout', 'reconcile', 'review-signin:request', 'review-signin:verify', 'settings-sync')",
    ),
  );
});
