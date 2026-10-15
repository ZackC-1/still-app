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
      // A widened receive policy must fail the deployment verifier.
      await assertRejects(() => tx.savepoint(async sp => {
        await sp`alter policy qa_settings_notifications_receive on realtime.messages using (true)`;
        assert((await sp.unsafe(check))[0].issues.includes("receive_policy"));
        throw rollback;
      }), Error, "synthetic rollback");
      await tx`insert into auth.users(id,email) values(${a},'qa-notify-a@example.invalid'),(${b},'qa-notify-b@example.invalid'),(${c},'qa-notify-c@example.invalid')`;
      await tx`insert into private.qa_sandbox_subjects(holder,enabled) values(${a},true),(${b},false)`;
      const count = async (id: string) => Number((await tx`select count(*) from realtime.messages where topic=${'qa-settings-v1:' + id}`)[0].count);
      await tx`insert into public.profiles(id,settings_version) values(${a},1),(${b},1),(${c},1)`;
      assertEquals(await count(a), 1); assertEquals(await count(b), 0); assertEquals(await count(c), 0);
      const rows = await tx`select payload,event,private,extension from realtime.messages where topic=${'qa-settings-v1:' + a}`;
      assertEquals(Object.keys(rows[0].payload).sort(), ["id", "schema"]);
      assertEquals(rows[0].payload.schema, 1);
      assert(/^[0-9a-f-]{36}$/.test(rows[0].payload.id)); assertEquals(rows[0].event, "settings-changed");
      assertEquals(rows[0].private, true); assertEquals(rows[0].extension, "broadcast");
      await tx`update public.profiles set settings_version=settings_version where id=${a}`;
      assertEquals(await count(a), 1);
      await tx`update public.profiles set settings_version=2 where id=${a}`;
      assertEquals(await count(a), 2);
      // A rolled-back accepted write cannot leave a delivery hint behind.
      await assertRejects(() => tx.savepoint(async sp => {
        await sp`update public.profiles set settings_version=3 where id=${a}`;
        throw rollback;
      }), Error, "synthetic rollback");
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
      // Break only the notifier's membership query inside this rolled-back synthetic transaction.
      // Revoking postgres SELECT is insufficient: its inherited owner role can still read.
      await tx`alter table private.qa_sandbox_subjects rename column enabled to notification_test_disabled`;
      await tx`update public.profiles set settings_version=4 where id=${a}`;
      assertEquals(Number((await tx`select settings_version from public.profiles where id=${a}`)[0].settings_version), 4);
      assertEquals(await count(a), 2, "Failed notifier must not emit another hint");
      await tx`alter table private.qa_sandbox_subjects rename column notification_test_disabled to enabled`;
      assert((await tx`select has_function_privilege('authenticated','public.qa_settings_notifications_enabled()','execute') as ok`)[0].ok);
      throw rollback;
    }), Error, "synthetic rollback");
  } finally { await sql.end(); }
}});

Deno.test({ name: "QA notifications: two real private WebSocket subscribers receive committed changes", ignore: !url, async fn() {
  const { createClient } = await import("@supabase/supabase-js");
  const { SignJWT } = await import("jose");
  const secret = Deno.env.get("STILL_NOTIFICATION_TEST_JWT_SECRET");
  const anon = Deno.env.get("STILL_NOTIFICATION_TEST_ANON_KEY");
  assert(secret && anon, "Disposable Realtime inputs required");
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  const token = async (subject: string) => await new SignJWT({ role: "authenticated", aud: "authenticated" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(subject).setIssuedAt().setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
  const clients = await Promise.all([a, a, b].map(async subject => {
    const jwt = await token(subject);
    return createClient("http://127.0.0.1:54321", anon, {
      accessToken: async () => jwt,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }));
  const delivered = [0, 0, 0];
  const channels = clients.map((client, i) => client.channel(`qa-settings-v1:${a}`, { config: { private: true } })
    .on("broadcast", { event: "settings-changed" }, message => {
      if (message.payload?.schema === 1) delivered[i]++;
    }));
  const join = (i: number) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Private channel join timed out")), 15000);
    channels[i].subscribe(status => {
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT"].includes(status)) {
        clearTimeout(timer); resolve(status);
      }
    });
  });
  try {
    await sql`insert into auth.users(id,email) values(${a},'qa-notify-a@example.invalid'),(${b},'qa-notify-b@example.invalid')`;
    await sql`insert into private.qa_sandbox_subjects(holder,enabled) values(${a},true),(${b},true)`;
    await sql`insert into public.profiles(id,settings_version) values(${a},1)`;
    assertEquals(await Promise.all([join(0), join(1), join(2)]), ["SUBSCRIBED", "SUBSCRIBED", "CHANNEL_ERROR"]);
    await sql`update public.profiles set settings_version=2 where id=${a}`;
    const deadline = Date.now() + 10000;
    while ((delivered[0] === 0 || delivered[1] === 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(delivered[0] > 0 && delivered[1] > 0, "Both authorized peers must receive the committed hint");
    assertEquals(delivered[2], 0);
  } finally {
    await Promise.all(clients.map(client => client.removeAllChannels()));
    await sql`delete from auth.users where id in (${a},${b})`;
    await sql.end();
  }
}});
