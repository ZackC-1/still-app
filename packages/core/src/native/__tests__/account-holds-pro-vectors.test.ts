// ISS-0105 follow-up: the Apple app's own "Still Pro User" provenance (readAccountHeldPro) and the
// flag native now publishes to Safari (StillKit `accountHoldsStillPro`) read the same shared cases,
// so the app and the Safari extension can never disagree about whose Still Pro it is.
// StillKit's AccountHoldsProTests reads tests/access-proof/account-holds-pro-vectors.json too.
import { describe, expect, it, vi } from "vitest";
import proofs from "../../../../../tests/access-proof/vectors.json";
import shared from "../../../../../tests/access-proof/account-holds-pro-vectors.json";
import { createApplePurchaseAuthority, type ApplePurchaseAuthorityDeps } from "../apple-purchase-authority.js";
import type { AccessTrust } from "../../entitlement/access-proof.js";

function trust(name: string): AccessTrust {
  const environment = name === "production" ? "production" : "sandbox";
  return {
    environment,
    keys: [{ kid: "synthetic-access", purpose: "access", environment, publicKeyHex: name === "other-key" ? shared.otherPublicKeyHex : proofs.publicKeyHex }],
    protectedSnapshot: { product: proofs.protectedProduct, benefits: ["youtube.comments"] },
  };
}

function authority(name: string, record: unknown) {
  const unused = () => { throw new Error("not part of this read"); };
  const deps = {
    trust: trust(name),
    now: () => shared.wall,
    bridge: {
      appleLocalPurchaseEvidence: vi.fn(unused), installAppleAccess: vi.fn(unused), observeAppleAccess: vi.fn(unused),
      observeAppleLinkAccess: vi.fn(unused), observeBenefits: vi.fn(unused),
      observeAccess: vi.fn(async () => structuredClone(record)),
    },
    readVerifiedAccount: vi.fn(unused), readAccessToken: vi.fn(unused), verifyLocal: vi.fn(unused), fulfillLink: vi.fn(unused),
  } as unknown as ApplePurchaseAuthorityDeps;
  return createApplePurchaseAuthority(deps);
}

describe("account-holds-pro shared vectors (TypeScript side)", () => {
  it("covers both answers", () => {
    expect(shared.cases.some(c => c.accountHoldsPro)).toBe(true);
    expect(shared.cases.some(c => !c.accountHoldsPro)).toBe(true);
  });

  it.each(shared.cases.map(c => [c.name, c] as const))("%s", async (_name, c) => {
    // The app asks for its own signed-in account; a signed-out record is asked about the vectors' account.
    const account = (c.record.accountId as string | null) ?? proofs.account;
    expect(await authority(c.trust, c.record).readAccountHeldPro(account)).toBe(c.accountHoldsPro);
  });
});
