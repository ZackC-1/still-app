import { assert, assertEquals, assertRejects } from "@std/assert";
import { createAccessSigner } from "../functions/_shared/access-issuer.ts";
import { verifyServedAccessProof } from "./access_served_proof.ts";
import { pollServedAccess } from "./access_served_readiness.ts";
// Public RFC8032 vector only. Actual issuer and actual served probe helper, no provider/DB.
const hex = (text: string) =>
  Uint8Array.from(text.match(/../g)!, (c) => parseInt(c, 16));
const publicHex =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
Deno.test("served proof check accepts the actual issuer and refuses casing, signature and identity drift", async () => {
  const signer = (await createAccessSigner({
    environment: "sandbox",
    kid: "synthetic-access",
    publicKeyHex: publicHex,
    privateKeyPkcs8Base64: btoa(
      String.fromCharCode(
        ...hex(
          "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        ),
      ),
    ),
  }))!;
  const right = {
    right: "33333333-3333-3333-3333-333333333333",
    holder: "11111111-1111-1111-1111-111111111111",
    revision: 2,
    verified_at: 1791374400000,
  };
  const publicKey = await crypto.subtle.importKey(
    "raw",
    hex(publicHex),
    "Ed25519",
    false,
    ["verify"],
  );
  const text = await signer.sign(right);
  const read = (
    value: string,
    holder = right.holder,
    kind = "paid_account",
    kid = "synthetic-access",
  ) => verifyServedAccessProof(value, kind, holder, kid, publicKey);
  assertEquals((await read(text)).right, right.right);
  for (
    const patch of [{ alg: "Ed25519" }, { signature: "AA" }, { kid: "other" }]
  ) {
    await assertRejects(() =>
      read(JSON.stringify({ ...JSON.parse(text), ...patch }))
    );
  }
  await assertRejects(() => read(text, right.right));
  await assertRejects(() => read(text, right.holder, "paid_apple_local"));
});

Deno.test("served readiness retains exact acceptance and bounded startup failures", async () => {
  const ready: { status: number; data: Record<string, unknown> } = {
    status: 400,
    data: { error: "invalid_apple_access_request" },
  };
  let attempts = 0;
  const waits: number[] = [];
  const result = await pollServedAccess(
    () => Promise.resolve(++attempts === 1 ? { status: 502, data: {} } : ready),
    (value) =>
      value.status === 400 &&
      value.data.error === "invalid_apple_access_request",
    "default",
    (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  );
  assert(result === ready, "accepted response identity must be retained");
  assertEquals(attempts, 2);
  assertEquals(waits, [400]);

  attempts = 0;
  waits.length = 0;
  await assertRejects(
    () =>
      pollServedAccess(
        () => {
          attempts++;
          return Promise.resolve({ status: 400, data: { error: "other" } });
        },
        (value) =>
          value.status === 400 &&
          value.data.error === "invalid_apple_access_request",
        "synthetic",
        (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      ),
    Error,
    "access-cli-current-worker-readiness-failed:synthetic:http-400-unexpected-envelope",
  );
  assertEquals(attempts, 25);
  assertEquals(waits, Array(25).fill(400));
});

Deno.test("served readiness exposes only closed phase and HTTP/protocol/transport conditions", async () => {
  const privateText = "synthetic-private-body-token-account-log";
  const noWait = () => Promise.resolve();
  for (
    const [status, condition] of [
      [200, "http-200"],
      [400, "http-400"],
      [401, "http-401"],
      [403, "http-403"],
      [404, "http-404"],
      [405, "http-405"],
      [429, "http-429"],
      [500, "http-500"],
      [502, "http-502"],
      [503, "http-503"],
      [504, "http-504"],
      [418, "unexpected-http"],
    ] as const
  ) {
    const error = await assertRejects(() =>
      pollServedAccess(
        () =>
          Promise.resolve({
            status,
            data: {
              error: privateText,
              account: privateText,
              token: privateText,
            },
          }),
        () => false,
        "synthetic",
        noWait,
      )
    );
    assert(error instanceof Error, "readiness failure must be an Error");
    assertEquals(
      error.message,
      `access-cli-current-worker-readiness-failed:synthetic:${condition}-unexpected-envelope`,
    );
    assert(
      !error.message.includes(privateText),
      "response content must not enter diagnostics",
    );
  }
  for (
    const [failure, condition] of [
      [new Error("access-served-json:http-502"), "http-502-non-json"],
      [new Error("access-served-object:http-503"), "http-503-non-object"],
      [
        new Error(`access-served-json:http-500:${privateText}`),
        "request-failed",
      ],
      [new DOMException(privateText, "TimeoutError"), "request-timeout"],
      [new Error(privateText), "request-failed"],
    ] as const
  ) {
    let attempts = 0;
    const error = await assertRejects(() =>
      pollServedAccess(
        () => {
          attempts++;
          return Promise.reject(failure);
        },
        () => false,
        privateText,
        noWait,
      )
    );
    assertEquals(attempts, 25);
    assert(error instanceof Error, "readiness failure must be an Error");
    assertEquals(
      error.message,
      `access-cli-current-worker-readiness-failed:unknown:${condition}`,
    );
    assert(
      !error.message.includes(privateText),
      "request/phase content must not enter diagnostics",
    );
  }
});
