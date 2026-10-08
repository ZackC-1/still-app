import { assert, assertEquals } from "@std/assert";
import {
  createQaSandboxPolicyHandler,
  createQaSandboxSyncHandler,
} from "./qa-sandbox-public-runtime.ts";
import { signHs256 } from "./jwt.ts";
import {
  createSettingsAnchorIdentity,
  issueSettingsAnchorReceipt,
} from "./settings-anchor.ts";
import type { LockedSettingsRow, SettingsStore } from "./settings-store.ts";
import type { PolicyReader } from "../product-policy/handler.ts";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const SECRET = "synthetic-shared-auth-secret-32-characters";
const ORIGIN = "https://synthetic-project.example.test";
const POLICY_DB =
  "postgresql://still_policy_reader:synthetic@db.example.test/postgres";
const SETTINGS_DB =
  "postgresql://still_settings_writer:synthetic@db.example.test/postgres";
const BODY =
  '{"schema":1,"environment":"sandbox","revision":2,"master":true,"surfaces":{"chrome_desktop":true,"edge_desktop":false,"firefox_desktop":false,"firefox_android":false,"apple_mobile_host":false,"apple_macos_host":false},"builds":[{"surface":"chrome_desktop","build":"3.0.0"}]}';
const SALES_BODY =
  '{"schema":1,"environment":"sandbox","revision":2,"salesEnabled":true,"channels":{"apple":{"enabled":true,"offer":"still-pro-v3"},"web":{"enabled":true,"offer":"still-pro-v3"}},"builds":[]}';
function env(values: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    get: (name: string) => {
      reads.push(name);
      return values[name];
    },
  };
}
function post(
  body: unknown,
  path = "qa-sandbox-product-policy",
  token?: string,
) {
  return new Request(`https://edge.example.test/functions/v1/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
function policyFixture(
  values: Record<string, string> = { PRODUCT_POLICY_READER_DB_URL: POLICY_DB },
  answer: string | null = BODY,
) {
  const environment = env(values);
  const calls: string[] = [];
  const connections: string[] = [];
  const reader: PolicyReader = {
    read: (namespace, scope) => {
      calls.push(`${namespace}/${scope}`);
      return Promise.resolve(answer);
    },
  };
  const handler = createQaSandboxPolicyHandler(environment.get, (url) => {
    connections.push(url);
    return reader;
  });
  return { handler, calls, connections, environment };
}
Deno.test("QA policy serves only existing sandbox body and does not read paid configuration", async () => {
  for (const namespace of ["sales", "rating"]) {
    const body = namespace === "sales" ? SALES_BODY : BODY;
    const fx = policyFixture(undefined, body);
    const response = await fx.handler(
      post({ namespace, environment: "sandbox" }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.text(), body);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(fx.calls, [`${namespace}/sandbox`]);
    assertEquals(fx.connections, [POLICY_DB]);
    assertEquals(fx.environment.reads, ["PRODUCT_POLICY_READER_DB_URL"]);
  }
});
Deno.test("QA policy rejects production before storage, unknown environment and extra keys", async () => {
  const fx = policyFixture();
  for (
    const body of [
      { namespace: "sales", environment: "production" },
      { namespace: "sales", environment: "staging" },
      { namespace: "sales", environment: "sandbox", subject: A },
      { namespace: "admin", environment: "sandbox" },
    ]
  ) assert((await fx.handler(post(body))).status >= 400);
  assertEquals(fx.calls, []);
});
Deno.test("QA policy preserves OPTIONS and GET405, missing row404 and wrong stored environment503", async () => {
  const fx = policyFixture();
  assertEquals(
    (await fx.handler(
      new Request("https://edge.example.test", { method: "OPTIONS" }),
    )).status,
    204,
  );
  assertEquals(
    (await fx.handler(new Request("https://edge.example.test"))).status,
    405,
  );
  assertEquals(fx.calls, []);
  assertEquals(
    (await policyFixture(undefined, null).handler(
      post({ namespace: "sales", environment: "sandbox" }),
    )).status,
    404,
  );
  assertEquals(
    (await policyFixture(undefined, BODY.replace("sandbox", "production"))
      .handler(post({ namespace: "sales", environment: "sandbox" }))).status,
    503,
  );
});
Deno.test("QA policy missing/foreign credentials cannot use settings or paid writer", async () => {
  for (
    const value of [
      "",
      SETTINGS_DB,
      POLICY_DB.replace("still_policy_reader", "postgres"),
      "https://db.example.test",
    ]
  ) {
    const fx = policyFixture({
      PRODUCT_POLICY_READER_DB_URL: value,
      SETTINGS_WRITER_DB_URL: SETTINGS_DB,
      STILL_QA_SANDBOX_DB_URL: POLICY_DB,
    });
    const response = await fx.handler(
      post({ namespace: "sales", environment: "sandbox" }),
    );
    assertEquals(response.status, 503);
    assertEquals(await response.text(), "");
    assertEquals(fx.connections, []);
  }
});
Deno.test("QA sync unavailable settings writer still requires valid shared authentication", async () => {
  for (
    const database of [
      "",
      SETTINGS_DB.replace("still_settings_writer", "still_qa_sandbox_writer"),
    ]
  ) {
    const fx = syncFixture({
      SETTINGS_WRITER_DB_URL: database,
      SUPABASE_URL: ORIGIN,
      SUPABASE_JWT_SECRET: SECRET,
    });
    for (
      const bearer of [
        undefined,
        "not-a-token",
        await token({ iss: "https://foreign.example.test/auth/v1" }),
        await token({ exp: 1 }),
      ]
    ) {
      assertEquals(
        (await fx.handler(
          post(
            { protocol: 2, action: "read" },
            "qa-sandbox-sync-settings",
            bearer,
          ),
        )).status,
        401,
      );
    }
    assertEquals(
      (await fx.handler(
        post(
          { protocol: 2, action: "read" },
          "qa-sandbox-sync-settings",
          await token(),
        ),
      )).status,
      503,
    );
    assertEquals(fx.connections, []);
    assertEquals(fx.subjects, []);
    assertEquals(fx.buckets, []);
  }
});
Deno.test("QA sync missing or malformed Auth rejects tokens without a JWKS request or settings connection", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches++;
    return Promise.reject(new Error("Unexpected JWKS request"));
  };
  try {
    const asymmetric = `${
      btoa(JSON.stringify({ alg: "ES256", kid: "synthetic-key" }))
    }.${btoa("{}")}.signature`;
    for (
      const origin of [
        "",
        "http://project.example.test",
        `${ORIGIN}/other`,
        `${ORIGIN}?other=1`,
      ]
    ) {
      const fx = syncFixture({
        SETTINGS_WRITER_DB_URL: SETTINGS_DB,
        SUPABASE_URL: origin,
        SUPABASE_JWT_SECRET: SECRET,
      });
      for (const bearer of [undefined, await token(), asymmetric]) {
        assertEquals(
          (await fx.handler(
            post(
              { protocol: 2, action: "read" },
              "qa-sandbox-sync-settings",
              bearer,
            ),
          )).status,
          401,
        );
      }
      assertEquals(fx.connections, []);
    }
    assertEquals(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
function syncFixture(values: Record<string, string> = {
  SETTINGS_WRITER_DB_URL: SETTINGS_DB,
  SUPABASE_URL: ORIGIN,
  SUPABASE_JWT_SECRET: SECRET,
}) {
  const environment = env(values);
  const identity = createSettingsAnchorIdentity();
  const row: LockedSettingsRow = {
    anchor: { ...identity, subject: A, revision: 0 },
    raw: null,
    empty: true,
    updatedAt: null,
    writeId: null,
    now: 1770000000000,
    claim: () => Promise.resolve("new"),
    commit: () => Promise.resolve(),
  };
  const subjects: string[] = [];
  const connections: string[] = [];
  const buckets: string[] = [];
  const store: SettingsStore = {
    locked: (subject, work) => {
      subjects.push(subject);
      return work(row);
    },
  };
  const handler = createQaSandboxSyncHandler(environment.get, (url) => {
    connections.push(url);
    return {
      store,
      limiter: {
        consume: (key) => {
          buckets.push(key);
          return Promise.resolve(0);
        },
      },
    };
  });
  return { handler, environment, row, subjects, connections, buckets };
}
async function token(override: Record<string, unknown> = {}) {
  return await signHs256({
    sub: A,
    iss: `${ORIGIN}/auth/v1`,
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...override,
  }, SECRET);
}
Deno.test("QA free sync reads and commits own settings without any purchase or paid membership", async () => {
  const fx = syncFixture();
  const bearer = await token();
  const read = await fx.handler(
    post({ protocol: 2, action: "read" }, "qa-sandbox-sync-settings", bearer),
  );
  assertEquals(read.status, 200);
  const result = await read.json();
  assertEquals(result.status, "ready");
  assertEquals(result.protocol, 2);
  assertEquals(result.empty, true);
  assertEquals(result.receipt.revision, 0);
  let committed = 0;
  fx.row.commit = (settings) => {
    assertEquals(settings.globalOn, false);
    committed++;
    return Promise.resolve();
  };
  const write = await fx.handler(post(
    {
      protocol: 2,
      writeId: crypto.randomUUID(),
      expectedLineage: fx.row.anchor.lineage,
      receipt: await issueSettingsAnchorReceipt(fx.row.anchor),
      operations: [{
        path: "globalOn",
        value: false,
        baseRevision: 0,
        localStep: 1,
      }],
    },
    "qa-sandbox-sync-settings",
    bearer,
  ));
  assertEquals(write.status, 200);
  assertEquals(committed, 1);
  assertEquals(fx.subjects, [A, A]);
  assertEquals(fx.connections, [SETTINGS_DB]);
  assertEquals(fx.buckets, [
    `settings-sync:user:${A}`,
    `settings-sync:user:${A}`,
  ]);
  assertEquals(fx.environment.reads, [
    "SUPABASE_URL",
    "SETTINGS_WRITER_DB_URL",
    "SUPABASE_JWT_SECRET",
  ]);
});
Deno.test("QA sync enforces shared JWT issuer, authenticated audience/role, expiry and no client subject", async () => {
  const fx = syncFixture();
  for (
    const override of [
      { iss: "https://foreign.example.test/auth/v1" },
      { aud: "anon" },
      { role: "service_role" },
      { exp: 1 },
      { sub: "not-a-uuid" },
    ]
  ) {
    assertEquals(
      (await fx.handler(
        post(
          { protocol: 2, action: "read" },
          "qa-sandbox-sync-settings",
          await token(override),
        ),
      )).status,
      401,
    );
  }
  assertEquals(
    (await fx.handler(
      post({ protocol: 2, action: "read" }, "qa-sandbox-sync-settings"),
    )).status,
    401,
  );
  assertEquals(
    (await fx.handler(
      post(
        { protocol: 2, action: "read", subject: B },
        "qa-sandbox-sync-settings",
        await token(),
      ),
    )).status,
    400,
  );
  assertEquals(fx.subjects, []);
});
Deno.test("QA sync missing shared config rejects paid writer fallback without constructing a connection", async () => {
  for (
    const patch of [
      { SETTINGS_WRITER_DB_URL: "" },
      {
        SETTINGS_WRITER_DB_URL: SETTINGS_DB.replace(
          "still_settings_writer",
          "still_qa_sandbox_writer",
        ),
      },
      {
        SETTINGS_WRITER_DB_URL: SETTINGS_DB.replace(
          "still_settings_writer",
          "postgres",
        ),
      },
      { SUPABASE_URL: "" },
      { SUPABASE_URL: "http://project.example.test" },
      { SUPABASE_URL: `${ORIGIN}/other` },
      { SUPABASE_URL: `${ORIGIN}?other=1` },
    ]
  ) {
    const fx = syncFixture({
      SETTINGS_WRITER_DB_URL: SETTINGS_DB,
      SUPABASE_URL: ORIGIN,
      SUPABASE_JWT_SECRET: SECRET,
      STILL_QA_SANDBOX_DB_URL: SETTINGS_DB,
      ...patch,
    });
    const response = await fx.handler(
      post(
        { protocol: 2, action: "read" },
        "qa-sandbox-sync-settings",
        await token(),
      ),
    );
    assertEquals(response.status, "SUPABASE_URL" in patch ? 401 : 503);
    assertEquals(fx.connections, []);
    assert(!await response.text().then((body) => body.includes("synthetic")));
  }
});
Deno.test("QA sync preserves OPTIONS and POST-only contract while unavailable", async () => {
  for (const fx of [syncFixture(), syncFixture({})]) {
    assertEquals(
      (await fx.handler(
        new Request("https://edge.example.test", { method: "OPTIONS" }),
      )).status,
      204,
    );
    assertEquals(
      (await fx.handler(new Request("https://edge.example.test"))).status,
      405,
    );
    assertEquals(fx.subjects, []);
  }
});
Deno.test("QA free sync permits shared hosted asymmetric auth configuration without HS secret", () => {
  const fx = syncFixture({
    SETTINGS_WRITER_DB_URL: SETTINGS_DB,
    SUPABASE_URL: ORIGIN,
  });
  assertEquals(fx.connections, [SETTINGS_DB]);
});
