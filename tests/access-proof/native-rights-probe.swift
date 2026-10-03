// Standalone synthetic two-process probe linked to the actual built StillKit objects.
// Inputs are the public synthetic vector fixture and a disposable directory, never provider data.
import Foundation
import StillKit

@main struct NativeRightsProbe {
  static func main() throws {
    guard CommandLine.arguments.count == 4 else { throw AccessProofFailure.invalid }
    let directory = URL(fileURLWithPath: CommandLine.arguments[1])
    let fixture = URL(fileURLWithPath: CommandLine.arguments[2])
    let mode = CommandLine.arguments[3]
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as! [String: Any]
    let hex = json["publicKeyHex"] as! String
    let key = Data(stride(from: 0, to: hex.count, by: 2).map { offset -> UInt8 in
      let start = hex.index(hex.startIndex, offsetBy: offset)
      return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
    })
    let trust = AccessTrust(environment: "sandbox", keys: [.init(kid: "synthetic-access", publicKey: key, environment: "sandbox")],
      protectedProduct: json["protectedProduct"] as? String, protectedBenefits: json["protectedBenefits"] as! [String])
    let store = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement"), trust: trust)
    let vectors = json["vectors"] as! [[String: String]]
    func proof(_ name: String) throws -> VerifiedAccessProof {
      try VerifiedAccessProof.verify(vectors.first { $0["name"] == name }!["envelope"]!, trust: trust)
    }
    let verifiedAt = json["verifiedAt"] as! Int, expiry = json["expiresAt"] as! Int
    let localRight = json["localRight"] as! String
    switch mode {
    case "seed":
      let scope = try store.changeAccessAccount(json["account"] as? String)
      _ = try store.installAccess(proof("paid-account"), generation: scope.generation, issuerNow: verifiedAt, wall: 1000, localRights: [])
      _ = try store.installAccess(proof("protected-local"), generation: scope.generation, issuerNow: verifiedAt, wall: 1000, localRights: [localRight])
    case "expire":
      _ = try store.observeAccess(wall: 1000 + expiry - verifiedAt)
    case "stale":
      for _ in 0..<50 {
        _ = try store.observeAccess(wall: 1000)
        store.save(EntitlementRecord(entitled: true, updatedAt: 1000, source: .server))
      }
    case "revoke":
      let paid = try proof("paid-account")
      for _ in 0..<50 { _ = try store.revokeAccess(right: paid.claims.right, revision: 1, generation: 1) }
    case "check":
      let result = try store.observeAccess(wall: 1000)
      let paid = result.0.rights.first { $0.clock != nil }!
      guard paid.clock!.highWater == expiry, paid.clock!.expired, paid.clock!.revoked,
        result.0.revocations.count == 1,
        resolveBenefitAccess("youtube.comments", evidence: result.1, paidMode: true, supported: true, free: false,
          accountId: nil, localRights: [localRight], evidenceStatus: "unknown") == .protected else { throw AccessProofFailure.invalid }
      print("{\"high_water_preserved\":true,\"expiry_preserved\":true,\"revocation_preserved\":true,\"independent_protection\":true}")
    default: throw AccessProofFailure.invalid
    }
  }
}
