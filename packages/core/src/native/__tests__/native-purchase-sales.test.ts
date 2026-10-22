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
  const catalog = readFileSync(join(root, "apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift"), "utf8");
  const harness = `import Foundation
struct NativeVerifiedAppleRevocation {}
struct Package {}
public enum ReceiptStatus: String, Sendable { case entitled, noSignal }
// Synthetic StoreKit ports never contact a store. The real catalog/provenance rule is compiled below.
enum StoreKit {
  struct Transaction {
    enum Ownership { case purchased }
    let id: UInt64
    let productID: String
    let ownershipType = Ownership.purchased
    let revocationDate: Date? = nil
    static func latest(for product: String) async -> VerificationResult<Transaction>? { nil }
  }
  enum VerificationResult<T> {
    case verified(T), unverified
    var jwsRepresentation: String { "synthetic-jws" }
  }
}
typealias Transaction = StoreKit.Transaction
struct NativeIdentity { let environment = "production"; let appBundleId = "com.chartash.still" }
${catalog}
func fixtureOffer() -> AppleLifetimeOffering {
  ApplePurchaseCatalog.lifetimeOffering(offeringID: "still_pro_v3", packageID: "$rc_lifetime",
    productID: "still_pro_v3", isLifetime: true, isNonConsumable: true, price: "$9.99", currencyCode: "USD")!
}
enum RevenueCat { enum ErrorCode: Error { case paymentPendingError } }
public final class ProductPolicyRuntime {
  enum Namespace { case sales }
  struct Verdict { let allowed: Bool }
  let enabled: Bool
  var requiresSandboxInstallation = false
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
  struct SDKTransaction { let transactionIdentifier: String }
  struct Reply { let userCancelled = false; let customerInfo = true; let transaction: SDKTransaction? = nil }
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
  func offering(for package: Package) -> AppleLifetimeOffering? { fixtureOffer() }
  static func proEntitlementIsActive(in value: Bool) -> Bool { value }
  static func bounded<T>(_ deadline: UInt64, fallback: T, cancelOnTimeout: Bool,
    _ operation: @escaping @MainActor () async -> T) async -> T { await operation() }
  static func verifiedNativeIdentity(_ transaction: Transaction, jws: String) -> NativeIdentity? { NativeIdentity() }
  func freshSalesPolicy() -> ProductPolicyRuntime? { policy }
  static var installEnvironment = AppleInstallEnvironment.unavailable
  static func verifiedInstallEnvironment() async -> AppleInstallEnvironment { installEnvironment }
${method}
}
@main struct Run {
  @MainActor static func main() async {
    for state in ["unknown", "off", "on", "owned", "identity", "sandbox-installed", "sandbox-app-store-install"] {
      let executor = Executor()
      let sandbox = state.hasPrefix("sandbox")
      if state != "unknown" { executor.policy = ProductPolicyRuntime(state == "on" || state == "identity" || sandbox) }
      // A sandbox build charges only inside Apple's verified sandbox, never as an App Store install.
      executor.policy?.requiresSandboxInstallation = sandbox
      Executor.installEnvironment = state == "sandbox-installed" ? .sandbox : state == "sandbox-app-store-install" ? .production : .unavailable
      executor.receiptOwned = state == "owned"
      if state == "identity" { executor.policy?.onCheck = { executor.currentAppUserID = "replacement" } }
      Purchases.shared.charges = 0
      var newPurchases = 0
      let result = await executor.purchaseStillPro(expectedOffer: fixtureOffer(), onNewPurchase: { _ in newPurchases += 1 })
      guard newPurchases == 0 else { fatalError("missing verified transaction manufactured analytics: " + state) }
      let expected = state == "on" || state == "sandbox-installed" ? 1 : 0
      guard Purchases.shared.charges == expected else { fatalError("charge escaped sales/receipt/session gate: " + state) }
      if state == "unknown" || state == "off" || state == "sandbox-app-store-install" { guard result == .unavailable else { fatalError("unknown/off/production-install result: " + state) } }
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
