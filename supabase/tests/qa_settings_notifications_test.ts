// Real PostgreSQL/Supabase RLS and trigger proof. Synthetic, disposable loopback only.
import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
const url = Deno.env.get("STILL_NOTIFICATION_TEST_DATABASE_URL");
if (url && (new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/postgres")) {
  throw new Error("Disposable loopback database required");
}
const a = "23232323-0000-4000-8000-000000000001";
const b = "23232323-0000-4000-8000-000000000002";
const c = "23232323-0000-4000-8000-000000000003";
Deno.test({ name: "QA notifications: actual private policy, trigger, rollback and failure isolation", ignore: !url, async fn() {
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  const rollback = new Error("synthetic rollback");
  try {
    const check = await Deno.readTextFile("scripts/backend/deploy/verify/0023_qa_settings_notifications.sql");
    assertEquals((await sql.unsafe(check))[0].issues, []);
    await assertRejects(() => sql.begin(async tx => {
      await tx`insert into auth.users(id,email) values(${a},'qa-notify-a@example.invalid'),(${b},'qa-notify-b@example.invalid'),(${c},'qa-notify-c@example.invalid')`;
      await tx`insert into private.qa_sandbox_subjects(holder,enabled) values(${a},true),(${b},false)`;
      const count = async (id: string) => Number((await tx`select count(*) from realtime.messages where topic=${'qa-settings-v1:' + id}`)[0].count);
      await tx`insert into public.profiles(id,settings_version) values(${a},1),(${b},1),(${c},1)`;
      assertEquals(await count(a), 1); assertEquals(await count(b), 0); assertEquals(await count(c), 0);
      const rows = await tx`select payload,event,private,extension from realtime.messages where topic=${'qa-settings-v1:' + a}`;
      assertEquals(rows[0].payload, { schema: 1 }); assertEquals(rows[0].event, "settings-changed");
      assertEquals(rows[0].private, true); assertEquals(rows[0].extension, "broadcast");
      await tx`update public.profiles set settings_version=settings_version where id=${a}`;
      assertEquals(await count(a), 1);
      await tx`update public.profiles set settings_version=2 where id=${a}`;
      assertEquals(await count(a), 2);
      // A rolled-back accepted write cannot leave a delivery hint behind.
      await assertRejects(() => tx.savepoint(async sp => {
        await sp`update public.profiles set settings_version=3 where id=${a}`;
        throw rollback;
      }));
      assertEquals(await count(a), 2);
      // Policies execute as the real authenticated role, not a service-role simulation.
      const visible = async (subject: string, topic: string) => {
        await tx`select set_config('request.jwt.claim.sub',${subject},true), set_config('realtime.topic',${topic},true)`;
        await tx`set local role authenticated`;
        const n = await count(a);
        await tx`reset role`;
        return n;
      };
      assertEquals(await visible(a, 'qa-settings-v1:' + a), 2);
      assertEquals(await visible(b, 'qa-settings-v1:' + a), 0);
      assertEquals(await visible(a, 'qa-settings-v1:' + b), 0);
      assertEquals(await visible(a, 'profile-settings:' + a), 0);
      await tx`update private.qa_sandbox_subjects set enabled=false where holder=${a}`;
      assertEquals(await visible(a, 'qa-settings-v1:' + a), 0);
      await tx`update private.qa_sandbox_subjects set enabled=true where holder=${a}`;
      await tx`set local role anon`;
      assertEquals(await count(a), 0);
      await tx`reset role`;
      await assertRejects(() => tx.savepoint(async sp => {
        await sp`set local role authenticated`;
        await sp`insert into realtime.messages(topic,event,extension,payload,private) values(${'qa-settings-v1:' + a},'settings-changed','broadcast','{"schema":1}',true)`;
      }));
      // Force the notifier's membership read to fail, while the ordinary profile save succeeds.
      await tx`revoke select on private.qa_sandbox_subjects from postgres`;
      await tx`update public.profiles set settings_version=4 where id=${a}`;
      assertEquals(Number((await tx`select settings_version from public.profiles where id=${a}`)[0].settings_version), 4);
      assertEquals(await count(a), 2);
      await tx`grant select on private.qa_sandbox_subjects to postgres`;
      assert((await tx`select has_function_privilege('authenticated','public.qa_settings_notifications_enabled()','execute') as ok`)[0].ok);
      throw rollback;
    }), Error, "synthetic rollback");
  } finally { await sql.end(); }
}});
