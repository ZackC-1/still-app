import { assert, assertEquals } from "@std/assert";
import { signHs256 } from "../_shared/jwt.ts";
import { mintHs256, TEST_PROJECT_URL } from "../_shared/test-helpers.ts";
import {
  handleProductPolicyAdmin,
  ownerAuthDeps,
  type ProductPolicyAdminDeps,
} from "./handler.ts";
import { PAID_CUTOFF_SNAPSHOT, type PaidCutoffSnapshot } from "./cutoff.ts";
import {
  type ApplyRequest,
  type ApplyResult,
  type PolicyAdminStore,
  PolicyOwnerRequired,
  PolicyRequestRejected,
  type PolicyState,
  type PreviewResult,
} from "./store.ts";

const SECRET = "synthetic-policy-admin-jwt-secret-32-chars";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OPERATION = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const SURFACES = {
  chrome_desktop: true,
  edge_desktop: false,
  firefox_desktop: false,
  firefox_android: false,
  apple_mobile_host: false,
  apple_macos_host: false,
};
const DRAFT = {
  master: true,
  surfaces: SURFACES,
  builds: [{ surface: "chrome_desktop", build: "3.0.0" }],
};
const body = (revision: number, master = true) =>
  `{"schema":1,"environment":"sandbox","revision":${revision},"master":${master},"surfaces":{"chrome_desktop":true,"edge_desktop":false,"firefox_desktop":false,"firefox_android":false,"apple_mobile_host":false,"apple_macos_host":false},"builds":[{"surface":"chrome_desktop","build":"3.0.0"}]}`;

type Script = {
  state?: () => Promise<PolicyState>;
  preview?: () => Promise<PreviewResult>;
  apply?: () => Promise<ApplyResult>;
};
function fixture(script: Script = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const store: PolicyAdminStore = {
    state: (...args) => {
      calls.push({ method: "state", args });
      return script.state ? script.state() : Promise.resolve({
        revision: 0,
        body: null,
        operationId: null,
        cutoff: false,
      });
    },
    preview: (...args) => {
      calls.push({ method: "preview", args });
      return script.preview
        ? script.preview()
        : Promise.reject(new Error("unexpected preview"));
    },
    apply: (...args) => {
      calls.push({ method: "apply", args });
      return script.apply
        ? script.apply()
        : Promise.reject(new Error("unexpected apply"));
    },
  };
  const deps: ProductPolicyAdminDeps = {
    jwtSecret: SECRET,
    store,
    cutoffSnapshot: null,
  };
  return { deps, calls };
}
const exp = () => Math.floor(Date.now() / 1000) + 600;
async function send(
  payload: unknown,
  deps: ProductPolicyAdminDeps,
  token: Promise<string> | string | null = signHs256(
    { sub: OWNER, exp: exp() },
    SECRET,
  ),
) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${await token}`;
  const response = await handleProductPolicyAdmin(
    new Request("https://example.test", {
      method: "POST",
      headers,
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    deps,
  );
  return {
    status: response.status,
    json: await response.json(),
    headers: response.headers,
  };
}
const applyRequest = (overrides: Record<string, unknown> = {}) => ({
  action: "apply",
  namespace: "rating",
  environment: "sandbox",
  expectedRevision: 0,
  operationId: OPERATION,
  previewHash: HASH,
  body: body(1),
  ...overrides,
});
const applied = (replay = false): ApplyResult => ({
  status: "applied",
  replay,
  operationId: OPERATION,
  revision: 1,
  body: body(1),
});
const committed: PolicyState = {
  revision: 1,
  body: body(1),
  operationId: OPERATION,
  cutoff: false,
};

Deno.test("the packaged cutoff snapshot is unset: no paid activation can start from this server", () => {
  assertEquals(PAID_CUTOFF_SNAPSHOT, null);
});

Deno.test("only a verified, unexpired token reaches the store", async () => {
  const cases: [string, Promise<string> | string | null][] = [
    ["no token", null],
    ["garbage", "not-a-jwt"],
    [
      "wrong secret",
      signHs256({ sub: OWNER, exp: exp() }, "another-secret-another-secret-32"),
    ],
    [
      "expired",
      signHs256({ sub: OWNER, exp: Math.floor(Date.now() / 1000) - 5 }, SECRET),
    ],
    ["no expiry", signHs256({ sub: OWNER }, SECRET)],
    [
      "non-uuid subject",
      signHs256({ sub: "owner@example.invalid", exp: exp() }, SECRET),
    ],
  ];
  for (const [name, token] of cases) {
    const { deps, calls } = fixture();
    const response = await send(
      { action: "read", namespace: "rating", environment: "sandbox" },
      deps,
      token,
    );
    assertEquals(response.status, 401, name);
    assertEquals(calls, [], name);
  }
});

Deno.test("wrong owner: a verified subject outside the allowlist is refused", async () => {
  const { deps } = fixture({
    state: () => Promise.reject(new PolicyOwnerRequired()),
  });
  const response = await send({
    action: "read",
    namespace: "rating",
    environment: "sandbox",
  }, deps);
  assertEquals(response.status, 403);
  assertEquals(response.json, { error: "forbidden" });
  const other = fixture({
    apply: () => Promise.resolve({ status: "wrong_owner" }),
  });
  assertEquals((await send(applyRequest(), other.deps)).status, 403);
});

Deno.test("wrong namespace, environment or shape never reaches the store", async () => {
  const cases: unknown[] = [
    { action: "read", namespace: "cutoff", environment: "sandbox" },
    { action: "read", namespace: "pricing", environment: "sandbox" },
    { action: "read", namespace: "rating", environment: "staging" },
    {
      action: "read",
      namespace: "rating",
      environment: "sandbox",
      owner: OWNER,
    },
    {
      action: "preview",
      namespace: "rating",
      environment: "sandbox",
      expectedRevision: -1,
      draft: DRAFT,
    },
    {
      action: "preview",
      namespace: "rating",
      environment: "sandbox",
      expectedRevision: 1.5,
      draft: DRAFT,
    },
    {
      action: "preview-rollback",
      namespace: "rating",
      environment: "sandbox",
      expectedRevision: 2,
      sourceRevision: 0,
    },
    applyRequest({ operationId: "not-a-uuid" }),
    applyRequest({ previewHash: "A".repeat(64) }),
    applyRequest({ body: 42 }),
    { action: "delete", namespace: "rating", environment: "sandbox" },
    "not json",
    [],
  ];
  for (const payload of cases) {
    const { deps, calls } = fixture();
    const response = await send(payload, deps);
    assertEquals(response.status, 400, JSON.stringify(payload));
    assertEquals(calls, [], JSON.stringify(payload));
  }
  const rejected = fixture({
    state: () => Promise.reject(new PolicyRequestRejected()),
  });
  assertEquals(
    (await send(
      { action: "read", namespace: "rating", environment: "sandbox" },
      rejected.deps,
    )).status,
    400,
  );
});

Deno.test("preview stages the server-rendered canonical body and reports the remote effect", async () => {
  const { deps, calls } = fixture({
    preview: () =>
      Promise.resolve({
        status: "previewed",
        operationId: OPERATION,
        previewHash: HASH,
        kind: "apply",
        rollbackOf: null,
        expectedRevision: 0,
        revision: 1,
        body: body(1),
        currentBody: null,
        expiresAt: 1_800_000_300_000,
      }),
  });
  const response = await send(
    {
      action: "preview",
      namespace: "rating",
      environment: "sandbox",
      expectedRevision: 0,
      draft: DRAFT,
    },
    deps,
  );
  assertEquals(response.status, 200);
  assertEquals(calls[0], {
    method: "preview",
    args: [OWNER, "rating", "sandbox", 0, body(1), null],
  });
  assertEquals(response.json.body, body(1));
  assertEquals(response.json.before.chrome_desktop, false);
  assertEquals(response.json.after.chrome_desktop, true);
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("an invalid draft is refused before the store", async () => {
  const { deps, calls } = fixture();
  const response = await send({
    action: "preview",
    namespace: "rating",
    environment: "sandbox",
    expectedRevision: 0,
    draft: { ...DRAFT, reviewUrl: "https://example.invalid" },
  }, deps);
  assertEquals(response.status, 400);
  assertEquals(response.json, { error: "policy-invalid" });
  assertEquals(calls, []);
});

Deno.test("stale preview and stale apply are 409 with the current revision", async () => {
  const preview = fixture({
    preview: () => Promise.resolve({ status: "stale", currentRevision: 3 }),
  });
  const p = await send(
    {
      action: "preview",
      namespace: "rating",
      environment: "sandbox",
      expectedRevision: 2,
      draft: DRAFT,
    },
    preview.deps,
  );
  assertEquals([p.status, p.json], [409, {
    status: "stale",
    currentRevision: 3,
  }]);
  const apply = fixture({
    apply: () => Promise.resolve({ status: "stale", currentRevision: 1 }),
  });
  const a = await send(applyRequest(), apply.deps);
  assertEquals([a.status, a.json], [409, {
    status: "stale",
    currentRevision: 1,
  }]);
});

Deno.test("a store that stages anything but the rendered body is an internal failure", async () => {
  const { deps } = fixture({
    preview: () =>
      Promise.resolve({
        status: "previewed",
        operationId: OPERATION,
        previewHash: HASH,
        kind: "apply",
        rollbackOf: null,
        expectedRevision: 0,
        revision: 1,
        body: body(1, false),
        currentBody: null,
        expiresAt: 1,
      }),
  });
  const original = console.error;
  console.error = () => {};
  try {
    const response = await send(
      {
        action: "preview",
        namespace: "rating",
        environment: "sandbox",
        expectedRevision: 0,
        draft: DRAFT,
      },
      deps,
    );
    assertEquals(response.status, 500);
  } finally {
    console.error = original;
  }
});

Deno.test("apply refusals map to fixed statuses; hash and body mismatches never apply", async () => {
  for (
    const [status, code] of [
      ["hash_mismatch", 409],
      ["body_mismatch", 409],
      ["preview_mismatch", 409],
      ["expired", 409],
      ["cutoff_required", 409],
      ["unknown_preview", 404],
    ] as const
  ) {
    const { deps, calls } = fixture({
      apply: () => Promise.resolve({ status }),
    });
    const response = await send(applyRequest(), deps);
    assertEquals([response.status, response.json], [code, { status }]);
    assertEquals(calls.map((c) => c.method), ["apply"], status);
  }
});

Deno.test("apply submits the exact preview and the packaged (null) cutoff snapshot", async () => {
  const { deps, calls } = fixture({
    apply: () => Promise.resolve(applied()),
    state: () => Promise.resolve(committed),
  });
  const response = await send(applyRequest(), deps);
  assertEquals(response.status, 200);
  const [owner, request, cutoff] = calls[0]!.args as [
    string,
    ApplyRequest,
    PaidCutoffSnapshot | null,
  ];
  assertEquals(owner, OWNER);
  assertEquals(request, {
    operationId: OPERATION,
    previewHash: HASH,
    namespace: "rating",
    environment: "sandbox",
    expectedRevision: 0,
    body: body(1),
  });
  assertEquals(cutoff, null);
  // A body that is not the canonical next revision never reaches the store.
  for (
    const bad of [
      body(2),
      body(1).replace('"master":true', '"master": true'),
      "{}",
    ]
  ) {
    const rejected = fixture();
    const r = await send(applyRequest({ body: bad }), rejected.deps);
    assertEquals([r.status, r.json], [400, { error: "policy-invalid" }], bad);
    assertEquals(rejected.calls, []);
  }
});

Deno.test("verified readback versus merely accepted", async () => {
  const ok = fixture({
    apply: () => Promise.resolve(applied()),
    state: () => Promise.resolve(committed),
  });
  const verified = await send(applyRequest(), ok.deps);
  assertEquals(verified.status, 200);
  assertEquals(verified.json, {
    status: "applied",
    verified: true,
    replay: false,
    operationId: OPERATION,
    revision: 1,
    body: body(1),
  });
  assertEquals(ok.calls.map((c) => c.method), ["apply", "state"]);
  for (
    const [name, state] of [
      ["readback failed", () => Promise.reject(new Error("timeout"))],
      [
        "readback older",
        () =>
          Promise.resolve({
            revision: 0,
            body: null,
            operationId: null,
            cutoff: false,
          }),
      ],
      [
        "readback other operation",
        () =>
          Promise.resolve({
            ...committed,
            operationId: "44444444-4444-4444-8444-444444444444",
          }),
      ],
    ] as const
  ) {
    const { deps } = fixture({
      apply: () => Promise.resolve(applied()),
      state,
    });
    const accepted = await send(applyRequest(), deps);
    assertEquals(accepted.status, 202, name);
    assertEquals(accepted.json, {
      status: "checking",
      operationId: OPERATION,
      revision: 1,
    }, name);
  }
});

Deno.test("timeout after commit: retrying the same operation returns its committed result", async () => {
  let attempt = 0;
  const { deps, calls } = fixture({
    // First attempt commits but the reply is lost; the retry is answered from the ledger.
    apply: () =>
      ++attempt === 1
        ? Promise.reject(new Error("connection reset"))
        : Promise.resolve(applied(true)),
    state: () => Promise.resolve(committed),
  });
  const original = console.error;
  console.error = () => {};
  try {
    assertEquals((await send(applyRequest(), deps)).status, 500);
  } finally {
    console.error = original;
  }
  const retry = await send(applyRequest(), deps);
  assertEquals(retry.status, 200);
  assertEquals(retry.json.replay, true);
  assertEquals(retry.json.revision, 1);
  const applies = calls.filter((c) => c.method === "apply").map((c) =>
    c.args[1]
  );
  assertEquals(
    applies[0],
    applies[1],
    "the retry is byte-for-byte the same operation",
  );
});

Deno.test("rollback preview asks for the earlier revision's values at the next revision", async () => {
  const { deps, calls } = fixture({
    preview: () =>
      Promise.resolve({
        status: "previewed",
        operationId: OPERATION,
        previewHash: HASH,
        kind: "rollback",
        rollbackOf: 1,
        expectedRevision: 2,
        revision: 3,
        body: body(3, true),
        currentBody: body(2, false),
        expiresAt: 1,
      }),
  });
  const response = await send(
    {
      action: "preview-rollback",
      namespace: "rating",
      environment: "sandbox",
      expectedRevision: 2,
      sourceRevision: 1,
    },
    deps,
  );
  assertEquals(response.status, 200);
  assertEquals(calls[0], {
    method: "preview",
    args: [OWNER, "rating", "sandbox", 2, null, 1],
  });
  assertEquals([
    response.json.kind,
    response.json.revision,
    response.json.rollbackOf,
  ], ["rollback", 3, 1]);
  assert(
    response.json.revision > response.json.expectedRevision,
    "rollback never lowers the revision",
  );
  // A staged rollback body at any other revision is refused.
  const wrong = fixture({
    preview: () =>
      Promise.resolve({
        status: "previewed",
        operationId: OPERATION,
        previewHash: HASH,
        kind: "rollback",
        rollbackOf: 1,
        expectedRevision: 2,
        revision: 1,
        body: body(1),
        currentBody: body(2),
        expiresAt: 1,
      }),
  });
  const original = console.error;
  console.error = () => {};
  try {
    const r = await send(
      {
        action: "preview-rollback",
        namespace: "rating",
        environment: "sandbox",
        expectedRevision: 2,
        sourceRevision: 1,
      },
      wrong.deps,
    );
    assertEquals(r.status, 500);
  } finally {
    console.error = original;
  }
});

Deno.test("read reports the authoritative state and the remote effect, Off when absent", async () => {
  const empty = fixture();
  const off = await send({
    action: "read",
    namespace: "sales",
    environment: "production",
  }, empty.deps);
  assertEquals(off.status, 200);
  assertEquals(off.json.revision, 0);
  assertEquals(off.json.body, null);
  assertEquals(Object.values(off.json.remote).every((v) => v === false), true);
  const current = fixture({ state: () => Promise.resolve(committed) });
  const on = await send({
    action: "read",
    namespace: "rating",
    environment: "sandbox",
  }, current.deps);
  assertEquals(
    [on.json.revision, on.json.body, on.json.remote.chrome_desktop],
    [1, body(1), true],
  );
});

Deno.test("production wiring: a validly signed token that is not an authenticated user of this project is refused", async () => {
  const wired = (calls: unknown[]): ProductPolicyAdminDeps => ({
    ...ownerAuthDeps(TEST_PROJECT_URL, SECRET),
    store: {
      state: () => {
        calls.push("state");
        return Promise.resolve({
          revision: 0,
          body: null,
          operationId: null,
          cutoff: false,
        });
      },
      preview: () => Promise.reject(new Error("unexpected")),
      apply: () => Promise.reject(new Error("unexpected")),
    },
    cutoffSnapshot: null,
  });
  const read = { action: "read", namespace: "rating", environment: "sandbox" };
  const good: unknown[] = [];
  assertEquals(
    (await send(
      read,
      wired(good),
      mintHs256({ sub: OWNER, exp: exp() }, SECRET),
    )).status,
    200,
  );
  assertEquals(good, ["state"], "the control token reaches the store");
  const cases: [string, Record<string, unknown>][] = [
    ["anon role", { role: "anon" }],
    ["service_role", { role: "service_role" }],
    ["foreign issuer", { iss: "https://other-project.supabase.co/auth/v1" }],
    ["foreign audience", { aud: "anon" }],
    ["no issuer", { iss: undefined }],
  ];
  for (const [name, claims] of cases) {
    const calls: unknown[] = [];
    const token = mintHs256({ sub: OWNER, exp: exp(), ...claims }, SECRET);
    const response = await send(read, wired(calls), token);
    assertEquals(response.status, 401, name);
    assertEquals(calls, [], name);
  }
});
