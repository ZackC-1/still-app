import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");

/** Execute the maintained router arm and revocation fence with delayed synthetic network ports.
 * StillKit tests cover real signatures and atomic backing; this protects the router's async
 * admission checks before it calls that backing. It does not emulate WebKit or hosted Auth. */
it.runIf(process.platform === "darwin")("native account router refuses obsolete reconciliation after fetch and dormant/untrusted requests", () => {
  const source = readFileSync(join(root, "apps/apple/Still/Shared (App)/WebBridgeRouter.swift"), "utf8");
  const start = source.indexOf('    case "reconcileAccountAccess":');
  const end = source.indexOf('    case "installAppleAccess":', start);
  const fenceStart = source.indexOf("struct AppleAccessRevocationFence {");
  const fenceEnd = source.indexOf("@MainActor\nfinal class WebBridgeRouter", fenceStart);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(fenceStart).toBeGreaterThan(-1);
  expect(fenceEnd).toBeGreaterThan(fenceStart);
  const harness = `import Foundation
struct NativeVerifiedAppleRevocation {
  enum Ownership { case purchased, familyShared }
  struct Identity {
    let environment = "sandbox", appBundleId = "test.still", productId = "still_pro_v3", originalTransactionId = "1"
    let ownership = Ownership.purchased
  }
  let identity = Identity()
  let revokedAt = 1
}
${source.slice(fenceStart, fenceEnd)}
struct Session { let accountId: String; let sessionId: String }
struct Snapshot {}
struct Commit: Encodable { let status = "committed" }
struct BridgeFrame { let isTrusted: Bool }
enum MonetizationConfig { static var paidTierEnabled = true }
enum Failure: Error { case stale }
enum NativeAccessSessionCheck { case verified(Session), rejected(subject: String?), unavailable }
@MainActor final class Verifier {
  var calls = 0
  var result: NativeAccessSessionCheck = .verified(Session(accountId: "account-a", sessionId: "session-a"))
  var first: NativeAccessSessionCheck?
  func check(accessToken: String) async -> NativeAccessSessionCheck {
    calls += 1
    if calls == 1, let first { return first }
    return result
  }
}
@MainActor final class Status {
  struct Value { let accountId: String }
  var accountId: String? = "account-a"
  func peek() -> Value? { accountId.map { Value(accountId: $0) } }
}
@MainActor final class Store {
  var generation = 0
  var installs = 0
  var clears = 0
  var bytes = "untouched"
  func clearAccessAccount() throws { clears += 1; generation += 1; bytes = "cleared" }
  func prepareAppleAccessInstall() throws -> Int { generation }
  func prepareAccountAccess(_ session: Session, expectedGeneration: Int) throws -> Int {
    guard expectedGeneration == generation else { throw Failure.stale }; return generation
  }
  func installAccountAccess(_ snapshot: Snapshot, session: Session, expectedGeneration: Int) throws -> Commit {
    guard expectedGeneration == generation else { throw Failure.stale }
    installs += 1; bytes = "installed"; return Commit()
  }
}
@MainActor final class FetchPort {
  var releases: [CheckedContinuation<Snapshot, Never>] = []
  func fetch() async -> Snapshot {
    await withCheckedContinuation { releases.append($0) }
  }
  func release(_ index: Int) { releases[index].resume(returning: Snapshot()) }
}
@MainActor final class NativeAccountAccessRuntime {
  static var available = true
  static var port = FetchPort()
  init?() { if !Self.available { return nil } }
  func fetch(accessToken: String, session: Session) async throws -> Snapshot { await Self.port.fetch() }
}
@MainActor final class Router {
  let entitlement = Store()
  let accountSyncStatus = Status()
  let accessSessionVerifier: Verifier? = Verifier()
  var accessAccountLineage = 0
  var accessRevocations = AppleAccessRevocationFence()
  func retryVerifiedRevocations() { accessRevocations.retry { _ in } }
  func handle(_ body: Any, frame: BridgeFrame, reply: @escaping (Any?, String?) -> Void) {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else { reply(nil, "malformed"); return }
    switch kind {
${source.slice(start, end)}
    default: reply(nil, "unsupported")
    }
  }
}
@MainActor final class Reply {
  var calls = 0
  var value: Any?
  var error: String?
  func accept(_ value: Any?, _ error: String?) { calls += 1; self.value = value; self.error = error }
}
@main struct Run {
  @MainActor static func settle(_ condition: () -> Bool) async {
    for _ in 0..<1000 { if condition() { return }; await Task.yield() }
    fatalError("router task did not settle")
  }
  @MainActor static func main() async {
    let body: [String: Any] = ["kind": "reconcileAccountAccess", "accessToken": "synthetic-token"]
    for scenario in ["current", "auth-lost", "account-replaced", "session-renewed", "signed-out", "display-replaced", "newer-request", "revoked", "pending-revocation", "store-generation"] {
      let router = Router(), reply = Reply()
      NativeAccountAccessRuntime.port = FetchPort()
      router.handle(body, frame: BridgeFrame(isTrusted: true), reply: reply.accept)
      await settle { NativeAccountAccessRuntime.port.releases.count == 1 }
      switch scenario {
      case "auth-lost": router.accessSessionVerifier!.result = .unavailable
      case "account-replaced": router.accessSessionVerifier!.result = .verified(Session(accountId: "account-b", sessionId: "session-a"))
      case "session-renewed": router.accessSessionVerifier!.result = .verified(Session(accountId: "account-a", sessionId: "session-b"))
      case "signed-out": router.accountSyncStatus.accountId = nil
      case "display-replaced": router.accountSyncStatus.accountId = "account-b"
      case "newer-request":
        let newerReply = Reply()
        router.handle(body, frame: BridgeFrame(isTrusted: true), reply: newerReply.accept)
        await settle { NativeAccountAccessRuntime.port.releases.count == 2 }
        NativeAccountAccessRuntime.port.release(0)
        await settle { reply.calls == 1 }
        guard router.entitlement.installs == 0, router.entitlement.bytes == "untouched", reply.value == nil, reply.error != nil else { fatalError("older request installed") }
        NativeAccountAccessRuntime.port.release(1)
        await settle { newerReply.calls == 1 }
        guard router.entitlement.installs == 1, newerReply.error == nil else { fatalError("current newer request refused") }
        continue
      case "revoked": router.accessRevocations.observe(NativeVerifiedAppleRevocation()); router.retryVerifiedRevocations()
      case "pending-revocation": router.accessRevocations.observe(NativeVerifiedAppleRevocation())
      case "store-generation": router.entitlement.generation += 1
      default: break
      }
      NativeAccountAccessRuntime.port.release(0)
      await settle { reply.calls == 1 }
      if scenario == "current" {
        guard router.entitlement.installs == 1, router.entitlement.bytes == "installed", reply.value != nil, reply.error == nil, router.accessSessionVerifier!.calls == 2 else { fatalError("current authenticated control failed") }
      } else {
        guard router.entitlement.installs == 0, router.entitlement.bytes == "untouched", reply.value == nil, reply.error != nil else { fatalError("stale reconciliation installed: " + scenario) }
      }
    }
    // Definitive Auth refusal of the bound account's own token ends its stored rights; anything
    // else (offline, another subject, a newer request or account) keeps them.
    for scenario in ["rejected-first", "rejected-after-fetch", "rejected-other-subject", "rejected-no-subject", "unavailable-first", "rejected-after-account-change"] {
      let router = Router(), reply = Reply()
      NativeAccountAccessRuntime.port = FetchPort()
      let verifier = router.accessSessionVerifier!
      switch scenario {
      case "rejected-first": verifier.first = .rejected(subject: "account-a")
      case "rejected-other-subject": verifier.first = .rejected(subject: "account-b")
      case "rejected-no-subject": verifier.first = .rejected(subject: nil)
      case "unavailable-first": verifier.first = .unavailable
      default: break
      }
      router.handle(body, frame: BridgeFrame(isTrusted: true), reply: reply.accept)
      if scenario == "rejected-after-fetch" || scenario == "rejected-after-account-change" {
        await settle { NativeAccountAccessRuntime.port.releases.count == 1 }
        verifier.result = .rejected(subject: "account-a")
        if scenario == "rejected-after-account-change" { router.accountSyncStatus.accountId = "account-b" }
        NativeAccountAccessRuntime.port.release(0)
      }
      await settle { reply.calls == 1 }
      let cleared = scenario == "rejected-first" || scenario == "rejected-after-fetch"
      guard reply.value == nil, reply.error != nil, router.entitlement.installs == 0,
        router.entitlement.clears == (cleared ? 1 : 0),
        router.entitlement.bytes == (cleared ? "cleared" : "untouched") else { fatalError("rejection handling: " + scenario) }
      if scenario.hasSuffix("-first") || scenario.hasSuffix("subject") {
        guard NativeAccountAccessRuntime.port.releases.isEmpty else { fatalError("refused session reached the fetch: " + scenario) }
      }
    }
    for scenario in ["dormant", "untrusted", "missing-token", "oversized-token", "extra-field", "runtime-unavailable", "no-account"] {
      let router = Router(), reply = Reply()
      NativeAccountAccessRuntime.port = FetchPort()
      MonetizationConfig.paidTierEnabled = scenario != "dormant"
      NativeAccountAccessRuntime.available = scenario != "runtime-unavailable"
      if scenario == "no-account" { router.accountSyncStatus.accountId = nil }
      var request = body
      if scenario == "missing-token" { request.removeValue(forKey: "accessToken") }
      if scenario == "oversized-token" { request["accessToken"] = String(repeating: "x", count: 16_385) }
      if scenario == "extra-field" { request["entitled"] = true }
      router.handle(request, frame: BridgeFrame(isTrusted: scenario != "untrusted"), reply: reply.accept)
      guard reply.calls == 1, reply.value == nil, reply.error != nil, router.entitlement.installs == 0,
        router.entitlement.bytes == "untouched", router.accessSessionVerifier!.calls == 0,
        NativeAccountAccessRuntime.port.releases.isEmpty else { fatalError("refused request reached authority: " + scenario) }
    }
    print("native-account-router-PASS")
  }
}
`;
  const dir = mkdtempSync(join(tmpdir(), "still-native-account-router-"));
  try {
    const file = join(dir, "main.swift"), binary = join(dir, "proof");
    writeFileSync(file, harness);
    execFileSync("swiftc", ["-parse-as-library", "-swift-version", "5", file, "-o", binary], { encoding: "utf8", timeout: 90_000 });
    expect(execFileSync(binary, [], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("native-account-router-PASS");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 100_000);
