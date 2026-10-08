import { assertEquals, assertRejects } from "@std/assert";
import { createAccessSigner } from "../functions/_shared/access-issuer.ts";
import { verifyServedAccessProof } from "./access_served_proof.ts";
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
