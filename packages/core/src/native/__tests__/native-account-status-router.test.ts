import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const stillKit = join(root, "apps/apple/StillKit/Sources/StillKit");

/** ISS-0030 at the router seam. Compiles the maintained `setAccountSyncStatus` and `signOut` arms
 * of WebBridgeRouter.swift together with the real StillKit sources (account-status store,
 * entitlement store and bridges, frame trust), then reads the Safari extension's benefit snapshot
 * through `EntitlementBridge.safariExtension`. The app's StoreKit answer is recorded through the
 * same StillKit call its `getBenefitAccess` arm makes. Only the RevenueCat reset is stubbed. */
it.runIf(process.platform === "darwin")("the router's real signed-out status write lets Safari lock Still Pro with a fresh App Store none", () => {
  const source = readFileSync(join(root, "apps/apple/Still/Shared (App)/WebBridgeRouter.swift"), "utf8");
  const arm = (from: string, to: string) => {
    const start = source.indexOf(`    case "${from}":`);
    const end = source.indexOf(`    case "${to}":`, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };
  const harness = `import Foundation
@MainActor final class Purchases { var resets = 0; func reset() async { resets += 1 } }
@MainActor final class Router {
  let entitlement: EntitlementBridge
  let accountSyncStatus: AccountSyncStatusStore
  let purchases = Purchases()
  var accessAccountLineage = 0
  init(store: SharedEntitlementStore, status: AccountSyncStatusStore) {
    entitlement = EntitlementBridge(store: store, now: { 1_800_000_000_000 })
    accountSyncStatus = status
  }
  func handle(_ body: Any, frame: BridgeFrame, reply: @escaping (Any?, String?) -> Void) {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else { reply(nil, "malformed"); return }
    switch kind {
${arm("signOut", "analyticsContext")}
${arm("setAccountSyncStatus", "getBenefitAccess")}
    default: reply(nil, "unsupported")
    }
  }
  private static func json(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let string = String(data: data, encoding: .utf8) else { return "{}" }
    return string
  }
}
@MainActor final class Reply {
  var calls = 0, error: String?
  func accept(_ value: Any?, _ error: String?) { calls += 1; self.error = error }
}
let bundled = URL(fileURLWithPath: "/synthetic/Still.app/web/index.html")
let trusted = BridgeFrame(isMainFrame: true, url: bundled, bundledURL: bundled)
let untrusted = BridgeFrame(isMainFrame: true, url: URL(string: "https://example.invalid/"), bundledURL: bundled)
let now = 1_800_000_000_000
let account: [String: Any] = ["accountId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "email": NSNull(), "lastSyncedAt": NSNull(),
  "pendingUpload": false, "cloudReachable": true, "updatedAt": 1]
func check(_ ok: Bool, _ message: String) { if !ok { fatalError(message) } }
/// One App Group: the app's router and the Safari extension share both stores.
struct Shared {
  let store = SharedEntitlementStore(backing: InMemoryBacking())
  let status = AccountSyncStatusStore(backing: InMemoryBacking())
  /// The app's getBenefitAccess arm: its fresh StoreKit answer, recorded for Safari (paid build).
  func appObserves(_ ownership: NativeAppleOwnershipObservation) throws {
    _ = try store.observeAppleBenefits(wall: now, ownership: ownership, paidMode: true, platform: .mac)
  }
  func safariProRows(_ platform: SafariAccessPlatform) throws -> Set<String> {
    let reply = EntitlementBridge.safariExtension(store: store, paidMode: true, platform: platform, now: { now + 1 },
      displayedAccount: { status.displayedAccount() }).handle(.getBenefitAccess)
    guard let body = try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any], body["ok"] as? Bool == true,
      let states = (body["snapshot"] as? [String: Any])?["states"] as? [String: String] else { fatalError("Safari read failed: " + reply) }
    let rows = NativeAppleAccessCapabilities.pro(for: platform)
    check(rows.count == (platform == .mac ? 12 : 9), "Pro row count")
    return Set(rows.map { states[$0] ?? "missing" })
  }
}
@main struct Run {
  @MainActor static func send(_ router: Router, _ body: [String: Any], frame: BridgeFrame = trusted) async -> Reply {
    let reply = Reply()
    router.handle(body, frame: frame, reply: reply.accept)
    for _ in 0..<1000 { if reply.calls == 1 { return reply }; await Task.yield() }
    fatalError("router did not reply")
  }
  @MainActor static func main() async throws {
    let signedOut: [String: Any] = ["kind": "setAccountSyncStatus", "status": NSNull()]
    let signedIn: [String: Any] = ["kind": "setAccountSyncStatus", "status": account]

    // A launch without an account publishes null; with a fresh App Store none, Safari locks.
    do {
      let s = Shared(), router = Router(store: s.store, status: s.status)
      check(await send(router, signedOut).error == nil, "null status refused")
      check(try s.safariProRows(.mac) == ["verification_required"], "no app answer yet must not lock")
      try s.appObserves(.unknown)
      check(try s.safariProRows(.mac) == ["verification_required"], "an inconclusive StoreKit answer must not lock")
      try s.appObserves(.noPurchases)
      check(try s.safariProRows(.mac) == ["locked"], "Mac Safari did not lock after the router's null status")
      check(try s.safariProRows(.mobile) == ["locked"], "iPhone Safari did not lock after the router's null status")
    }
    // A session that ends publishes null over the account; the router clears the bound account.
    do {
      let s = Shared(), router = Router(store: s.store, status: s.status)
      try s.appObserves(.noPurchases)
      check(await send(router, signedIn).error == nil, "account status refused")
      // The app's first account check binds the verified session (no server answer yet).
      _ = try s.store.changeAccessSession(accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
      check(try s.safariProRows(.mac) == ["verification_required"], "a signed-in account without its own answer must not lock")
      check(await send(router, signedOut).error == nil, "null status refused")
      check(try s.store.observeAccess(wall: now).0.accountId == nil, "router left the account bound")
      check(try s.safariProRows(.mac) == ["locked"], "Safari did not lock after the session ended")
    }
    // The router's signOut arm (clears the bound account, then the displayed status).
    do {
      let s = Shared(), router = Router(store: s.store, status: s.status)
      try s.appObserves(.noPurchases)
      check(await send(router, signedIn).error == nil, "account status refused")
      check(await send(router, ["kind": "signOut"]).error == nil, "signOut failed")
      check(router.purchases.resets == 1, "signOut did not reset purchases")
      check(try s.safariProRows(.mac) == ["locked"], "Safari did not lock after signOut")
    }
    // An untrusted frame cannot write the status.
    do {
      let s = Shared(), router = Router(store: s.store, status: s.status)
      try s.appObserves(.noPurchases)
      check(await send(router, signedIn).error == nil, "account status refused")
      check(await send(router, signedOut, frame: untrusted).error != nil, "untrusted null status accepted")
      check(s.status.displayedAccount() == .account("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "untrusted write changed the status")
      check(try s.safariProRows(.mac) == ["verification_required"], "an untrusted write must not lock")
    }
    print("native-account-status-router-PASS")
  }
}
`;
  const dir = mkdtempSync(join(tmpdir(), "still-native-account-status-router-"));
  try {
    const file = join(dir, "main.swift"), binary = join(dir, "proof");
    writeFileSync(file, harness);
    const kit = readdirSync(stillKit).filter(name => name.endsWith(".swift")).map(name => join(stillKit, name));
    execFileSync("swiftc", ["-parse-as-library", "-swift-version", "5", "-module-name", "StillKit", ...kit, file, "-o", binary], { encoding: "utf8", timeout: 240_000 });
    expect(execFileSync(binary, [], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("native-account-status-router-PASS");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);
