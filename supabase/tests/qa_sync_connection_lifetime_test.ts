// Real connection-lifetime proof on the disposable CI database only.
import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { createWriterSql } from "../functions/_shared/pg-store.ts";

const url = Deno.env.get("STILL_NOTIFICATION_TEST_DATABASE_URL");
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).pathname !== "/postgres")
) {
  throw new Error("Disposable loopback database required");
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test({
  name:
    "QA sync releases idle instance connections, reconnects, and retains active transactions",
  ignore: !url,
  async fn() {
    const inspect = postgres(url!, { prepare: false, max: 1 });
    const ordinary = createWriterSql(url!);
    const writers = Array.from({ length: 8 }, () => createWriterSql(url!, 1));
    try {
      const ids = await Promise.all(
        writers.map(async (sql) =>
          Number((await sql`select pg_backend_pid() as pid`)[0].pid)
        ),
      );
      const control = Number(
        (await ordinary`select pg_backend_pid() as pid`)[0].pid,
      );
      assertEquals(new Set(ids).size, writers.length);
      await delay(2500);
      assertEquals(
        Number(
          (await inspect`
        select count(*) as n from pg_stat_activity where pid = any(${ids})
      `)[0].n,
        ),
        0,
        "Idle QA instance connections must be released before fallback polling",
      );
      assertEquals(
        Number(
          (await inspect`
        select count(*) as n from pg_stat_activity where pid = ${control}
      `)[0].n,
        ),
        1,
        "Ordinary writer lifetime must remain unchanged",
      );
      const next = Number(
        (await writers[0]`select pg_backend_pid() as pid`)[0].pid,
      );
      assert(
        !ids.includes(next),
        "The next request must reconnect after idle release",
      );
      await writers[0].begin(async (tx) => {
        const before = Number(
          (await tx`select pg_backend_pid() as pid`)[0].pid,
        );
        await delay(1500);
        assertEquals(
          Number((await tx`select pg_backend_pid() as pid`)[0].pid),
          before,
        );
      });
    } finally {
      await Promise.all(
        [...writers, ordinary, inspect].map((sql) => sql.end()),
      );
    }
  },
});
