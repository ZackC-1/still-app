import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ed from "@noble/ed25519";
import { describe, expect, it, vi } from "vitest";
import type { AccessClaims } from "@still/shared-types";
import {
  accessSigningBytes,
  canonicalAccessClaims,
  encodeAccessBase64,
  type AccessTrust,
} from "../../entitlement/access-proof.js";
import type {
  ApplePurchaseLinkAuthority,
  ApplePurchaseLinkIntent,
  ApplePurchaseLinkCommit,
} from "../apple-session.js";
import { harness } from "./support/apple-session-harness.js";

const vectors = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../../../../tests/access-proof/vectors.json",
    ),
    "utf8",
  ),
);
const account = vectors.account as string;
const trust: AccessTrust = {
  environment: "sandbox",
  keys: [
    {
      kid: "synthetic-access",
      publicKeyHex: vectors.publicKeyHex,
      purpose: "access",
      environment: "sandbox",
    },
  ],
};
const intent: ApplePurchaseLinkIntent = {
  intendedAccountId: account,
  expectedOwnershipRevision: 0,
  operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const evidence = {
  productId: "still_pro_v3" as const,
  bundleId: "org.example.Still",
  signedTransaction: "header.payload.signature",
};

async function signed(claims: AccessClaims): Promise<string> {
  const payload = canonicalAccessClaims(claims);
  return JSON.stringify({
    payload: encodeAccessBase64(new TextEncoder().encode(payload)),
    kid: "synthetic-access",
    alg: "ed25519",
    signature: encodeAccessBase64(
      await ed.signAsync(
        accessSigningBytes(payload),
        new Uint8Array(32).fill(7),
      ),
    ),
  });
}
async function response(changes: Partial<AccessClaims> = {}) {
  const vector = vectors.vectors.find(
    (item: { name: string }) => item.name === "paid-apple-local",
  );
  const envelope = JSON.parse(vector.envelope);
  const local = JSON.parse(
    Buffer.from(envelope.payload, "base64url").toString(),
  ) as AccessClaims;
  const linked = {
    ...local,
    kind: "paid_account" as const,
    holder: account,
    ...changes,
  };
  return {
    status: "linked",
    ownershipRevision: 1,
    issuerTime: local.verified_at,
    localProof: await signed(local),
    accountProof: await signed(linked),
    nativeBinding: await signedBinding(local),
  };
}
async function signedBinding(local: AccessClaims): Promise<string> {
  const payload = JSON.stringify({
    schema: 1, environment: local.environment, appBundleId: evidence.bundleId,
    productId: evidence.productId, originalTransactionId: "18446744073709551615",
    right: local.right, ownershipRevision: local.ownership_revision,
    verifiedAt: local.verified_at, expiresAt: local.expires_at,
  });
  return JSON.stringify({
    payload: encodeAccessBase64(new TextEncoder().encode(payload)),
    kid: "synthetic-access", alg: "ed25519",
    signature: encodeAccessBase64(await ed.signAsync(
      new TextEncoder().encode("still-apple-right-binding-v1\n" + payload),
      new Uint8Array(32).fill(7),
    )),
  });
}
function acknowledged(value: ApplePurchaseLinkCommit) {
  return {
    schema: 1 as const, status: "committed" as const, generation: 1,
    localRight: value.localProof.claims.right,
    ownershipRevision: value.ownershipRevision,
    verifiedAt: value.localProof.claims.verified_at,
    expiresAt: value.localProof.claims.expires_at!,
    localProofIdentity: value.localProof.identity,
    accountProofIdentity: value.accountProof.identity,
  };
}
function authority(
  over: Partial<ApplePurchaseLinkAuthority> = {},
): ApplePurchaseLinkAuthority {
  return {
    trust,
    readVerifiedAccount: vi.fn(async () => ({
      id: account,
      emailConfirmed: true,
    })),
    fulfill: vi.fn(async () => response()),
    commit: vi.fn(async (value) => acknowledged(value)),
    ...over,
  };
}
async function configured(
  over: Partial<ApplePurchaseLinkAuthority> = {},
  native = vi.fn(async () => evidence),
) {
  const link = authority(over);
  const h = harness({
    purchaseLinkMode: "explicit",
    purchaseLink: link,
    bridge: {
      applePurchaseEvidence: native,
      receiptStatus: vi.fn(async () => "entitled" as const),
    },
  });
  await h.session.enterSession(account);
  return { ...h, link, native };
}

describe("Apple V3 deliberate first purchase association", () => {
  it("ordinary code sign-in/resume/foreground never rekeys or attaches while settings and receipt still work", async () => {
    const h = await configured();
    await h.session.onCodeVerified(account);
    h.session.onVisibilityChange("visible");
    await vi.waitFor(() => expect(h.controller.receiptEntitled).toBe(true));
    expect(h.sync.onSignedIn).toHaveBeenCalledTimes(2);
    expect(h.bridge.configurePurchases).not.toHaveBeenCalled();
    expect(h.bridge.attachPurchases).not.toHaveBeenCalled();
    expect(h.native).not.toHaveBeenCalled();
    expect(h.link.fulfill).not.toHaveBeenCalled();
  });

  it("default legacy composition retains the existing identity and attach behavior", async () => {
    const h = harness({
      bridge: { receiptStatus: vi.fn(async () => "entitled" as const) },
    });
    await h.session.enterSession("u1");
    expect(h.bridge.configurePurchases).toHaveBeenCalledExactlyOnceWith("u1");
    expect(h.bridge.attachPurchases).toHaveBeenCalledOnce();
    expect((await h.session.linkPurchase(intent)).status).toBe("unavailable");
  });

  it("requires explicit confirmed intended account and a configured authority", async () => {
    const missing = harness({ purchaseLinkMode: "explicit" });
    expect((await missing.session.linkPurchase(intent)).status).toBe(
      "unavailable",
    );
    const h = await configured({
      readVerifiedAccount: vi.fn(async () => ({
        id: account,
        emailConfirmed: false,
      })),
    });
    expect((await h.session.linkPurchase(intent)).status).toBe("unavailable");
    expect(h.native).not.toHaveBeenCalled();
    expect(h.link.fulfill).not.toHaveBeenCalled();
    expect(
      (
        await h.session.linkPurchase({
          ...intent,
          intendedAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        })
      ).status,
    ).toBe("stale");
  });

  it("commits verified same-right local/account proofs before reporting association, without RC transfer", async () => {
    const h = await configured();
    expect(await h.session.linkPurchase(intent)).toEqual({
      status: "linked",
      ownershipRevision: 1,
    });
    expect(h.link.readVerifiedAccount).toHaveBeenCalledTimes(2);
    expect(h.link.fulfill).toHaveBeenCalledExactlyOnceWith({
      ...intent,
      evidence,
    });
    expect(h.link.commit).toHaveBeenCalledOnce();
    expect(h.bridge.configurePurchases).not.toHaveBeenCalled();
    expect(h.bridge.attachPurchases).not.toHaveBeenCalled();
  });

  it("an owned-elsewhere answer never transfers the receipt or loses valid local rights", async () => {
    const h = await configured({
      fulfill: vi.fn(async () => ({ status: "owned_elsewhere" })),
    });
    await h.session.refreshReceipt();
    expect(await h.session.linkPurchase(intent)).toEqual({
      status: "owned_elsewhere",
    });
    expect(h.controller.receiptEntitled).toBe(true);
    expect(h.link.commit).not.toHaveBeenCalled();
    expect(h.bridge.configurePurchases).not.toHaveBeenCalled();
    expect(h.bridge.attachPurchases).not.toHaveBeenCalled();
  });

  it("rejects wrong account/right, stale clock, fabricated signatures and unacknowledged cache writes", async () => {
    for (const changes of [
      { holder: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { right: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      { ownership_revision: 2 },
    ]) {
      const h = await configured({
        fulfill: vi.fn(async () => response(changes)),
      });
      expect((await h.session.linkPurchase(intent)).status).toBe("unavailable");
      expect(h.link.commit).not.toHaveBeenCalled();
    }
    const expired = await configured({
      fulfill: vi.fn(async () => ({
        ...(await response()),
        issuerTime: vectors.expiresAt,
      })),
    });
    expect((await expired.session.linkPurchase(intent)).status).toBe(
      "unavailable",
    );
    expect(expired.link.commit).not.toHaveBeenCalled();
    const fake = await configured({
      fulfill: vi.fn(async () => ({
        ...(await response()),
        localProof: '{"entitled":true}',
      })),
    });
    expect((await fake.session.linkPurchase(intent)).status).toBe(
      "unavailable",
    );
    expect(fake.link.commit).not.toHaveBeenCalled();
    const failed = await configured({
      commit: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    expect((await failed.session.linkPurchase(intent)).status).toBe(
      "unavailable",
    );
  });

  it("requires the closed server binding and exact native durable proof acknowledgments", async () => {
    for (const change of [
      { nativeBinding: "" }, { nativeBinding: undefined }, { extra: true },
    ]) {
      const h = await configured({ fulfill: vi.fn(async () => ({ ...(await response()), ...change })) });
      expect((await h.session.linkPurchase(intent)).status).toBe("unavailable");
      expect(h.link.commit).not.toHaveBeenCalled();
    }
    for (const change of [
      { localRight: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { ownershipRevision: 2 }, { generation: -1 }, { verifiedAt: 1 },
      { localProofIdentity: "synthetic-access:" + "00".repeat(64) },
      { accountProofIdentity: null }, { extra: true },
    ]) {
      const h = await configured({
        commit: vi.fn(async (value) => ({ ...acknowledged(value), ...change }) as ReturnType<typeof acknowledged>),
      });
      expect((await h.session.linkPurchase(intent)).status).toBe("unavailable");
    }
  });

  it("fences account changes during native evidence and delayed server response", async () => {
    let resolveNative!: (value: typeof evidence) => void;
    const native = vi.fn(
      () =>
        new Promise<typeof evidence>((resolve) => {
          resolveNative = resolve;
        }),
    );
    const h = await configured({}, native);
    const pending = h.session.linkPurchase(intent);
    await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
    h.controller.accountRevision++;
    resolveNative(evidence);
    expect(await pending).toEqual({ status: "stale" });
    expect(h.link.fulfill).not.toHaveBeenCalled();
    let resolveServer!: (value: unknown) => void;
    const server = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveServer = resolve;
        }),
    );
    const second = await configured({ fulfill: server });
    const waiting = second.session.linkPurchase(intent);
    await vi.waitFor(() => expect(server).toHaveBeenCalledOnce());
    second.controller.accountRevision++;
    resolveServer(await response());
    expect(await waiting).toEqual({ status: "stale" });
    expect(second.link.commit).not.toHaveBeenCalled();
  });
});
