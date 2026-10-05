import Foundation

// The per-installation invitation and rating ledger (U13-P1), mirroring
// packages/core/src/invitations exactly. Shared vectors in
// packages/core/src/invitations/__tests__/invitation-ledger-vectors.json prove the two agree.
//
// One small local record decides when Still may show an optional card: the sync invitation, the
// link invitation (Still Pro bought on Apple, not yet linked) or the rating prompt. It is never
// synced, never sent anywhere and never produces analytics. On Apple there is one shared local
// logical installation: the app and the Safari extension share one ledger in the App Group,
// through InvitationLedgerStore over an AtomicSettingsBacking with its own name.
//
// Rules that hold for every transition:
// - Counters saturate (milestones 0...3, distinct days 0...3, invitations shown 0...2).
// - The accepted local day ordinal and the clock high-water mark never decrease.
// - A clock rollback or an anchor in the future pauses eligibility; nothing is ever reset.
// - The opening that earns a trigger only makes the card due for a LATER ordinary opening.
//
// Host protocol: arbitrate, reserve (re-arbitrates inside the same locked transaction), then commit
// IMMEDIATELY BEFORE the card becomes visible; for the native rating prompt, commit before calling
// StoreKit, so a suppressed or failed system sheet still consumes the one attempt. Release only on
// a failure definitely before visibility. An uncommitted reservation is released by the next
// ordinary opening, and the generation fence stops the stale host from committing.

public enum InvitationKind: String, CaseIterable { case link, sync, rating }
public enum InvitationTriggerState: String, CaseIterable { case idle, earned, due, consumed }
public enum InvitationControl: String, CaseIterable { case site, feature, global }
public enum InvitationSuppression: String, CaseIterable { case setup, consent, error, purchase, restore, delete, link }
public enum InvitationControlSource: String, CaseIterable {
  case direct, syncApplied = "sync-applied", restore, complimentary, browserPurchase = "browser-purchase"
  case secondDevice = "second-device", cascade, read, unknown
}
public enum InvitationPurchaseSource: String, CaseIterable {
  case newApplePurchase = "new-apple-purchase", restore, complimentary, browserPurchase = "browser-purchase"
  case secondDevice = "second-device", syncApplied = "sync-applied", unknown
}

/// Fixed packaged rules. The contract forbids remote threshold or cap overrides.
public enum InvitationRules {
  /// Rating needs at least seven days of UTC elapsed age: exactly 604,800,000 ms.
  public static let ratingMinimumAgeMs = 604_800_000
  public static let ratingDistinctDays = 3
  public static let milestoneTarget = 3
  /// Sync and link invitations are at least 168 hours apart: 604,800,000 ms.
  public static let invitationSpacingMs = 604_800_000
  public static let maxInvitations = 2
}

/// Choices still open with the owner (U13 plan §6), held as explicit inputs with the plan's
/// proposed defaults so the answer changes a value, not the ledger.
public struct InvitationOwnerParameters: Equatable {
  /// Owner question 5. Proposed default false: 168 h spacing applies only between sync and link.
  public var spaceRatingFromInvitations: Bool
  /// Owner question 4. Proposed default: site and feature toggles; global pause is not counted.
  public var countedControls: [InvitationControl]
  public init(spaceRatingFromInvitations: Bool, countedControls: [InvitationControl]) {
    self.spaceRatingFromInvitations = spaceRatingFromInvitations
    self.countedControls = countedControls
  }
  public static let proposed = InvitationOwnerParameters(spaceRatingFromInvitations: false, countedControls: [.site, .feature])
}

public struct InvitationReservation: Equatable {
  public let kind: InvitationKind
  public let opening: String
  public let generation: Int
  public init(kind: InvitationKind, opening: String, generation: Int) {
    self.kind = kind
    self.opening = opening
    self.generation = generation
  }
}

public struct InvitationOpening: Equatable {
  /// Unique id for this UI opening. Only an actual ordinary Still UI opening passes `ordinary`;
  /// setup, store return, owner enable, a background foreground and unknown contexts do not.
  public var opening: String
  public var ordinary: Bool
  public var nowMs: Int
  /// Local calendar day ordinal (`InvitationDayOrdinal.local`), or nil when unreadable.
  public var localDay: Int?
  public init(opening: String, ordinary: Bool, nowMs: Int, localDay: Int?) {
    self.opening = opening
    self.ordinary = ordinary
    self.nowMs = nowMs
    self.localDay = localDay
  }
}

public struct InvitationDirectControl: Equatable {
  public enum Outcome: String { case succeeded, failed, refused }
  public var control: InvitationControl
  public var source: InvitationControlSource
  public var outcome: Outcome
  public var signedIn: Bool
  /// Owner question 4 ("readiness"). The host decides; proposed: first-run setup finished.
  public var ready: Bool
  public init(control: InvitationControl, source: InvitationControlSource, outcome: Outcome, signedIn: Bool, ready: Bool) {
    self.control = control
    self.source = source
    self.outcome = outcome
    self.signedIn = signedIn
    self.ready = ready
  }
}

public struct InvitationPurchaseEvent: Equatable {
  public var source: InvitationPurchaseSource
  public var verified: Bool
  public var unlinked: Bool
  public init(source: InvitationPurchaseSource, verified: Bool, unlinked: Bool) {
    self.source = source
    self.verified = verified
    self.unlinked = unlinked
  }
}

public struct InvitationContext: Equatable {
  public var opening: String
  public var nowMs: Int
  /// Host fact: the sync invitation applies (signed out, sync offered on this surface).
  public var syncApplicable: Bool
  /// Host fact: an Apple Still Pro purchase is still unlinked and linking is offered here.
  public var linkApplicable: Bool
  public var suppressed: InvitationSuppression?
  public init(opening: String, nowMs: Int, syncApplicable: Bool, linkApplicable: Bool, suppressed: InvitationSuppression?) {
    self.opening = opening
    self.nowMs = nowMs
    self.syncApplicable = syncApplicable
    self.linkApplicable = linkApplicable
    self.suppressed = suppressed
  }
}

public enum InvitationReason: String {
  case card, invalid, suppressed, notOrdinary = "not-ordinary", clockPaused = "clock-paused"
  case inFlight = "in-flight", sessionUsed = "session-used", none, otherKind = "other-kind"
}

public struct InvitationArbitration: Equatable {
  public let kind: InvitationKind?
  public let reason: InvitationReason
}

public enum InvitationReserveResult: Equatable {
  case reserved(InvitationLedger, InvitationReservation)
  case refused(InvitationReason)
}

public struct InvitationLedger: Equatable {
  public let installation: String
  public var anchorMs: Int?
  public var highWaterMs: Int
  public var dayOrdinal: Int?
  public var distinctDays: Int
  public var milestones: Int
  public var shown: Int
  public var lastInvitationAt: Int?
  public var lastRatingAt: Int?
  public var lastOpening: String?
  public var lastCardOpening: String?
  public var generation: Int
  public var sync: InvitationTriggerState
  public var link: InvitationTriggerState
  public var rating: InvitationTriggerState
  public var reservation: InvitationReservation?

  static let keys: Set<String> = [
    "schema", "installation", "anchorMs", "highWaterMs", "dayOrdinal", "distinctDays", "milestones", "shown",
    "lastInvitationAt", "lastRatingAt", "lastOpening", "lastCardOpening", "generation", "sync", "link", "rating", "reservation",
  ]

  /// A fresh ledger. `anchorMs` is the known local first-run time, or nil when it is unknown.
  public static func create(installation: String, anchorMs: Int?) -> InvitationLedger? {
    guard validId(installation), anchorMs.map({ $0 >= 0 && $0 <= maxSafe }) ?? true else { return nil }
    return InvitationLedger(installation: installation, anchorMs: anchorMs, highWaterMs: 0, dayOrdinal: nil, distinctDays: 0,
                            milestones: 0, shown: 0, lastInvitationAt: nil, lastRatingAt: nil, lastOpening: nil,
                            lastCardOpening: nil, generation: 0, sync: .idle, link: .idle, rating: .idle, reservation: nil)
  }

  // MARK: Strict stored form (identical JSON to the TS ledger)

  /// Strict parse of a stored ledger object. Anything else is unreadable: pause, never reset.
  public static func parse(_ value: Any?) -> InvitationLedger? {
    guard let raw = value as? [String: Any], Set(raw.keys) == keys, count(raw["schema"]) == 1,
          let installation = raw["installation"] as? String, validId(installation),
          let anchor = optionalCount(raw["anchorMs"]), let highWater = count(raw["highWaterMs"]),
          let day = optionalCount(raw["dayOrdinal"]),
          let days = count(raw["distinctDays"], max: InvitationRules.ratingDistinctDays),
          let milestones = count(raw["milestones"], max: InvitationRules.milestoneTarget),
          let shown = count(raw["shown"], max: InvitationRules.maxInvitations),
          let lastInvitation = optionalCount(raw["lastInvitationAt"]), let lastRating = optionalCount(raw["lastRatingAt"]),
          let lastOpening = optionalId(raw["lastOpening"]), let lastCard = optionalId(raw["lastCardOpening"]),
          let generation = count(raw["generation"]),
          let sync = (raw["sync"] as? String).flatMap(InvitationTriggerState.init(rawValue:)),
          let link = (raw["link"] as? String).flatMap(InvitationTriggerState.init(rawValue:)),
          let rating = (raw["rating"] as? String).flatMap(InvitationTriggerState.init(rawValue:)) else { return nil }
    var reservation: InvitationReservation?
    if !(raw["reservation"] is NSNull) {
      guard let r = raw["reservation"] as? [String: Any], Set(r.keys) == ["kind", "opening", "generation"],
            let kind = (r["kind"] as? String).flatMap(InvitationKind.init(rawValue:)),
            let opening = r["opening"] as? String, validId(opening),
            let g = count(r["generation"]), g <= generation else { return nil }
      reservation = InvitationReservation(kind: kind, opening: opening, generation: g)
    }
    return InvitationLedger(installation: installation, anchorMs: anchor, highWaterMs: highWater, dayOrdinal: day,
                            distinctDays: days, milestones: milestones, shown: shown, lastInvitationAt: lastInvitation,
                            lastRatingAt: lastRating, lastOpening: lastOpening, lastCardOpening: lastCard,
                            generation: generation, sync: sync, link: link, rating: rating, reservation: reservation)
  }

  public static func decode(_ data: Data) -> InvitationLedger? {
    parse(try? JSONSerialization.jsonObject(with: data))
  }

  public var jsonObject: [String: Any] {
    func n(_ v: Int?) -> Any { v.map { $0 as Any } ?? NSNull() }
    func s(_ v: String?) -> Any { v.map { $0 as Any } ?? NSNull() }
    let r: Any = reservation.map { ["kind": $0.kind.rawValue, "opening": $0.opening, "generation": $0.generation] as [String: Any] } ?? NSNull()
    return [
      "schema": 1, "installation": installation, "anchorMs": n(anchorMs), "highWaterMs": highWaterMs, "dayOrdinal": n(dayOrdinal),
      "distinctDays": distinctDays, "milestones": milestones, "shown": shown, "lastInvitationAt": n(lastInvitationAt),
      "lastRatingAt": n(lastRatingAt), "lastOpening": s(lastOpening), "lastCardOpening": s(lastCardOpening),
      "generation": generation, "sync": sync.rawValue, "link": link.rawValue, "rating": rating.rawValue, "reservation": r,
    ]
  }

  public func encoded() throws -> Data {
    try JSONSerialization.data(withJSONObject: jsonObject, options: [.sortedKeys])
  }

  // MARK: Recording

  /// Fill an unknown anchor once. A known anchor is never replaced, so nothing resets eligibility.
  public func adoptingAnchor(_ anchorMs: Int) -> InvitationLedger {
    guard self.anchorMs == nil, anchorMs >= 0, anchorMs <= Self.maxSafe else { return self }
    var next = self
    next.anchorMs = anchorMs
    return next
  }

  /// Record an ordinary opening: promote earned triggers, reclaim an abandoned reservation, count a day.
  public func recordingOpening(_ input: InvitationOpening) -> InvitationLedger {
    guard input.ordinary, Self.validId(input.opening), Self.validNow(input.nowMs), input.opening != lastOpening else { return self }
    var next = self
    next.lastOpening = input.opening
    next.highWaterMs = max(highWaterMs, input.nowMs)
    next.sync = Self.promote(sync)
    next.link = Self.promote(link)
    next.rating = Self.promote(rating)
    // A reservation left by another opening was never committed, so its card was never visible.
    if let r = next.reservation, r.opening != input.opening {
      next.reservation = nil
      next.generation += 1
    }
    if let day = input.localDay, day >= 0, day <= Self.maxSafe, next.dayOrdinal.map({ day > $0 }) ?? true {
      next.distinctDays = min(InvitationRules.ratingDistinctDays, next.distinctDays + 1)
      next.dayOrdinal = day
      if next.distinctDays == InvitationRules.ratingDistinctDays && next.rating == .idle { next.rating = .earned }
    }
    return next
  }

  /// Count one successful direct control made while signed out after readiness (saturating).
  public func recordingDirectControl(_ input: InvitationDirectControl, parameters: InvitationOwnerParameters = .proposed) -> InvitationLedger {
    guard input.source == .direct, input.outcome == .succeeded, !input.signedIn, input.ready,
          parameters.countedControls.contains(input.control) else { return self }
    var next = self
    next.milestones = min(InvitationRules.milestoneTarget, milestones + 1)
    if next.milestones == InvitationRules.milestoneTarget && sync == .idle { next.sync = .earned }
    return next
  }

  /// Only an actual new, verified, unlinked Apple purchase earns the link invitation.
  public func recordingPurchase(_ input: InvitationPurchaseEvent) -> InvitationLedger {
    guard input.source == .newApplePurchase, input.verified, input.unlinked, link == .idle else { return self }
    var next = self
    next.link = .earned
    return next
  }

  // MARK: Arbiter (precedence link, sync, rating; at most one card per opening)

  public func arbitrate(_ context: InvitationContext, parameters: InvitationOwnerParameters = .proposed) -> InvitationArbitration {
    func none(_ reason: InvitationReason) -> InvitationArbitration { InvitationArbitration(kind: nil, reason: reason) }
    guard Self.validId(context.opening), Self.validNow(context.nowMs) else { return none(.invalid) }
    if context.suppressed != nil { return none(.suppressed) }
    if context.opening != lastOpening { return none(.notOrdinary) }
    if context.nowMs < highWaterMs { return none(.clockPaused) }
    if reservation != nil { return none(.inFlight) }
    if lastCardOpening == context.opening { return none(.sessionUsed) }
    let now = context.nowMs
    if link == .due && context.linkApplicable && invitationAllowed(now, parameters) { return InvitationArbitration(kind: .link, reason: .card) }
    if sync == .due && context.syncApplicable && invitationAllowed(now, parameters) { return InvitationArbitration(kind: .sync, reason: .card) }
    if ratingAllowed(now, parameters) { return InvitationArbitration(kind: .rating, reason: .card) }
    return none(.none)
  }

  /// Reserve the card before rendering it. Re-arbitrates, so a competing host or changed state wins.
  public func reserving(_ kind: InvitationKind, _ context: InvitationContext, parameters: InvitationOwnerParameters = .proposed) -> InvitationReserveResult {
    let decision = arbitrate(context, parameters: parameters)
    guard let decided = decision.kind else { return .refused(decision.reason) }
    guard decided == kind else { return .refused(.otherKind) }
    var next = self
    next.generation += 1
    let reservation = InvitationReservation(kind: kind, opening: context.opening, generation: next.generation)
    next.reservation = reservation
    next.highWaterMs = max(highWaterMs, context.nowMs)
    return .reserved(next, reservation)
  }

  /// Consume the reserved card. Call immediately before it becomes visible (native rating: before
  /// StoreKit). Nil means do not show.
  public func committing(_ r: InvitationReservation, nowMs: Int) -> InvitationLedger? {
    guard matches(r), Self.validNow(nowMs) else { return nil }
    // Never shorten spacing after a clock rollback: stamp at least the high-water mark.
    let at = max(nowMs, highWaterMs)
    var next = self
    next.reservation = nil
    next.generation += 1
    next.lastCardOpening = r.opening
    next.highWaterMs = at
    switch r.kind {
    case .rating:
      next.rating = .consumed
      next.lastRatingAt = at
    case .sync, .link:
      if r.kind == .sync { next.sync = .consumed } else { next.link = .consumed }
      next.lastInvitationAt = at
      next.shown = min(InvitationRules.maxInvitations, shown + 1)
    }
    return next
  }

  /// Return a reserved card to due after a failure definitely before visibility.
  public func releasing(_ r: InvitationReservation) -> InvitationLedger? {
    guard matches(r) else { return nil }
    var next = self
    next.reservation = nil
    next.generation += 1
    return next
  }

  // MARK: Helpers

  private func matches(_ r: InvitationReservation) -> Bool {
    reservation == r && generation == r.generation
  }
  private func invitationAllowed(_ now: Int, _ p: InvitationOwnerParameters) -> Bool {
    shown < InvitationRules.maxInvitations && Self.elapsed(now, lastInvitationAt, InvitationRules.invitationSpacingMs) &&
      (!p.spaceRatingFromInvitations || Self.elapsed(now, lastRatingAt, InvitationRules.invitationSpacingMs))
  }
  /// Due (a later opening than the one that earned day three), a known anchor not in the future,
  /// and at least 604,800,000 ms of elapsed age.
  private func ratingAllowed(_ now: Int, _ p: InvitationOwnerParameters) -> Bool {
    guard rating == .due, distinctDays >= InvitationRules.ratingDistinctDays, let anchor = anchorMs, anchor <= now,
          now - anchor >= InvitationRules.ratingMinimumAgeMs else { return false }
    return !p.spaceRatingFromInvitations || Self.elapsed(now, lastInvitationAt, InvitationRules.invitationSpacingMs)
  }
  private static func elapsed(_ now: Int, _ since: Int?, _ span: Int) -> Bool { since.map { now - $0 >= span } ?? true }
  private static func promote(_ s: InvitationTriggerState) -> InvitationTriggerState { s == .earned ? .due : s }
  static let maxSafe = 9_007_199_254_740_991
  static func validNow(_ v: Int) -> Bool { v >= 0 && v <= maxSafe }
  /// 1...128 UTF-16 units with no surrounding whitespace, matching the TS `validInvitationId`.
  public static func validId(_ v: String) -> Bool {
    (1...128).contains(v.utf16.count) && v.trimmingCharacters(in: .whitespacesAndNewlines) == v
  }
  private static func count(_ v: Any?, max: Int = maxSafe) -> Int? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue
    guard d.isFinite, d.rounded() == d, d >= 0, d <= Double(max) else { return nil }
    return n.intValue
  }
  /// Outer nil: invalid. Inner nil: an explicit JSON null.
  private static func optionalCount(_ v: Any?) -> Int?? {
    if v is NSNull { return .some(nil) }
    guard let c = count(v) else { return nil }
    return .some(c)
  }
  private static func optionalId(_ v: Any?) -> String?? {
    if v is NSNull { return .some(nil) }
    guard let s = v as? String, validId(s) else { return nil }
    return .some(s)
  }
}

/// Local calendar day ordinals: days from 1970-01-01 to a local date. Only the date matters, so
/// daylight-saving changes never split or merge a day of use.
public enum InvitationDayOrdinal {
  private static func floorDiv(_ a: Int, _ b: Int) -> Int { a >= 0 ? a / b : -((-a + b - 1) / b) }

  /// Days from 1970-01-01 to the given civil date (month 1-12). Pure arithmetic, no time zone.
  public static func civil(year: Int, month: Int, day: Int) -> Int {
    let y = month <= 2 ? year - 1 : year
    let era = floorDiv(y, 400)
    let yoe = y - era * 400
    let mp = (month + 9) % 12
    let doy = (153 * mp + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  /// The local day ordinal of an instant, or nil when unreadable (negative instant or a date
  /// before 1970). A nil ordinal contributes no day and never resets one.
  public static func local(epochMs: Int, timeZone: TimeZone = .current) -> Int? {
    guard epochMs >= 0 else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let c = calendar.dateComponents([.era, .year, .month, .day], from: Date(timeIntervalSince1970: Double(epochMs) / 1000))
    guard c.era == 1, let y = c.year, let m = c.month, let d = c.day else { return nil }
    let ordinal = civil(year: y, month: m, day: d)
    return ordinal >= 0 ? ordinal : nil
  }
}

/// Storage port for the ledger. Ports only: no host wiring (U13-P2/P3 bind it). Production hosts
/// pass the App Group atomic store with its own record name, for example
/// `AtomicSettingsBacking(directory: <App Group container>, name: "still-invitations")`, so the
/// app and the Safari extension serialize through one cross-process lock. Never a synced store.
///
/// An absent record is created only by `ensure`. An unreadable record is never overwritten:
/// every operation reports it, shows no card and writes nothing. A failed lock is `unavailable`.
public final class InvitationLedgerStore {
  public enum Status: String { case ready, absent, unreadable, unavailable }
  private let backing: SettingsBacking
  private let parameters: InvitationOwnerParameters

  public init(backing: SettingsBacking, parameters: InvitationOwnerParameters = .proposed) {
    self.backing = backing
    self.parameters = parameters
  }

  private func run<T>(_ fallback: (Status) -> T, _ body: (InvitationLedger) -> (write: InvitationLedger?, result: T)) -> T {
    do {
      return try backing.transaction { data -> T in
        guard let bytes = data else { return fallback(.absent) }
        guard let ledger = InvitationLedger.decode(bytes) else { return fallback(.unreadable) }
        let (write, result) = body(ledger)
        if let write { data = try write.encoded() }
        return result
      }
    } catch {
      return fallback(.unavailable)
    }
  }
  private func update(_ change: (InvitationLedger) -> InvitationLedger) -> Status {
    run({ $0 }) { ledger in
      let next = change(ledger)
      return (next == ledger ? nil : next, .ready)
    }
  }

  /// Create the ledger once for this installation; an existing or unreadable one is kept as is.
  @discardableResult
  public func ensure(installation: String, anchorMs: Int?) -> Status {
    do {
      return try backing.transaction { data -> Status in
        if let bytes = data { return InvitationLedger.decode(bytes) == nil ? .unreadable : .ready }
        guard let created = InvitationLedger.create(installation: installation, anchorMs: anchorMs) else { return .absent }
        data = try created.encoded()
        return .ready
      }
    } catch {
      return .unavailable
    }
  }
  @discardableResult public func adoptAnchor(_ anchorMs: Int) -> Status { update { $0.adoptingAnchor(anchorMs) } }
  @discardableResult public func recordOpening(_ input: InvitationOpening) -> Status { update { $0.recordingOpening(input) } }
  @discardableResult public func recordDirectControl(_ input: InvitationDirectControl) -> Status {
    update { $0.recordingDirectControl(input, parameters: parameters) }
  }
  @discardableResult public func recordPurchase(_ input: InvitationPurchaseEvent) -> Status { update { $0.recordingPurchase(input) } }

  /// Read-only decision for this opening. An absent, unreadable or unavailable ledger offers nothing.
  public func arbitrate(_ context: InvitationContext) -> InvitationArbitration {
    run({ _ in InvitationArbitration(kind: nil, reason: .none) }) { (nil, $0.arbitrate(context, parameters: parameters)) }
  }
  /// Reserve before rendering. Nil means another host, a state change or a suppression won.
  public func reserve(_ kind: InvitationKind, _ context: InvitationContext) -> InvitationReservation? {
    run({ _ in nil }) { ledger in
      switch ledger.reserving(kind, context, parameters: parameters) {
      case let .reserved(next, reservation): return (next, reservation)
      case .refused: return (nil, nil)
      }
    }
  }
  /// Consume immediately before visibility (native rating: before StoreKit). False: do not show.
  public func commit(_ reservation: InvitationReservation, nowMs: Int) -> Bool {
    run({ _ in false }) { ledger in
      let next = ledger.committing(reservation, nowMs: nowMs)
      return (next, next != nil)
    }
  }
  /// Release only after a failure definitely before visibility.
  public func release(_ reservation: InvitationReservation) -> Bool {
    run({ _ in false }) { ledger in
      let next = ledger.releasing(reservation)
      return (next, next != nil)
    }
  }
}
