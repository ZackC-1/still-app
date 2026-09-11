import { assertEquals } from "@std/assert";
import { authenticatedClaims, signHs256 } from "../_shared/jwt.ts";
import { SupabaseUserStore } from "../_shared/supabase-store.ts";
import { handleExport } from "../export-user-data/handler.ts";

const URL_BASE = "https://export-test.invalid";
const SECRET = "synthetic-export-test-secret-at-least-32-characters";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const PROFILE = {
  settings: { globalOn: false },
  updated_at: "2026-09-08T00:00:00Z",
};
const ENTITLEMENT = {
  still_sync: false,
  source: "reconcile",
  updated_at: "2026-09-08T00:00:00Z",
};

// Only HTTP is replaced: the handler, adapter, SDK and JWT verification all run normally.
async function exportFromHttp(
  profile: unknown[] | number,
  entitlement: unknown[] | number,
  jwtOverride?: string | null,
) {
  const jwt = await signHs256({
    sub: USER,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...authenticatedClaims(URL_BASE),
  }, SECRET);
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const result = url.pathname === "/rest/v1/profiles"
        ? profile
        : entitlement;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            typeof result === "number"
              ? {
                code: "42501",
                message: "synthetic private SDK detail",
                details: "synthetic row detail",
                hint: null,
              }
              : result,
          ),
          {
            status: typeof result === "number" ? result : 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    };
    const response = await handleExport(
      new Request(`${URL_BASE}/functions/v1/export-user-data`, {
        method: "POST",
        headers: {
          ...(jwtOverride === null
            ? {}
            : { Authorization: `Bearer ${jwtOverride ?? jwt}` }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ user_id: OTHER_USER }),
      }),
      {
        jwtSecret: SECRET,
        expected: authenticatedClaims(URL_BASE),
        store: new SupabaseUserStore(URL_BASE, "synthetic-service-role-key"),
      },
    );
    assertEquals(response.headers.get("content-type"), "application/json");
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
    assertEquals(
      response.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
    );
    assertEquals(
      response.headers.get("access-control-allow-headers"),
      "authorization, x-client-info, apikey, content-type",
    );
    return { response, requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("export adapter: healthy rows retain the complete successful response", async () => {
  const { response } = await exportFromHttp([PROFILE], [ENTITLEMENT]);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    user_id: USER,
    profile: PROFILE,
    entitlement: ENTITLEMENT,
  });
});

Deno.test("export adapter: profile read failure rejects the export without leaking details", async () => {
  const { response } = await exportFromHttp(403, [ENTITLEMENT]);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "internal" });
});

Deno.test("export adapter: entitlement read failure rejects the export without leaking details", async () => {
  const { response } = await exportFromHttp([PROFILE], 403);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "internal" });
});

Deno.test("export adapter: both read failures reject the export without leaking details", async () => {
  const { response } = await exportFromHttp(403, 403);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "internal" });
});

Deno.test("export adapter: database outage rejects the export after SDK retries", async () => {
  const { response } = await exportFromHttp(503, [ENTITLEMENT]);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "internal" });
});

for (
  const [name, profile, entitlement] of [
    ["profile absent", [], [ENTITLEMENT]],
    ["entitlement absent", [PROFILE], []],
    ["both absent", [], []],
  ] as const
) {
  Deno.test(`export adapter: ${name} retains a successful null record`, async () => {
    const { response } = await exportFromHttp([...profile], [...entitlement]);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      user_id: USER,
      profile: name === "entitlement absent" ? PROFILE : null,
      entitlement: name === "profile absent" ? ENTITLEMENT : null,
    });
  });
}

Deno.test("export adapter: reads only the verified subject despite a different body user_id", async () => {
  const { response, requests } = await exportFromHttp([PROFILE], [ENTITLEMENT]);
  assertEquals(response.status, 200);
  assertEquals(
    requests.map((request) => {
      const url = new URL(request.url);
      return {
        method: request.method,
        origin: url.origin,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      };
    }).sort((a, b) => a.path.localeCompare(b.path)),
    [
      {
        method: "GET",
        origin: URL_BASE,
        path: "/rest/v1/entitlements",
        query: {
          select: "still_sync,source,updated_at",
          user_id: `eq.${USER}`,
        },
      },
      {
        method: "GET",
        origin: URL_BASE,
        path: "/rest/v1/profiles",
        query: { select: "settings,updated_at", id: `eq.${USER}` },
      },
    ],
  );
  assertEquals(await response.json(), {
    user_id: USER,
    profile: PROFILE,
    entitlement: ENTITLEMENT,
  });
});

Deno.test("export adapter: missing or invalid auth cannot read account data", async (t) => {
  const validClaims = {
    sub: USER,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...authenticatedClaims(URL_BASE),
  };
  const tokens = [
    ["missing", null],
    ["malformed", "invalid-token"],
    [
      "wrong signature",
      await signHs256(validClaims, "synthetic-wrong-signing-secret"),
    ],
    ["expired", await signHs256({ ...validClaims, exp: 1 }, SECRET)],
    [
      "wrong issuer",
      await signHs256(
        { ...validClaims, iss: "https://other.invalid/auth/v1" },
        SECRET,
      ),
    ],
    [
      "wrong audience",
      await signHs256({ ...validClaims, aud: "anon" }, SECRET),
    ],
    ["wrong role", await signHs256({ ...validClaims, role: "anon" }, SECRET)],
    [
      "invalid subject",
      await signHs256({ ...validClaims, sub: "not-a-uuid" }, SECRET),
    ],
  ] as const;
  for (const [name, token] of tokens) {
    await t.step(name, async () => {
      const { response, requests } = await exportFromHttp([PROFILE], [
        ENTITLEMENT,
      ], token);
      assertEquals(response.status, 401);
      assertEquals(await response.json(), { error: "unauthorized" });
      assertEquals(requests, []);
    });
  }
});
