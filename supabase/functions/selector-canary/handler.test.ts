import { assertEquals } from "@std/assert";
import { handleCanaryRequest } from "./handler.ts";

const TOKEN = "canary-invocation-token";

function req(token: string | null, method = "POST"): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = token;
  return new Request("http://x/selector-canary", { method, headers });
}

function mockRun() {
  let calls = 0;
  return {
    run: () => {
      calls += 1;
      return Promise.resolve({ ranAt: "test" });
    },
    calls: () => calls,
  };
}

Deno.test("scheduler token → 200 with the run report", async () => {
  const { run, calls } = mockRun();
  const res = await handleCanaryRequest(req(TOKEN), { token: TOKEN, run });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ranAt: "test" });
  assertEquals(calls(), 1);
});

Deno.test("wrong token → 401, canary does not run", async () => {
  const { run, calls } = mockRun();
  const res = await handleCanaryRequest(req("wrong-token"), { token: TOKEN, run });
  assertEquals(res.status, 401);
  assertEquals(calls(), 0);
});

Deno.test("missing Authorization header → 401, canary does not run", async () => {
  const { run, calls } = mockRun();
  const res = await handleCanaryRequest(req(null), { token: TOKEN, run });
  assertEquals(res.status, 401);
  assertEquals(calls(), 0);
});

Deno.test("blank configured token rejects even a blank header (fail closed)", async () => {
  const { run, calls } = mockRun();
  const res = await handleCanaryRequest(req(""), { token: "", run });
  assertEquals(res.status, 401);
  assertEquals(calls(), 0);
});

Deno.test("GET → 405, canary does not run", async () => {
  const { run, calls } = mockRun();
  const res = await handleCanaryRequest(req(TOKEN, "GET"), { token: TOKEN, run });
  assertEquals(res.status, 405);
  assertEquals(calls(), 0);
});

Deno.test("run failure → 500 without leaking detail", async () => {
  const res = await handleCanaryRequest(req(TOKEN), {
    token: TOKEN,
    run: () => Promise.reject(new Error("rule set fetch failed")),
  });
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "canary_failed" });
});
