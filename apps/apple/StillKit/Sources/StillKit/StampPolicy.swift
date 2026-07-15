import Foundation

/// The result of proposing a stamp write: persist `write`'s record, or do nothing.
public enum StampDecision: Equatable, Sendable {
  case write(EntitlementRecord)
  case drop
}

/// The single never-downgrade enforcement home for the App Group entitlement stamp (R13,
/// ADR 0003). Every write — the webview's server mirror, sign-out teardown proposals, and the
/// native launch/foreground receipt restamp — routes through `decide` via `EntitlementBridge`.
///
/// "One home" applies to the App Group stamp specifically: the Safari extension's 30-day TTL and
/// install-generation purge remain deliberate, separate downgrade authorities on its DERIVED
/// browser.storage copy. Do not consolidate those here — the TTL bounds offline staleness by
/// design.
///
/// The matrix (proposal lane × live receipt × current stamp lane):
/// - `true` proposals always write (either authority may grant or refresh Pro; equal-value
///   writes refresh `updatedAt`, which the extension's TTL keys off).
/// - `false` with receipt `entitled` is blocked AND converted to a receipt-true restamp — the
///   device provably owns Pro, so the downgrade is wrong and the stamp gets fresher instead.
/// - `false` with receipt `verifiedNotEntitled`: the server lane may downgrade anything; the
///   receipt lane may downgrade only receipt-source stamps (a refunded Apple purchase must never
///   clobber web-granted server Pro).
/// - `false` with receipt `noSignal`: only a server-lane proposal over a server-source (or
///   absent) stamp writes — account-derived Pro leaves with the account (the ratified
///   shared-machine sign-out invariant), while ambiguity never downgrades receipt-proven Pro.
public enum StampPolicy {
  public static func decide(
    proposed: EntitlementRecord,
    receipt: ReceiptStatus,
    current: EntitlementRecord?
  ) -> StampDecision {
    if proposed.entitled { return .write(proposed) }

    switch receipt {
    case .entitled:
      // Block the downgrade and refresh the stamp from the stronger authority.
      return .write(
        EntitlementRecord(entitled: true, updatedAt: proposed.updatedAt, source: .receipt))
    case .verifiedNotEntitled:
      if proposed.source == .server { return .write(proposed) }
      // Receipt lane owns only receipt-source stamps; an absent stamp is safe to write.
      return (current?.source ?? .receipt) == .receipt ? .write(proposed) : .drop
    case .noSignal:
      guard proposed.source == .server else { return .drop }
      return (current?.source ?? .server) == .server ? .write(proposed) : .drop
    }
  }
}
