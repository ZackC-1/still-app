import { assertEquals } from "@std/assert";
import { handleProductPolicyRead, type PolicyReader } from "./handler.ts";

const BODY =
  '{"schema":1,"environment":"production","revision":2,"master":true,"surfaces":{"chrome_desktop":true,"edge_desktop":false,"firefox_desktop":false,"firefox_android":false,"apple_mobile_host":false,"apple_macos_host":false},"builds":[{"surface":"chrome_desktop","build":"3.0.0"}]}';

function reader(answer: string | null | Error) {
  const calls: string[] = [];
  const port: PolicyReader = {
    read: (namespace, environment) => {
      calls.push(`${namespace}/${environment}`);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  return { port, calls };
}

function post(
  body: unknown,
  url = "https://example.test/functions/v1/product-policy",
  method = "POST",
) {
  return new Request(url, {
    method,
    body: method === "GET"
      ? undefined
      : typeof body === "string"
      ? body
      : JSON.stringify(body),
  });
}

Deno.test("current policy: exactly the stored body, never cached", async () => {
  const { port, calls } = reader(BODY);
  const response = await handleProductPolicyRead(
    post({ namespace: "rating", environment: "production" }),
    {
      reader: port,
    },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.text(), BODY);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(calls, ["rating/production"]);
  // Only CORS, caching and content headers: no revision, operation or owner header.
  assertEquals(
    [...response.headers.keys()].sort(),
    [
      "access-control-allow-headers",
      "access-control-allow-methods",
      "access-control-allow-origin",
      "cache-control",
      "content-type",
      "x-content-type-options",
    ],
  );
});

Deno.test("no policy row means Off: 404 with no body", async () => {
  const { port } = reader(null);
  const response = await handleProductPolicyRead(
    post({ namespace: "sales", environment: "sandbox" }),
    {
      reader: port,
    },
  );
  assertEquals(response.status, 404);
  assertEquals(await response.text(), "");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("a request may carry only the namespace and environment", async () => {
  const cases: [string, Request][] = [
    [
      "identifier key",
      post({ namespace: "rating", environment: "production", installId: "x" }),
    ],
    [
      "query string",
      post(
        { namespace: "rating", environment: "production" },
        "https://e.test/p?device=1",
      ),
    ],
    [
      "unknown namespace",
      post({ namespace: "cutoff", environment: "production" }),
    ],
    [
      "pricing namespace",
      post({ namespace: "pricing", environment: "production" }),
    ],
    [
      "unknown environment",
      post({ namespace: "rating", environment: "staging" }),
    ],
    ["missing key", post({ namespace: "rating" })],
    ["array", post([{ namespace: "rating", environment: "production" }])],
    ["not json", post("{nope")],
    [
      "oversized",
      post({
        namespace: "rating",
        environment: "production",
        pad: "x".repeat(300),
      }),
    ],
  ];
  for (const [name, request] of cases) {
    const { port, calls } = reader(BODY);
    const response = await handleProductPolicyRead(request, { reader: port });
    assertEquals(response.status, 400, name);
    assertEquals(await response.text(), "", name);
    assertEquals(calls, [], name);
  }
  const { port } = reader(BODY);
  assertEquals(
    (await handleProductPolicyRead(post(null, undefined, "GET"), {
      reader: port,
    })).status,
    405,
  );
  assertEquals(
    (await handleProductPolicyRead(post(null, undefined, "OPTIONS"), {
      reader: port,
    })).status,
    204,
  );
});

Deno.test("storage failure or a body the shared grammar refuses is Off (503), never passed on", async () => {
  const cases: [string, string | Error][] = [
    ["storage down", new Error("password=synthetic-secret host=db")],
    [
      "unknown key",
      BODY.replace('"master":true', '"master":true,"reviewUrl":"x"'),
    ],
    ["wrong environment", BODY.replace('"production"', '"sandbox"')],
    ["revision zero", BODY.replace('"revision":2', '"revision":0')],
  ];
  for (const [name, answer] of cases) {
    const { port } = reader(answer);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const response = await handleProductPolicyRead(
        post({ namespace: "rating", environment: "production" }),
        {
          reader: port,
        },
      );
      assertEquals(response.status, 503, name);
      assertEquals(await response.text(), "", name);
      assertEquals(response.headers.get("cache-control"), "no-store", name);
      assertEquals(
        JSON.stringify(errors).includes("synthetic-secret"),
        false,
        name,
      );
    } finally {
      console.error = original;
    }
  }
});
