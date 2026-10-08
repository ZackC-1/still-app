//
//  WebBridgeRouter.swift
//  Shared (App)
//
//  Routes the WKWebView `still` messages to the right native subsystem and replies with a JSON string
//  the web side parses. Two generations of messages share the one handler:
//
//    • U17 settings (unchanged reply shape — a StillSettings JSON string):
//        { kind:"get" }                       → "<settings json>" | ""
//        { kind:"set", settings:"<json>" }    → "<resolved settings json>"
//
//    • Safari setup (read-only; SafariSetupObservation.swift is the contract):
//        { kind:"safariSetupState" }          → { ok:true, platform:"ios", extensionStatus:"unknown",
//                                               enableLocation:"settingsAppStillPage" }
//                                             | { ok:true, platform:"macos",
//                                               extensionStatus:"enabled"|"disabled"|"unknown",
//                                               enableLocation:"safariExtensionSettings" }
//      Opens nothing and writes nothing. iOS is always "unknown" (a containing app cannot read the
//      extension's state on the iPhone versions this build targets), so only a macOS "enabled" is a
//      positive signal. Callers bound the read with a deadline and treat a timeout, a malformed reply
//      or "unknown" as not confirmed.
//
//    • Onboarding (the one OnboardingGate; OnboardingGatePresenter.swift is the contract):
//        { kind:"onboardingState" }           → { ok:true, shouldShow:Bool, platform:"ios"|"macos",
//                                               osMajorVersion:Int }
//        { kind:"completeOnboarding" }        → { ok:true }  | error "still: onboarding not presented
//                                                                 by the web view"
//      `shouldShow` is true only when the Info.plist presenter flag selects the web flow AND the gate
//      is not complete; with the shipped (absent) flag the SwiftUI OnboardingPresenter owns the gate,
//      `shouldShow` is always false and completion is refused, so the two flows can never both show.
//      platform/osMajorVersion are host facts for choosing the approved setup steps. The Info.plist
//      "web" flag takes effect only when the bundled web UI contains the D12 onboarding; a legacy
//      web build keeps SwiftUI (OnboardingGate.presenter(fromInfoValue:webUIIndexHTML:)).
//
//    • Open a fixed destination (NativeOpenDestination.swift is the contract):
//        { kind:"openDestination", destination:"safariExtensionSettings"|"settingsAppStillPage"|"safari" }
//                                             → { ok:true, destination } | error "still: open refused
//                                               (<reason>)" | error "still: open failed"
//      Exactly those two keys; no URL ever comes from the page. Native re-checks the bundled main
//      frame, accepts only a destination this platform supports (macOS: Safari's Extensions settings
//      and Safari; iOS: Still's page in the Settings app) and only while the app is active.
//
//    • U19 auth + purchase (reply a small JSON object; purchase-first — plan 2026-07-15-001):
//        { kind:"signInWithApple" }           → { identityToken, nonce, email?, fullName? } | { error }
//        { kind:"configurePurchases", appUserID } → { ok:true }   (KTD5 — RC re-keyed to the Supabase UUID)
//        { kind:"purchase" }                  → { outcome, entitled }   (works signed out — R1)
//        { kind:"restore" }                   → { entitled }            (works signed out — R4)
//      purchase is refused while MonetizationConfig.paidTierEnabled is false: it replies
//      "unavailable" without reaching StoreKit. restore then runs the free-period check instead
//      (FreePeriodRestore.swift): read-only StoreKit 2, never RevenueCat, and it replies
//        { entitled, restore: "restored"|"none"|"failed" }
//      "none" only after a successful App Store sync verified no purchase; any sync error, cancel
//      or timeout is "failed".
//        { kind:"purchaseStatus" }            → { entitled }
//        { kind:"receiptStatus" }             → { receipt: "entitled"|"verifiedNotEntitled"|"noSignal" }
//        { kind:"attachPurchases" }           → { entitled }   (R7 — attach the receipt to the account)
//        { kind:"price" }                     → { price } | {}   (localized store price for the CTA)
//        { kind:"signOut" }                   → { ok:true }   (reset RC identity on sign-out)
//
//    • Rating hold (U13-P3; RatingHold in StillKit is the contract):
//        { kind:"ratingHold", flow:"none"|"setup"|"signIn"|"consent"|"restore"|"purchase"|"delete"|"error" }
//                                             → { ok:Bool }  (false: unknown value, recorded as "error")
//      The web UI's current flow, kept in memory for this launch only. Until it is first reported,
//      and while Restore, purchase, attaching purchases or Sign in with Apple run here, Apple's
//      rating sheet is held.
//
//    • Entitlement mirror (reply the envelope JSON string — EntitlementBridge.swift is the contract):
//        { kind:"setEntitlement", entitled }  → {"entitled":Bool|null,"installId":String|null,
//                                               "source":String|null,"updatedAt":Int|null}
//        { kind:"getEntitlement" }            → same envelope; all four keys always present,
//                                               explicit null when absent (the legacy "" reply is gone)
//      The web SyncService mirrors its server-reconciled entitlement here after every state change
//      (a server-lane PROPOSAL — EntitlementBridge routes every write through StampPolicy, R13);
//      the native receipt lane restamps via applyReceipt around purchase/restore/receiptStatus.
//      The Safari extension pulls the stamp from the App Group so paid blocking activates there.
//
//    • Product analytics (AnalyticsIdentity.swift is the contract; the web layer sends events):
//        { kind:"analyticsContext" }          → { platform, appVersion, installId, anchorId, created,
//                                               returning, previousVersion|null, consent,
//                                               consentAnswered, noticeSeen,
//                                               extensionEnabled: Bool|null }
//        { kind:"setAnalyticsConsent", enabled } → { ok:true, enabled, answered }
//      `consent` reads on until a choice is written, so `consentAnswered` / `answered` say whether
//      it is an explicit choice; only an answered value may be shown as a saved choice. Concurrent
//      first-launch analyticsContext reads share one computation (LaunchValue).
//        { kind:"acknowledgeAnalyticsNotice" } → { ok:true }
//      Consent lives in the App Group so the Safari extension follows the app's switch.
//
//  The web layer drives sign-in: the web client signs in via email code, then hands the resulting
//  UUID back via `configurePurchases` so RevenueCat is keyed to the same account the webhook (U14)
//  projects the entitlement onto. Purchase no longer requires a session (Guideline 5.1.1(v)).
//

import WebKit
import StoreKit
import StillKit

/// Process-local install fence. Known cryptographic revocation advances it even before a
/// binding exists; a failed durable commit blocks modern replies until that verified removal retries.
struct AppleAccessRevocationFence {
  private struct RevocationKey: Hashable {
    let environment: String, appBundleId: String, productId: String, originalTransactionId: String
    let purchased: Bool
    let revokedAt: Int
    init(_ revocation: NativeVerifiedAppleRevocation) {
      let identity = revocation.identity
      environment = identity.environment; appBundleId = identity.appBundleId
      productId = identity.productId; originalTransactionId = identity.originalTransactionId
      purchased = identity.ownership == .purchased; revokedAt = revocation.revokedAt
    }
  }
  private(set) var generation = 0
  private var pending: [NativeVerifiedAppleRevocation] = []
  // Successful no-binding commits are also settled. The install oracle still re-verifies its
  // own transaction; repeated historical refunds must not invalidate unrelated current reads.
  private var committed: Set<RevocationKey> = []
  var ready: Bool { pending.isEmpty }
  func permitsInstall(_ captured: Int) -> Bool { ready && captured == generation }
  mutating func observe(_ revocation: NativeVerifiedAppleRevocation) {
    let key = RevocationKey(revocation)
    guard !committed.contains(key) else { return }
    generation += 1
    guard !pending.contains(where: { RevocationKey($0) == key }) else { return }
    pending.append(revocation)
  }
  @discardableResult
  mutating func retry(_ commit: (NativeVerifiedAppleRevocation) throws -> Void) -> Bool {
    var failed: [NativeVerifiedAppleRevocation] = []
    for revocation in pending {
      do {
        try commit(revocation)
        committed.insert(RevocationKey(revocation))
      } catch { failed.append(revocation) }
    }
    pending = failed
    return ready
  }
}

@MainActor
final class WebBridgeRouter {
  private let settings: SettingsExecutor
  private let entitlement: EntitlementBridge
  private let accountSyncStatus: AccountSyncStatusStore
  private let accessTrust: AccessTrust
  private let accessSessionVerifier: NativeAccessSessionVerifier?
  /// Native arrival-order fence; display state supplies lineage only, never authentication.
  private var accessAccountLineage = 0
  private var accessRevocations = AppleAccessRevocationFence()
  private let analytics = AnalyticsIdentityStore.appGroup()
  /// Read once per launch: `appContext` records the version it ran, so a second read in the same
  /// launch would lose the update it just reported. Callers that arrive while the first read is
  /// still waiting for iCloud share that same read.
  private let analyticsContextThisLaunch = LaunchValue<AnalyticsAppContext>()
  private let purchases = PurchaseManager.shared
  private let siwa = SignInWithAppleCoordinator()
  /// The Restore tap while the paid tier is off. One check at a time, so one tap raises at most
  /// one App Store sign-in sheet.
  private let freePeriodRestore = FreePeriodRestoreCheck(store: AppStoreRestoreCheck())

  /// At most one ask for Apple's purchase history per launch. `refreshReceiptStamp` runs at launch
  /// AND every time the app becomes active, and on a cold launch both of those happen before
  /// anything is backgrounded, so without this the first launch alone would spend two of the three
  /// attempts and could hold two `AppTransaction` requests open at once. Two chances of an App
  /// Store sign-in sheet is the shape to avoid: the ceiling is meant to bound distinct launches,
  /// not overlapping asks inside one. Never cleared, so the next attempt waits for the next launch.
  /// Everything here is main-actor isolated, so reading and setting it cannot interleave and no
  /// lock is needed.
  ///
  /// Dormant today, and deliberately kept: while paid access is switched off nothing asks Apple at
  /// all (`OriginalInstall.shouldRequestVerifiedValues`), so this bound only matters again when the
  /// paid path returns, which is exactly when it will be needed again.
  private var hasAskedAppleForPurchaseHistoryThisLaunch = false

  init(
    settings: SettingsExecutor,
    entitlement: EntitlementBridge = EntitlementBridge(
      store: .appGroup(), receiptStatus: { stillReceiptStatusCache.current }),
    accountSyncStatus: AccountSyncStatusStore = .appGroup(),
    accessTrust: AccessTrust = .compiled,
    accessSessionVerifier: NativeAccessSessionVerifier? = NativeAccessConfiguration.sessionVerifier()
  ) {
    self.settings = settings
    self.entitlement = entitlement
    self.accountSyncStatus = accountSyncStatus
    self.accessTrust = accessTrust
    self.accessSessionVerifier = accessSessionVerifier
  }

  /// Refresh the cached receipt snapshot and route it through the stamp policy (the receipt lane's
  /// restamp — R5/R16). Called at launch (before install-id publication), on foreground, and after
  /// purchase/restore so the Safari extension unlocks without any account.
  @discardableResult
  func refreshReceiptStamp() async -> ReceiptStatus {
    retryVerifiedRevocations()
    let status = await purchases.refreshReceiptStatus { self.commitVerifiedRevocation($0) }
    // Failure cannot be presented as purchased, even when a separate receipt is entitled.
    let accepted = accessRevocations.ready ? status : .noSignal
    _ = entitlement.applyReceipt(accepted)
    // Cohort capture rides along on the same moments the receipt is read, but is deliberately NOT
    // awaited: launch defers publishing the install-generation id until this method returns, and
    // asking Apple for the app transaction has no time bound at all. It is idempotent and asks
    // Apple at most once per launch, so the overlapping calls from launch, foreground, purchase,
    // and restore are harmless. While paid access is dormant it asks Apple nothing and only writes
    // the local record, which touches no network at all.
    Task { await self.captureOriginalInstall() }
    return accepted
  }

  private func retryVerifiedRevocations() {
    guard MonetizationConfig.paidTierEnabled else { return }
    accessRevocations.retry { _ = try self.entitlement.revokeAppleAccess($0) }
  }

  private func commitVerifiedRevocation(_ revocation: NativeVerifiedAppleRevocation) {
    guard MonetizationConfig.paidTierEnabled else { return }
    // Must precede any attempt to commit: no existing binding is still a meaningful install fence.
    accessRevocations.observe(revocation)
    retryVerifiedRevocations()
  }

  func handle(_ body: Any, frame: BridgeFrame, reply: @escaping (Any?, String?) -> Void) {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else {
      reply(nil, "still: malformed message")
      return
    }

    switch kind {
    case "get", "set", "settingsIntent", "settingsAtomic":
      // Parse on MainActor; queue the decoded request before yielding so arrival order survives.
      guard let request = BridgeRequest.parse(body) else {
        reply(nil, "still: unrecognized settings message")
        return
      }
      settings.submit(request) { json in reply(json, nil) }

    case "safariSetupState":
      Task {
        let observation = await SafariExtensionBridge.observeSetup()
        reply(Self.json(observation.bridgeReply), nil)
      }

    case "onboardingState":
      reply(Self.json(OnboardingGate.webStateReply(
        presenter: OnboardingPresenter.selected,
        defaults: OnboardingGate.appGroupDefaults(),
        platform: Self.setupPlatform,
        osMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion
      )), nil)

    case "completeOnboarding":
      guard OnboardingGate.completeFromWeb(
        presenter: OnboardingPresenter.selected, defaults: OnboardingGate.appGroupDefaults())
      else {
        reply(nil, "still: onboarding not presented by the web view")
        return
      }
      reply(Self.json(["ok": true]), nil)

    case NativeOpenRequest.messageKind:
      switch NativeOpenRequest.authorize(
        body: body, frame: frame, platform: Self.setupPlatform,
        appIsActive: SafariExtensionBridge.appIsActive)
      {
      case .failure(let refusal):
        reply(nil, "still: open refused (\(refusal.rawValue))")
      case .success(let destination):
        Task {
          if await SafariExtensionBridge.open(destination) {
            reply(Self.json(NativeOpenRequest.reply(destination)), nil)
          } else {
            reply(nil, "still: open failed")
          }
        }
      }

    case "signInWithApple":
      Task { await RatingHold.app.during(.signIn) { await self.handleSignIn(reply: reply) } }

    case "ratingHold":
      // The web UI's current flow, for holding Apple's rating sheet (U13-P3). Process-local only.
      let known = RatingHold.app.report(dict["flow"])
      reply(Self.json(["ok": known]), nil)

    case "configurePurchases":
      guard let appUserID = dict["appUserID"] as? String, !appUserID.isEmpty else {
        reply(nil, "still: configurePurchases missing appUserID")
        return
      }
      // Await the RevenueCat identity transition before acknowledging: an early ok let the web layer
      // start a purchase while RevenueCat was still re-keying to a different user. A failed logIn
      // still replies once the attempt settles (never hang the bridge); PurchaseManager's identity
      // guards remain the purchase-time gate.
      Task {
        await self.purchases.configure(appUserID: appUserID)
        reply(Self.json(["ok": true]), nil)
      }

    case "pendingAppRoute":
      guard Set(dict.keys) == ["kind"], frame.isTrusted else {
        reply(nil, "still: invalid app route request"); return
      }
      reply(Self.json(["pending": StillProRoute.pending() as Any? ?? NSNull()]), nil)

    case "acknowledgeAppRoute":
      guard Set(dict.keys) == ["kind", "revision"], frame.isTrusted,
            let number = dict["revision"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
            number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
            number.doubleValue.rounded(.down) == number.doubleValue else {
        reply(nil, "still: invalid app route acknowledgment"); return
      }
      reply(Self.json(["ok": StillProRoute.acknowledge(number.intValue), "revision": number.intValue]), nil)

    case "applePurchaseEvidence":
      guard Set(dict.keys) == ["kind"], frame.isTrusted else {
        reply(nil, "still: invalid purchase evidence request"); return
      }
      Task {
        let evidence = await self.purchases.applePurchaseEvidence { self.commitVerifiedRevocation($0) }
        guard self.accessRevocations.ready else { reply(nil, "still: Apple revocation commit requires verification"); return }
        reply(Self.json(["evidence": evidence as Any? ?? NSNull()]), nil)
      }

    case "appleLocalPurchaseEvidence":
      guard Set(dict.keys) == ["kind"], frame.isTrusted else {
        reply(nil, "still: invalid local purchase evidence request"); return
      }
      Task {
        let evidence = await self.purchases.appleLocalPurchaseEvidence { self.commitVerifiedRevocation($0) }
        guard self.accessRevocations.ready else { reply(nil, "still: Apple revocation commit requires verification"); return }
        reply(Self.json(["evidence": evidence as Any? ?? NSNull()]), nil)
      }

    case "installAppleAccess":
      guard MonetizationConfig.paidTierEnabled else { reply(nil, "still: Apple access unavailable"); return }
      retryVerifiedRevocations()
      guard accessRevocations.ready, frame.isTrusted, let request = AppleAccessInstallRequest.parse(body),
        let binding = try? VerifiedAppleRightBinding.verify(request.nativeBinding, trust: accessTrust),
        let generation = try? entitlement.prepareAppleAccessInstall()
      else { reply(nil, "still: Apple access requires verification"); return }
      let lineage = accessAccountLineage
      let revocationLineage = accessRevocations.generation
      let accountAtStart = accountSyncStatus.peek()?.accountId
      Task {
        let session: VerifiedNativeAccessSession?
        if let token = request.accessToken {
          session = await self.accessSessionVerifier?.verify(accessToken: token)
          guard let session, session.accountId == accountAtStart,
            self.accessAccountLineage == lineage, self.accountSyncStatus.peek()?.accountId == accountAtStart
          else { reply(nil, "still: Apple account session requires verification"); return }
        } else { session = nil }
        guard let identity = await self.purchases.verifiedApplePurchaseIdentity(productId: binding.claims.productId,
          onVerifiedRevocation: { self.commitVerifiedRevocation($0) }),
          self.accessRevocations.permitsInstall(revocationLineage),
          session == nil || (self.accessAccountLineage == lineage && self.accountSyncStatus.peek()?.accountId == accountAtStart)
        else { reply(nil, "still: Apple purchase requires verification"); return }
        do {
          let committed = try self.entitlement.installAppleAccess(request, nativePurchase: identity,
            session: session, expectedGeneration: session == nil ? nil : generation)
          reply(String(data: try JSONEncoder().encode(committed), encoding: .utf8), nil)
        } catch { reply(nil, "still: Apple access commit requires verification") }
      }

    case "observeAppleAccess":
      guard MonetizationConfig.paidTierEnabled else { reply(nil, "still: Apple access unavailable"); return }
      retryVerifiedRevocations()
      guard accessRevocations.ready, frame.isTrusted, Set(dict.keys) == ["kind"] else {
        reply(nil, "still: invalid Apple access observation"); return
      }
      reply(entitlement.handle(.getAppleAccess), nil)

    case "observeAppleLinkAccess":
      guard MonetizationConfig.paidTierEnabled else { reply(nil, "still: Apple link access unavailable"); return }
      retryVerifiedRevocations()
      guard accessRevocations.ready, frame.isTrusted, Set(dict.keys) == ["kind"] else {
        reply(nil, "still: invalid Apple link observation"); return
      }
      let revocationLineage = accessRevocations.generation
      let accountLineage = accessAccountLineage
      Task {
        guard let identities = await self.purchases.verifiedAppleLinkPurchaseIdentities { self.commitVerifiedRevocation($0) },
          self.accessRevocations.permitsInstall(revocationLineage), self.accessAccountLineage == accountLineage
        else { reply(nil, "still: Apple link purchase requires verification"); return }
        do {
          var candidate: AppleAccessObservation?
          for identity in identities {
            let observation = try self.entitlement.observeAppleLinkAccess(nativePurchase: identity)
            if !observation.rights.isEmpty {
              // Never silently select one purchaser when more than one current local right matches.
              guard candidate == nil, observation.rights.count == 1 else { throw AccessProofFailure.invalid }
              candidate = observation
            }
          }
          let empty = try self.entitlement.observeAppleLinkAccess(nativePurchase: nil)
          guard candidate == nil || candidate?.generation == empty.generation else { throw AccessProofFailure.invalid }
          reply(String(data: try JSONEncoder().encode(candidate ?? empty), encoding: .utf8), nil)
        } catch { reply(nil, "still: Apple link eligibility requires verification") }
      }

    case "proOffering":
      guard Set(dict.keys) == ["kind"], frame.isTrusted else {
        reply(nil, "still: invalid offering request"); return
      }
      guard MonetizationConfig.paidTierEnabled else { reply(Self.json(["offer": NSNull()]), nil); return }
      Task {
        let offer = await self.purchases.lifetimeOffering()
        reply(Self.json(["offer": offer?.payload as Any? ?? NSNull()]), nil)
      }

    case "purchasePro":
      guard Set(dict.keys) == ["kind", "offer"], frame.isTrusted,
            let offer = AppleLifetimeOffering.parse(dict["offer"]) else {
        reply(nil, "still: invalid purchase offer"); return
      }
      guard MonetizationConfig.paidTierEnabled else {
        reply(Self.json(ApplePurchaseActionResult(.unavailable).payload), nil); return
      }
      Task {
        let result = await RatingHold.app.during(.purchase) {
          let result = await self.purchases.purchasePro(offer: offer, onVerifiedRevocation: { self.commitVerifiedRevocation($0) })
          await self.refreshReceiptStamp()
          return result
        }
        guard self.accessRevocations.ready else { reply(nil, "still: Apple revocation commit requires verification"); return }
        reply(Self.json(result.payload), nil)
      }

    case "restorePro":
      guard Set(dict.keys) == ["kind"], frame.isTrusted else {
        reply(nil, "still: invalid restore request"); return
      }
      guard MonetizationConfig.paidTierEnabled else {
        reply(Self.json(ApplePurchaseActionResult(.unavailable).payload), nil); return
      }
      Task {
        let result = await RatingHold.app.during(.restore) {
          // The existing bounded StoreKit check includes historical purchases and conclusively
          // reports absence only after an actual successful AppStore.sync. Never RC transfer.
          let checked = await self.freePeriodRestore.run()
          await self.refreshReceiptStamp()
          let read = self.purchases.lastReceiptRead
          let outcome: ApplePurchaseActionOutcome = checked == .restored ? .restored :
            (checked == .none ? .nothing : .failed)
          return ApplePurchaseActionResult(outcome, receipt: read.status, productId: read.productID)
        }
        guard self.accessRevocations.ready else { reply(nil, "still: Apple revocation commit requires verification"); return }
        reply(Self.json(result.payload), nil)
      }

    case "purchase":
      // The paid tier is dormant behind MonetizationConfig.paidTierEnabled, so the two actions that
      // could put a price in front of someone are refused here, at the native boundary. That holds
      // even for an older web bundle that still knows how to ask. Everything else on this router,
      // including the receipt read and the App Group entitlement stamp, keeps running so a customer
      // who already bought stays entitled and a later switch flip needs no rebuild of this path.
      guard MonetizationConfig.paidTierEnabled else {
        reply(Self.json(["outcome": "unavailable", "entitled": false]), nil)
        return
      }
      Task {
        let outcome = await RatingHold.app.during(.purchase) {
          let outcome = await self.purchases.purchaseStillPro { self.commitVerifiedRevocation($0) }
          // Restamp from the fresh receipt before acknowledging (R5): Safari unlocks even if the
          // webview dies right after the sheet. Harmless for cancelled/failed (noSignal no-ops).
          await self.refreshReceiptStamp()
          return outcome
        }
        reply(Self.json(Self.outcomePayload(outcome)), nil)
      }

    case "restore":
      // While the paid tier is off the RevenueCat restore below is never reached: it would act on
      // the RevenueCat identity, and nothing is for sale. The person's Restore tap instead gets a
      // real, read-only App Store check (owner decision 17) with a conclusive answer: restored,
      // none, or failed. It cannot sell or unlock anything. The stamp refresh after it is the same
      // receipt lane launch and foreground already run, through StampPolicy, and while the paid
      // tier is off the extension's access snapshot ignores that stamp.
      guard MonetizationConfig.paidTierEnabled else {
        Task {
          let result = await RatingHold.app.during(.restore) {
            let result = await self.freePeriodRestore.run()
            await self.refreshReceiptStamp()
            return result
          }
          reply(Self.json(FreePeriodRestoreCheck.reply(for: result)), nil)
        }
        return
      }
      Task {
        let restored = await RatingHold.app.during(.restore) {
          let restored = await self.purchases.restore { self.commitVerifiedRevocation($0) }
          await self.refreshReceiptStamp()
          return restored
        }
        reply(Self.json(["entitled": restored]), nil)
      }

    case "purchaseStatus":
      Task {
        let entitled = await self.purchases.hasStillPro()
        reply(Self.json(["entitled": entitled]), nil)
      }

    case "receiptStatus":
      // The webview's receipt read (R17 — how a signed-out purchaser's UI shows Pro). Reads are
      // refresh sites: the cache and stamp stay fresh as a side effect.
      Task {
        let status = await self.refreshReceiptStamp()
        reply(Self.json(["receipt": status.rawValue]), nil)
      }

    case "attachPurchases":
      // R7: attach the device receipt to the signed-in account. PurchaseManager's eligibility
      // gate (session + SDK identity equality + purchased ownership) refuses the teardown race
      // (AE13) and family-shared transactions (AE14).
      Task {
        let entitled = await RatingHold.app.during(.purchase) { await self.purchases.attachPurchases { self.commitVerifiedRevocation($0) } }
        reply(Self.json(["entitled": entitled]), nil)
      }

    case "price":
      Task {
        let price = await self.purchases.priceString()
        reply(Self.json(price.map { ["price": $0] } ?? [:]), nil)
      }

    case "signOut":
      accessAccountLineage += 1
      // Fence modern account rights before asynchronous identity cleanup. Existing independent
      // Apple/local protected rights and all saved settings survive this scoped teardown.
      let accessCleared = (try? { try entitlement.clearAccessAccount(); return true }()) ?? false
      // Clear display identity before yielding; delayed purchase cleanup must not clear a new
      // session's status after it has already signed in and published its record.
      accountSyncStatus.clear()
      // Reset the native RevenueCat identity (logOut + clear the configured user) so nothing here
      // can act against the previous account after sign-out. Pairs with the web SyncService sign-out.
      // Awaited before the ok for the same identity-transition reason as configurePurchases above.
      Task {
        await self.purchases.reset()
        reply(Self.json(["ok": true, "access": accessCleared ? "cleared" : "verification_required"]), nil)
      }

    case "analyticsContext":
      Task { await self.handleAnalyticsContext(reply: reply) }

    case "analyticsPermission":
      reply(Self.json(analytics.analyticsPermissionReply()), nil)

    case "commitAnalyticsPermission":
      guard let value = dict["permission"] else {
        reply(nil, "still: commitAnalyticsPermission missing permission")
        return
      }
      reply(Self.json(analytics.commitAnalyticsPermission(value)), nil)

    case "setAnalyticsConsent":
      guard let enabled = dict["enabled"] as? Bool else {
        reply(nil, "still: setAnalyticsConsent missing enabled")
        return
      }
      reply(Self.json(analytics.commitConsent(enabled)), nil)

    case "acknowledgeAnalyticsNotice":
      analytics.acknowledgeNotice()
      reply(Self.json(["ok": true]), nil)

    case "setAccountSyncStatus":
      // Only the trusted bundled WK frame reaches this writer. The Safari native lane only reads.
      let priorAccountId = accountSyncStatus.peek()?.accountId
      guard frame.isTrusted, Set(dict.keys) == ["kind", "status"],
        let status = dict["status"], accountSyncStatus.save(rawStatus: status) else {
        reply(nil, "still: malformed account sync status")
        return
      }
      if accountSyncStatus.peek()?.accountId != priorAccountId {
        accessAccountLineage += 1
        do { try entitlement.clearAccessAccount() }
        catch { reply(nil, "still: account access lineage requires verification"); return }
      }
      reply(Self.json(["ok": true]), nil)

    case "getBenefitAccess":
      guard frame.isTrusted, Set(dict.keys) == ["kind"] else {
        reply(nil, "still: invalid benefit access request"); return
      }
      if !MonetizationConfig.paidTierEnabled { reply(entitlement.handle(.getBenefitAccess), nil); return }
      Task {
        self.retryVerifiedRevocations()
        let ownership = await self.purchases.observeAppleOwnership { self.commitVerifiedRevocation($0) }
        guard self.accessRevocations.ready else { reply(nil, "still: Apple revocation commit requires verification"); return }
        do {
          let snapshot = try self.entitlement.observeAppleBenefits(ownership)
          let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
          reply(Self.json(["ok": true, "snapshot": value]), nil)
        } catch { reply(nil, "still: benefit access requires verification") }
      }

    case "setEntitlement", "getEntitlement", "getAccess":
      // Entitlement mirror: the web layer proposes its server-reconciled value (server lane);
      // EntitlementBridge routes it through StampPolicy (R13). Only the bundled web build reaches
      // this handler (the navigation lockdown in ViewController), the same trust boundary as
      // `purchase` above.
      if let json = entitlement.handle(rawBody: body) {
        reply(json, nil)
        // Blocked-write re-read (ADR 0003): a false proposal blocked on the CACHED entitled status
        // could be riding a stale cache across a mid-session refund. Verify with a fresh read and
        // re-propose through the receipt lane, which may then legitimately clear the stamp.
        if kind == "setEntitlement", (dict["entitled"] as? Bool) == false,
           stillReceiptStatusCache.current == .entitled {
          Task {
            await self.refreshReceiptStamp()
          }
        }
      } else {
        reply(nil, "still: malformed entitlement message")
      }

    default:
      reply(nil, "still: unknown kind \(kind)")
    }
  }

  /// Record, once per install, when this device first ran a build of Still that keeps a local
  /// record of it. That is what lets a later paid tier honor everyone who arrived while everything
  /// was included, without an account and without sending anything anywhere.
  ///
  /// Two halves, deliberately. The local half is written first and always: it reads the app's own
  /// bundle, needs nothing from Apple, works on every OS version Still supports, and is the field
  /// the cohort is actually read from. The verified half comes from Apple's app transaction, is
  /// richer, and is entirely optional: it is available only on newer systems, and asking for it can
  /// put an App Store sign-in sheet in front of a free app when the transaction is not already
  /// cached on the device. So the ask happens at most once per launch, is counted before it is
  /// made, and stops for good after a few attempts, rather than repeating at every launch and every
  /// return to the app.
  ///
  /// On this build the ask never happens at all: `shouldRequestVerifiedValues` is false for the
  /// whole of the free era, so the method stops at the local write and this app asks Apple nothing
  /// at launch. The path below stays here, unchanged, for the day paid access returns.
  private func handleAnalyticsContext(reply: @escaping (Any?, String?) -> Void) async {
    let context = await analyticsContextThisLaunch.get { await self.readAnalyticsContext() }
    let extensionEnabled: Any
    switch await SafariExtensionBridge.currentStatus() {
    case .enabled: extensionEnabled = true
    case .disabled: extensionEnabled = false
    case .unknown: extensionEnabled = NSNull()
    }
    #if os(macOS)
    let platform = "macos"
    #else
    let platform = "ios"
    #endif
    reply(Self.json([
      "platform": platform,
      "appVersion": Self.marketingVersion,
      "installId": context.install.installId,
      "anchorId": context.install.anchorId,
      "created": context.created,
      "returning": context.returning,
      "previousVersion": context.previousVersion ?? NSNull(),
      "consent": analytics.consent,
      "consentAnswered": analytics.consentAnswered,
      "noticeSeen": context.noticeSeen,
      "extensionEnabled": extensionEnabled,
      "device": Self.analyticsDeviceClass,
    ]), nil)
  }

  /// The launch's analytics context, computed once (see `analyticsContextThisLaunch`).
  private func readAnalyticsContext() async -> AnalyticsAppContext {
    // iCloud key-value storage carries only the anonymous person anchor (see AnalyticsIdentity).
    let cloud = NSUbiquitousKeyValueStore.default
    cloud.synchronize()
    // On a fresh install iCloud's key-value store starts empty and fills asynchronously; deciding
    // before then would call a person's second device a first install.
    if !analytics.appHasReadRecord, cloud.string(forKey: AnalyticsIdentityStore.iCloudAnchorKey) == nil {
      await Self.waitForICloudChange(timeoutSeconds: 5)
    }
    // An update is recognised by the original-install record from an earlier version, or, for
    // versions from before that record existed, by App Group state present when this launch began.
    let recorded = OriginalInstall.current(InstallGeneration.appGroupDefaults())?.firstRecordedAppVersion
    let earlier: String?
    if let recorded, recorded != Self.marketingVersion {
      earlier = recorded
    } else if AnalyticsIdentityStore.earlierInstallAtLaunch {
      earlier = AnalyticsIdentityStore.unknownEarlierVersion
    } else {
      earlier = nil
    }
    return analytics.appContext(
      appVersion: Self.marketingVersion, ubiquitous: cloud, earlierInstallVersion: earlier)
  }

  /// Wait for iCloud key-value storage to report a change from the server (its initial sync), or
  /// give up after `timeoutSeconds`. Either way the caller reads the store again.
  private static func waitForICloudChange(timeoutSeconds: Double) async {
    guard #available(iOS 15.0, macOS 12.0, *) else { return }
    await withTaskGroup(of: Void.self) { group in
      group.addTask {
        let changes = NotificationCenter.default.notifications(
          named: NSUbiquitousKeyValueStore.didChangeExternallyNotification)
        for await _ in changes { return }
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
      }
      await group.next()
      group.cancelAll()
    }
  }

  private func captureOriginalInstall() async {
    let defaults = InstallGeneration.appGroupDefaults()
    OriginalInstall.ensure(
      firstRecordedAt: Date(),
      appVersion: Self.marketingVersion,
      defaults: defaults
    )
    guard #available(iOS 16.0, macOS 13.0, *) else { return }
    guard !hasAskedAppleForPurchaseHistoryThisLaunch else { return }
    guard OriginalInstall.shouldRequestVerifiedValues(defaults) else { return }
    hasAskedAppleForPurchaseHistoryThisLaunch = true
    OriginalInstall.countVerifiedAttempt(defaults)
    guard let result = try? await AppTransaction.shared,
          case .verified(let transaction) = result
    else { return }
    // originalAppVersion means different things on iOS and macOS, so the record is tagged with
    // which one it holds rather than left for a future reader to guess.
    OriginalInstall.fillVerifiedValues(
      applicationVersion: transaction.originalAppVersion,
      kind: OriginalInstall.applicationVersionKindForThisPlatform,
      originalPurchaseDate: transaction.originalPurchaseDate,
      defaults: defaults
    )
  }

  /// Still's own marketing version (`CFBundleShortVersionString`), which is the same namespace on
  /// every Apple platform.
  /// Phone, tablet or desktop, for analytics.
  private static var analyticsDeviceClass: String {
    #if os(iOS)
    return AnalyticsIdentityStore.deviceClass(isPad: UIDevice.current.userInterfaceIdiom == .pad)
    #else
    return AnalyticsIdentityStore.deviceClass(isPad: false)
    #endif
  }

  private static var setupPlatform: SafariSetupObservation.Platform {
    #if os(macOS)
    return .macos
    #else
    return .ios
    #endif
  }

  private static var marketingVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
  }

  private func handleSignIn(reply: @escaping (Any?, String?) -> Void) async {
    do {
      let credential = try await siwa.signIn()
      var payload: [String: Any] = [
        "identityToken": credential.identityToken,
        "nonce": credential.rawNonce,
      ]
      if let email = credential.email { payload["email"] = email }
      if let fullName = credential.fullName { payload["fullName"] = fullName }
      reply(Self.json(payload), nil)
    } catch {
      reply(Self.json(["error": error.localizedDescription]), nil)
    }
  }

  private static func outcomePayload(_ outcome: PurchaseManager.Outcome) -> [String: Any] {
    switch outcome {
    case .purchased: return ["outcome": "purchased", "entitled": true]
    case .cancelled: return ["outcome": "cancelled", "entitled": false]
    case .pending: return ["outcome": "pending", "entitled": false]
    case .unavailable: return ["outcome": "unavailable", "entitled": false]
    case .staleIdentity: return ["outcome": "staleIdentity", "entitled": false]
    case .failed(let message): return ["outcome": "failed", "error": message, "entitled": false]
    }
  }

  private static func json(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let string = String(data: data, encoding: .utf8)
    else { return "{}" }
    return string
  }
}
