import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
/** Compile the maintained native executor body with synthetic SDK/policy ports. Real policy
 * grammar/route/freshness is exercised in StillKit; this checks the actual final-charge ordering. */
it.runIf(process.platform === "darwin")("native executor holds unknown/off sales, never double-charges an owned receipt, and fences identity during policy", () => {
  const source = readFileSync(join(root, "apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift"), "utf8");
  const start = source.indexOf("  func purchaseStillPro(");
  expect(start).toBeGreaterThan(-1);
  const opening = source.indexOf("async -> Outcome {", start) + "async -> Outcome ".length;
  let depth = 1, end = opening + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  const method = source.slice(start, end);
  const decision = readFileSync(join(root, "apps/apple/StillKit/Sources/StillKit/PurchaseDecision.swift"), "utf8");
  const boundary = readFileSync(join(root, "apps/apple/StillKit/Sources/StillKit/NativeSalesPurchaseBoundary.swift"), "utf8");
  const harness = `import Foundation
struct NativeVerifiedAppleRevocation {}
struct AppleLifetimeOffering: Equatable {}
struct Package {}
enum ReceiptStatus { case entitled, noSignal }
enum RevenueCat { enum ErrorCode: Error { case paymentPendingError } }
public final class ProductPolicyRuntime {
  enum Namespace { case sales }
  struct Verdict { let allowed: Bool }
  let enabled: Bool
  var questions = 0
  var onCheck: (() -> Void)?
  init(_ enabled: Bool) { self.enabled = enabled }
  func freshCheck(_ namespace: Namespace) async -> Verdict {
    questions += 1; onCheck?(); return Verdict(allowed: enabled)
  }
}
final class Purchases {
  static let shared = Purchases()
  var charges = 0
  struct Reply { let userCancelled = false; let customerInfo = true }
  func purchase(package: Package) async throws -> Reply { charges += 1; return Reply() }
}
${decision}
${boundary}
@MainActor final class Executor {
  enum Outcome: Equatable { case purchased, cancelled, pending, unavailable, staleIdentity, failed(String) }
  var currentAppUserID: String?
  let isConfigured = true
  var receiptOwned = false
  var policy: ProductPolicyRuntime?
  func refreshReceiptStatus(onVerifiedRevocation: (NativeVerifiedAppleRevocation) -> Void) async -> ReceiptStatus { receiptOwned ? .entitled : .noSignal }
  func ensureAnonymousIdentity() async -> Bool { true }
  func hasStillPro() async -> Bool { false }
  func stillProPackage() async -> Package? { Package() }
  func offering(for package: Package) -> AppleLifetimeOffering? { AppleLifetimeOffering() }
  static func proEntitlementIsActive(in value: Bool) -> Bool { value }
  func freshSalesPolicy() -> ProductPolicyRuntime? { policy }
${method}
}
@main struct Run {
  @MainActor static func main() async {
    for state in ["unknown", "off", "on", "owned", "identity"] {
      let executor = Executor()
      if state != "unknown" { executor.policy = ProductPolicyRuntime(state == "on" || state == "identity") }
      executor.receiptOwned = state == "owned"
      if state == "identity" { executor.policy?.onCheck = { executor.currentAppUserID = "replacement" } }
      Purchases.shared.charges = 0
      let result = await executor.purchaseStillPro(expectedOffer: AppleLifetimeOffering())
      let expected = state == "on" ? 1 : 0
      guard Purchases.shared.charges == expected else { fatalError("charge escaped sales/receipt/session gate: " + state) }
      if state == "unknown" || state == "off" { guard result == .unavailable else { fatalError("unknown/off result") } }
      if state == "owned" { guard executor.policy?.questions == 0 else { fatalError("owned receipt consulted sales") } }
    }
    print("native-executor-sales-PASS")
  }
}
`;
  const dir = mkdtempSync(join(tmpdir(), "still-native-sales-executor-"));
  try {
    const file = join(dir, "main.swift"), binary = join(dir, "proof");
    writeFileSync(file, harness);
    execFileSync("swiftc", ["-parse-as-library", "-swift-version", "5", file, "-o", binary], { encoding: "utf8", timeout: 90_000 });
    expect(execFileSync(binary, [], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("native-executor-sales-PASS");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 100_000);
