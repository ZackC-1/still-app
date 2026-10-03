import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createSettingsAnchorIdentity,
  issueSettingsAnchorReceipt,
  type SettingsAnchorState,
  verifySettingsAnchorReceipt,
} from "./settings-anchor.ts";

// Public deterministic synthetic fixtures; no account/provider records or real keys.
const SUBJECT = "00000000-0000-0000-0000-000000000001";
const LINEAGE = "00000000-0000-0000-0000-000000000002";
const OTHER_LINEAGE = "00000000-0000-0000-0000-000000000003";
const OTHER_SUBJECT = "00000000-0000-0000-0000-000000000004";
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const STATE: SettingsAnchorState = {
  subject: SUBJECT,
  key: KEY,
  lineage: LINEAGE,
  revision: 10,
};
// Independent Python stdlib HMAC-SHA256 vector over the exact four ASCII lines.
const RECEIPT = {
  version: 1,
  lineage: LINEAGE,
  revision: 10,
  mac: "hUcefVDAGeBJaAvli5l36iriq2YGEEDtACf9fAdVsvU",
};

function encodedMac(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}

async function signedBytes(bytes: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    KEY,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodedMac(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bytes)),
    ),
  );
}

// All six synthetic HMAC cases in the approved reference model, against WebCrypto.
Deno.test("reference: valid original anchor", async () => {
  assertEquals(await issueSettingsAnchorReceipt(STATE), RECEIPT);
  assertEquals(await verifySettingsAnchorReceipt(RECEIPT, STATE), RECEIPT);
});

Deno.test("reference: cannot forge future original anchor", async () => {
  assertEquals(
    await verifySettingsAnchorReceipt({ ...RECEIPT, revision: 20 }, STATE),
    null,
  );
});

Deno.test("reference: future forgery stays invalid after server advances", async () => {
  assertEquals(
    await verifySettingsAnchorReceipt({ ...RECEIPT, revision: 20 }, {
      ...STATE,
      revision: 30,
    }),
    null,
  );
});

Deno.test("reference: lineage isolation", async () => {
  assertEquals(
    await verifySettingsAnchorReceipt(RECEIPT, {
      ...STATE,
      lineage: OTHER_LINEAGE,
    }),
    null,
  );
  assertEquals(
    await verifySettingsAnchorReceipt({ ...RECEIPT, lineage: OTHER_LINEAGE }, {
      ...STATE,
      lineage: OTHER_LINEAGE,
    }),
    null,
  );
});

Deno.test("reference: account isolation", async () => {
  assertEquals(
    await verifySettingsAnchorReceipt(RECEIPT, {
      ...STATE,
      subject: OTHER_SUBJECT,
    }),
    null,
  );
});

Deno.test("reference: wrong MAC rejected", async () => {
  assertEquals(
    await verifySettingsAnchorReceipt({
      ...RECEIPT,
      mac: encodedMac(new Uint8Array(32)),
    }, STATE),
    null,
  );
});

Deno.test("wrong key and changed lower revision cannot verify", async () => {
  assertEquals(
    await verifySettingsAnchorReceipt(RECEIPT, {
      ...STATE,
      key: new Uint8Array(32),
    }),
    null,
  );
  assertEquals(
    await verifySettingsAnchorReceipt({ ...RECEIPT, revision: 9 }, STATE),
    null,
  );
});

Deno.test("old receipt remains valid in live lineage without rebasing or expiry", async () => {
  for (const revision of [10, 30, Number.MAX_SAFE_INTEGER]) {
    const verified = await verifySettingsAnchorReceipt(RECEIPT, {
      ...STATE,
      revision,
    });
    assertEquals(verified, RECEIPT);
    assert(
      verified !== RECEIPT,
      "return a validated snapshot, not the caller's mutable object",
    );
  }
  assertEquals(
    await verifySettingsAnchorReceipt(RECEIPT, { ...STATE, revision: 9 }),
    null,
  );
  assertEquals(RECEIPT.revision, 10);
});

Deno.test("issuance snapshots caller state and key bytes before awaiting", async () => {
  const state = { ...STATE, key: new Uint8Array(KEY) };
  const pending = issueSettingsAnchorReceipt(state);

  state.subject = OTHER_SUBJECT;
  state.lineage = OTHER_LINEAGE;
  state.revision = 30;
  state.key.fill(255);
  state.key = new Uint8Array(32);

  assertEquals(await pending, RECEIPT);
});

Deno.test("verification snapshots caller receipt, state and key bytes before awaiting", async () => {
  const receipt = { ...RECEIPT };
  const state = { ...STATE, key: new Uint8Array(KEY) };
  const pending = verifySettingsAnchorReceipt(receipt, state);

  receipt.version = 2;
  receipt.lineage = OTHER_LINEAGE;
  receipt.revision = 20;
  receipt.mac = encodedMac(new Uint8Array(32));
  state.subject = OTHER_SUBJECT;
  state.lineage = OTHER_LINEAGE;
  state.revision = 9;
  state.key.fill(255);
  state.key = new Uint8Array(32);

  assertEquals(await pending, RECEIPT);
});

Deno.test("revision bounds use canonical unsigned decimal bytes", async () => {
  for (
    const [revision, mac] of [
      [0, "ZF41agh57umE0Y5LfslOSVji3aTBDjAM-xbNcUAMjQE"],
      [Number.MAX_SAFE_INTEGER, "JjjmYeP6a6hyvBBDdAKKNWhyDNT9n9y7Hv9bvqv7kUI"],
    ] as const
  ) {
    const state = { ...STATE, revision };
    const receipt = { version: 1, lineage: LINEAGE, revision, mac } as const;
    assertEquals(await issueSettingsAnchorReceipt(state), receipt);
    assertEquals(await verifySettingsAnchorReceipt(receipt, state), receipt);
  }
});

Deno.test("purpose and noncanonical signed byte representations reject", async () => {
  const exact = `still-settings-anchor-v1\n${SUBJECT}\n${LINEAGE}\n10`;
  for (
    const bytes of [
      exact.replace("still-settings-anchor-v1", "still-paid-proof-v1"),
      exact + "\n",
      exact.replaceAll("\n", "\r\n"),
      exact.replace(/10$/, "010"),
      exact.replace(/10$/, "+10"),
      exact.replace(/10$/, "1e1"),
      exact.replace(/10$/, "10.0"),
      exact.replace(SUBJECT, OTHER_SUBJECT),
      exact.replace(LINEAGE, OTHER_LINEAGE),
    ]
  ) {
    assertEquals(
      await verifySettingsAnchorReceipt({
        ...RECEIPT,
        mac: await signedBytes(bytes),
      }, STATE),
      null,
      bytes,
    );
  }
});

Deno.test("receipt is a closed object with fixed version and exact types", async () => {
  const bad: unknown[] = [
    null,
    undefined,
    true,
    1,
    "receipt",
    [],
    [RECEIPT],
    new Date(),
    { ...RECEIPT, extra: true },
    { ...RECEIPT, [Symbol("extra")]: true },
    { ...RECEIPT, version: "1" },
    { ...RECEIPT, version: 2 },
    { ...RECEIPT, version: true },
    { ...RECEIPT, lineage: 2 },
    { ...RECEIPT, mac: new Uint8Array(32) },
    Object.create(RECEIPT),
    Object.defineProperty({ ...RECEIPT }, "mac", { get: () => RECEIPT.mac }),
  ];
  for (const key of Object.keys(RECEIPT)) {
    const missing: Record<string, unknown> = { ...RECEIPT };
    delete missing[key];
    bad.push(missing);
  }
  for (const receipt of bad) {
    assertEquals(await verifySettingsAnchorReceipt(receipt, STATE), null);
  }
  assertEquals(
    await verifySettingsAnchorReceipt(
      Object.assign(Object.create(null), RECEIPT),
      STATE,
    ),
    RECEIPT,
  );
});

Deno.test("receipt and server revisions reject coercion and numeric ambiguity", async () => {
  for (
    const revision of [
      -1,
      -0,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "10",
      "010",
      true,
      null,
      undefined,
      10n,
    ]
  ) {
    assertEquals(
      await verifySettingsAnchorReceipt({ ...RECEIPT, revision }, STATE),
      null,
    );
    const state = { ...STATE, revision } as SettingsAnchorState;
    assertEquals(await verifySettingsAnchorReceipt(RECEIPT, state), null);
    await assertRejects(() => issueSettingsAnchorReceipt(state), TypeError);
  }
});

Deno.test("canonical lowercase UUID grammar applies to receipt and trusted state", async () => {
  const canonical = "abcdefab-cdef-abcd-efab-cdefabcdefab";
  const good = { ...STATE, subject: canonical, lineage: canonical };
  const valid = await issueSettingsAnchorReceipt(good);
  assertEquals(await verifySettingsAnchorReceipt(valid, good), valid);
  for (
    const uuid of [
      canonical.toUpperCase(),
      " " + canonical,
      canonical + "\n",
      canonical.replaceAll("-", ""),
      "{ " + canonical + " }",
      "not-uuid",
      SUBJECT + "\nother",
    ]
  ) {
    assertEquals(
      await verifySettingsAnchorReceipt({ ...RECEIPT, lineage: uuid }, STATE),
      null,
    );
    for (const field of ["subject", "lineage"] as const) {
      const state = { ...STATE, [field]: uuid };
      assertEquals(await verifySettingsAnchorReceipt(RECEIPT, state), null);
      await assertRejects(() => issueSettingsAnchorReceipt(state), TypeError);
    }
  }
});

Deno.test("MAC requires canonical unpadded base64url for exactly 32 bytes", async () => {
  // U -> V changes only unused pad bits: a permissive decoder yields identical bytes.
  const noncanonicalAlias = RECEIPT.mac.slice(0, -1) + "V";
  assertEquals(
    atob(noncanonicalAlias.replace(/-/g, "+").replace(/_/g, "/") + "="),
    atob(RECEIPT.mac + "="),
  );
  for (
    const mac of [
      RECEIPT.mac + "=",
      noncanonicalAlias,
      RECEIPT.mac + "\n",
      " " + RECEIPT.mac,
      "",
      "!".repeat(43),
      "A".repeat(44),
      encodedMac(new Uint8Array(31)),
      encodedMac(new Uint8Array(33)),
      RECEIPT.mac.slice(0, -1) + "+",
      RECEIPT.mac.slice(0, -1) + "/",
    ]
  ) {
    assertEquals(
      await verifySettingsAnchorReceipt({ ...RECEIPT, mac }, STATE),
      null,
    );
  }
});

Deno.test("keys are raw 32-byte Uint8Array values, never auth strings or other lengths", async () => {
  for (
    const key of [
      new Uint8Array(0),
      new Uint8Array(31),
      new Uint8Array(33),
      new ArrayBuffer(32),
      Array(32).fill(0),
      "auth-or-rule-secret",
      null,
    ]
  ) {
    const state = { ...STATE, key } as SettingsAnchorState;
    assertEquals(await verifySettingsAnchorReceipt(RECEIPT, state), null);
    await assertRejects(() => issueSettingsAnchorReceipt(state), TypeError);
  }
  const backing = new Uint8Array(40);
  backing.set(KEY, 4);
  assertEquals(
    await issueSettingsAnchorReceipt({
      ...STATE,
      key: backing.subarray(4, 36),
    }),
    RECEIPT,
  );
});

Deno.test("fresh server identities use independent random 32-byte keys and UUID lineages", async () => {
  const first = createSettingsAnchorIdentity();
  const second = createSettingsAnchorIdentity();
  assertEquals(first.key.byteLength, 32);
  assertEquals(second.key.byteLength, 32);
  assert(first.key instanceof Uint8Array);
  assert(first.key.some((value, i) => value !== second.key[i]));
  assert(first.lineage !== second.lineage);
  for (const identity of [first, second]) {
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(identity.lineage),
    );
    const state = { ...STATE, ...identity };
    const receipt = await issueSettingsAnchorReceipt(state);
    assertEquals(await verifySettingsAnchorReceipt(receipt, state), receipt);
  }
});
