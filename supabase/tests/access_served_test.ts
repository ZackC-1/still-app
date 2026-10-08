// Gateway and actual CLI worker contracts. Only ephemeral GitHub Linux is enabled.
// Synthetic provider ports establish runtime composition, never actual Apple provider verification.
import { assert, assertEquals } from "@std/assert";
import { verifyServedAccessProof } from "./access_served_proof.ts";
import { createSyntheticSettingsAuthSession } from "./synthetic_settings_helpers.ts";

const cloud = Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" &&
  Deno.build.os === "linux";
const phase = Deno.env.get("STILL_ACCESS_SERVED_PHASE");
const apiKey = Deno.env.get("STILL_ACCESS_CLI_ANON_KEY");
if (
  Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1" &&
  (!cloud || !phase || !apiKey)
) throw new Error("required-cloud-tests-disabled");
const base = "http://127.0.0.1:54321/functions/v1";
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

async function request(name: string, body: unknown, bearer?: string) {
  const response = await fetch(`${base}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: apiKey!,
      "x-forwarded-for": "127.0.0.1",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`access-served-json:http-${response.status}`);
  }
  assert(plain(data), `access-served-object:http-${response.status}`);
  return { status: response.status, data };
}
async function poll<T>(
  run: () => Promise<T>,
  accepted: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 25; i++) {
    try {
      const value = await run();
      if (accepted(value)) return value;
    } catch {
      /* Bounded startup retry, never print raw body/log/token. */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("access-cli-current-worker-readiness-failed");
}
Deno.test({
  name:
    "actual CLI three access endpoints enforce anonymous-local and authenticated account envelopes",
  ignore: !cloud || !phase || !apiKey,
  fn: async () => {
    assert(phase === "default" || phase === "synthetic");
    const first = await createSyntheticSettingsAuthSession(apiKey!);
    const second = await createSyntheticSettingsAuthSession(apiKey!);
    const evidence = {
      productId: "still_pro_v3",
      bundleId: "com.example.still.rehearsal",
      signedTransaction: "e30.fixture.signature",
    };
    const intent = {
      intendedAccountId: first.subject,
      expectedOwnershipRevision: 0,
      operationId: crypto.randomUUID(),
      evidence,
    };
    const ready = await poll(
      () => request("verify-apple-access", {}),
      (value) =>
        value.status === 400 &&
        value.data.error === "invalid_apple_access_request",
    );
    assertEquals(ready.status, 400); // Actual anonymous handler, rather than gateway JWT rejection.
    for (const name of ["link-apple-access", "reconcile-entitlement"]) {
      const absent = await request(name, {});
      const forged = await request(name, {}, "forged.invalid.authority");
      assert(
        absent.status === 401 && forged.status === 401,
        "gateway must reject missing/forged authority",
      );
    }
    const invalid = await request(
      "reconcile-entitlement",
      { access_schema: 2 },
      first.bearer,
    );
    assert(
      invalid.status === 400 && invalid.data.error === "invalid_access_request",
      "current authenticated handler was not loaded",
    );
    if (phase === "default") {
      const local = await request("verify-apple-access", {
        schema: 1,
        transaction: evidence,
      });
      assert(
        local.status === 200 &&
          local.data.status === "unavailable" &&
          Object.keys(local.data).length === 1,
      );
      const account = await request("link-apple-access", intent, first.bearer);
      assert(
        account.status === 200 &&
          account.data.status === "unavailable" &&
          Object.keys(account.data).length === 1,
      );
      return;
    }
    const state: unknown = JSON.parse(
      await Deno.readTextFile(Deno.env.get("STILL_ACCESS_SERVED_STATE_FILE")!),
    );
    assert(
      plain(state) &&
        typeof state.instance === "string" &&
        typeof state.publicHex === "string" &&
        typeof state.kid === "string",
    );
    const kid = state.kid;
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(state.publicHex.match(/../g)!, (c) => parseInt(c, 16)),
      "Ed25519",
      false,
      ["verify"],
    );
    const proof = (text: unknown, kind: string, holder: string) =>
      verifyServedAccessProof(text, kind, holder, kid, publicKey);
    evidence.signedTransaction = `${
      btoa(state.instance).replaceAll("=", "")
    }.fixture.signature`;
    const local = await poll(
      () =>
        request("verify-apple-access", { schema: 1, transaction: evidence }),
      (value) => value.status === 200 && value.data.status === "verified",
    );
    assert(
      Object.keys(local.data).sort().join(",") ===
          "issuerTime,localRight,nativeBinding,proofs,schema,status" &&
        local.data.schema === 1 &&
        typeof local.data.localRight === "string" &&
        Array.isArray(local.data.proofs) &&
        local.data.proofs.length === 1,
    );
    const localClaims = await proof(
      local.data.proofs[0],
      "paid_apple_local",
      local.data.localRight,
    );
    assert(
      localClaims.right === local.data.localRight &&
        localClaims.ownership_revision === 0,
    );
    // Actual Auth confirmation and actual PostgreSQL operation/revision CAS; provider I/O only is synthetic.
    const linked = await request("link-apple-access", intent, first.bearer);
    assert(
      linked.status === 200 &&
        linked.data.status === "linked" &&
        linked.data.ownershipRevision === 1,
    );
    assert(
      Object.keys(linked.data).sort().join(",") ===
        "accountProof,issuerTime,localProof,nativeBinding,ownershipRevision,status",
    );
    const accountClaims = await proof(
      linked.data.accountProof,
      "paid_account",
      first.subject,
    );
    assert(
      accountClaims.right === local.data.localRight &&
        accountClaims.ownership_revision === 1,
    );
    await proof(
      linked.data.localProof,
      "paid_apple_local",
      local.data.localRight,
    );
    const reconciled = await request(
      "reconcile-entitlement",
      { access_schema: 1 },
      first.bearer,
    );
    assert(
      reconciled.status === 200 &&
        reconciled.data.still_sync === false &&
        plain(reconciled.data.access),
    );
    const access = reconciled.data.access;
    assert(
      access.status === "verified" &&
        access.environment === "sandbox" &&
        Array.isArray(access.proofs) &&
        access.proofs.length === 1 &&
        Array.isArray(access.revocations),
    );
    await proof(access.proofs[0], "paid_account", first.subject);
    const conflict = await request(
      "link-apple-access",
      {
        ...intent,
        intendedAccountId: second.subject,
        expectedOwnershipRevision: 1,
        operationId: crypto.randomUUID(),
      },
      second.bearer,
    );
    assert(
      conflict.status === 200 &&
        conflict.data.status === "owned_elsewhere" &&
        Object.keys(conflict.data).length === 1,
    );
    const deniedTransfer = await request(
      "link-apple-access",
      {
        ...intent,
        intendedAccountId: second.subject,
        expectedOwnershipRevision: 1,
        operationId: crypto.randomUUID(),
        sourceAccountId: first.subject,
        sourceAuthority: "forged.invalid.authority",
      },
      second.bearer,
    );
    assert(
      deniedTransfer.status === 403 &&
        deniedTransfer.data.error === "source_authority_required",
    );
    const transferred = await request(
      "link-apple-access",
      {
        ...intent,
        intendedAccountId: second.subject,
        expectedOwnershipRevision: 1,
        operationId: crypto.randomUUID(),
        sourceAccountId: first.subject,
        sourceAuthority: first.bearer,
      },
      second.bearer,
    );
    assert(
      transferred.status === 200 &&
        transferred.data.status === "linked" &&
        transferred.data.ownershipRevision === 2,
    );
    await proof(transferred.data.accountProof, "paid_account", second.subject);
    const former = await request(
      "reconcile-entitlement",
      { access_schema: 1 },
      first.bearer,
    );
    assert(
      plain(former.data.access) &&
        Array.isArray(former.data.access.proofs) &&
        former.data.access.proofs.length === 0 &&
        Array.isArray(former.data.access.revocations) &&
        former.data.access.revocations.length === 1,
    );
    const restored = await request("verify-apple-access", {
      schema: 1,
      transaction: evidence,
    });
    assert(
      restored.data.status === "verified" &&
        restored.data.localRight === local.data.localRight &&
        Array.isArray(restored.data.proofs),
    );
    await proof(
      restored.data.proofs[0],
      "paid_apple_local",
      local.data.localRight,
    );
  },
});
