import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { LocalOnlyRefusal } from "./guard.mjs";
import { clearInbox, extractCode, waitForCode } from "./mailpit.mjs";
import { adminCode, createUser, requestCode, verifyCode } from "./auth.mjs";
import { startPosthogStub } from "./posthog-stub.mjs";
import { startFaultProxy } from "./fault-proxy.mjs";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const MAILPIT = "http://127.0.0.1:54324";

test("the QA code is read from the template marker only", () => {
  assert.equal(extractCode("Still QA sign-in code\nQA-CODE: 482913\n"), "482913");
  assert.equal(extractCode("<p>QA-CODE: 004211</p>"), "004211");
  assert.equal(extractCode("Your code is 123456"), null);
});

test("waitForCode returns the newest fresh code and ignores older messages", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes("/api/v1/search")) return reply({ messages: [
      { ID: "old", Created: "2026-10-05T10:00:00Z" }, { ID: "new", Created: "2026-10-05T10:05:00Z" },
    ] });
    return reply({ Text: url.endsWith("/new") ? "QA-CODE: 222222" : "QA-CODE: 111111" });
  };
  const code = await waitForCode({ mailpitUrl: MAILPIT, email: "qa@example.test", since: Date.parse("2026-10-05T10:01:00Z"), fetchImpl });
  assert.equal(code, "222222");
  assert.ok(calls[0].includes(encodeURIComponent('to:"qa@example.test"')));
});

test("waitForCode times out without a fresh message", async () => {
  let t = 0;
  await assert.rejects(waitForCode({
    mailpitUrl: MAILPIT, email: "qa@example.test", since: 0, timeoutMs: 1000,
    fetchImpl: async () => reply({ messages: [] }), now: () => (t += 600), sleep: async () => {},
  }), /no QA sign-in code/);
});

test("Mailpit and Auth helpers refuse any non-local address before a request", async () => {
  const fetchImpl = async () => assert.fail("made a request");
  const hosted = "https://abcdefgh.supabase.co";
  await assert.rejects(waitForCode({ mailpitUrl: hosted, email: "a@b.c", fetchImpl }), LocalOnlyRefusal);
  await assert.rejects(clearInbox({ mailpitUrl: "http://mail.example.com", fetchImpl }), LocalOnlyRefusal);
  await assert.rejects(requestCode({ apiUrl: hosted, anonKey: "k", email: "a@b.c", fetchImpl }), LocalOnlyRefusal);
  await assert.rejects(adminCode({ apiUrl: hosted, serviceRoleKey: "k", email: "a@b.c", fetchImpl }), LocalOnlyRefusal);
  await assert.rejects(verifyCode({ apiUrl: hosted, anonKey: "k", email: "a@b.c", code: "1", fetchImpl }), LocalOnlyRefusal);
  await assert.rejects(createUser({ apiUrl: hosted, serviceRoleKey: "k", email: "a@b.c", fetchImpl }), LocalOnlyRefusal);
});

test("adminCode reads email_otp at the top level or under properties", async () => {
  const api = "http://127.0.0.1:54321";
  let seen;
  const top = await adminCode({ apiUrl: api, serviceRoleKey: "svc", email: "a@b.c", fetchImpl: async (url, init) => { seen = { url, init }; return reply({ email_otp: "123456" }); } });
  assert.equal(top, "123456");
  assert.equal(seen.url, `${api}/auth/v1/admin/generate_link`);
  assert.deepEqual(JSON.parse(seen.init.body), { type: "magiclink", email: "a@b.c" });
  assert.equal(await adminCode({ apiUrl: api, serviceRoleKey: "svc", email: "a@b.c", fetchImpl: async () => reply({ properties: { email_otp: "654321" } }) }), "654321");
  await assert.rejects(adminCode({ apiUrl: api, serviceRoleKey: "svc", email: "a@b.c", fetchImpl: async () => reply({}) }), /no email_otp/);
});

test("the PostHog stub records batches, answers CORS and listens on loopback only", async () => {
  const stub = await startPosthogStub();
  try {
    assert.match(stub.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const pre = await fetch(`${stub.url}/batch/`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    const sent = await fetch(`${stub.url}/batch/`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "phc_test", batch: [{ event: "extension_installed", properties: { surface: "chrome" } }, { event: "settings_changed", properties: {} }] }) });
    assert.equal(sent.status, 200);
    assert.deepEqual(stub.events().map(e => e.event), ["extension_installed", "settings_changed"]);
    assert.equal(stub.events()[0].apiKey, "phc_test");
    assert.equal((await fetch(`${stub.url}/unexpected`, { method: "POST", body: "x" })).status, 404);
    assert.equal(stub.requests.length, 2, "every POST is recorded, including the unexpected path (preflights are not)");
    stub.clear();
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

async function upstreamServer() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify({ path: req.url, method: req.method, body })); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test("the fault proxy passes through, fails, answers a status, and holds until released", async () => {
  const upstream = await upstreamServer();
  const proxy = await startFaultProxy({ upstream: upstream.url });
  try {
    const pass = await fetch(`${proxy.url}/rest/v1/rpc/x`, { method: "POST", body: "{}" });
    assert.deepEqual(await pass.json(), { path: "/rest/v1/rpc/x", method: "POST", body: "{}" });

    proxy.setFaults([{ pathPrefix: "/functions/v1/sync-settings", mode: "fail" }]);
    await assert.rejects(fetch(`${proxy.url}/functions/v1/sync-settings`, { method: "POST" }));
    assert.equal((await fetch(`${proxy.url}/auth/v1/user`)).status, 200, "unmatched paths still pass");

    proxy.setFaults([{ pathPrefix: "/functions/v1/", mode: "status", status: 503, times: 1 }]);
    assert.equal((await fetch(`${proxy.url}/functions/v1/product-policy`, { method: "POST" })).status, 503);
    assert.equal((await fetch(`${proxy.url}/functions/v1/product-policy`, { method: "POST" })).status, 200, "times: 1 applies once");

    proxy.setFaults([{ method: "POST", pathPrefix: "/auth/v1/token", mode: "hold" }]);
    let settled = false;
    const pending = fetch(`${proxy.url}/auth/v1/token`, { method: "POST" }).then(r => { settled = true; return r; });
    for (let i = 0; i < 50 && proxy.heldCount === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(proxy.heldCount, 1);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(settled, false);
    proxy.release();
    assert.equal((await pending).status, 200);
    assert.throws(() => proxy.setFaults([{ mode: "explode" }]));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("the fault proxy refuses a non-local upstream", async () => {
  await assert.rejects(startFaultProxy({ upstream: "https://abcdefgh.supabase.co" }), LocalOnlyRefusal);
  await assert.rejects(startFaultProxy({ upstream: "http://api.example.com" }), LocalOnlyRefusal);
});
