// Disposable hosted rehearsal I/O port. Never deployed or imported by production config.
export * from "../../functions/_shared/apple-access.ts";
import type {
  AppleAccessVerifier,
  AppleEvidence,
  VerifiedAppleTransaction,
} from "../../functions/_shared/apple-access.ts";
export function createAppleAccessVerifier(config: {
  environment?: string;
  [key: string]: unknown;
}): AppleAccessVerifier | null {
  const instance = Deno.env.get("STILL_ACCESS_REHEARSAL_INSTANCE");
  if (!instance || config.environment !== "sandbox") return null;
  return {
    async authenticate(evidence: AppleEvidence) {
      if (
        evidence.bundleId !== "com.example.still.rehearsal" ||
        evidence.productId !== "still_pro_v3" ||
        evidence.signedTransaction !==
          `${btoa(instance).replaceAll("=", "")}.fixture.signature`
      )
        return null;
      const identity = [
        "apple",
        "sandbox",
        evidence.bundleId,
        evidence.productId,
        "900719925474099312345",
      ];
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(identity)),
        ),
      );
      return {
        key: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(
          "",
        ),
        environment: "sandbox",
        bundleId: evidence.bundleId,
        productId: "still_pro_v3",
        originalTransactionId: "900719925474099312345",
        transactionId: "900719925474099312345",
        active: true,
      };
    },
    refresh(transaction: VerifiedAppleTransaction) {
      return Promise.resolve({ ...transaction });
    },
  };
}
