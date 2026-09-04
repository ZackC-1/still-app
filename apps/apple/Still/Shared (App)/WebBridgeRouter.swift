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
//    • U19 auth + purchase (reply a small JSON object; purchase-first — plan 2026-07-15-001):
//        { kind:"signInWithApple" }           → { identityToken, nonce, email?, fullName? } | { error }
//        { kind:"configurePurchases", appUserID } → { ok:true }   (KTD5 — RC re-keyed to the Supabase UUID)
//        { kind:"purchase" }                  → { outcome, entitled }   (works signed out — R1)
//        { kind:"restore" }                   → { entitled }            (works signed out — R4)
//        { kind:"purchaseStatus" }            → { entitled }
//        { kind:"receiptStatus" }             → { receipt: "entitled"|"verifiedNotEntitled"|"noSignal" }
//        { kind:"attachPurchases" }           → { entitled }   (R7 — attach the receipt to the account)
//        { kind:"price" }                     → { price } | {}   (localized store price for the CTA)
//        { kind:"signOut" }                   → { ok:true }   (reset RC identity on sign-out)
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
//  The web layer drives sign-in: the web client signs in via email code, then hands the resulting
//  UUID back via `configurePurchases` so RevenueCat is keyed to the same account the webhook (U14)
//  projects the entitlement onto. Purchase no longer requires a session (Guideline 5.1.1(v)).
//

import WebKit
import StoreKit
import StillKit

@MainActor
final class WebBridgeRouter {
  private let settings: SettingsBridge
  private let entitlement: EntitlementBridge
  private let purchases = PurchaseManager.shared
  private let siwa = SignInWithAppleCoordinator()

  init(
    settings: SettingsBridge,
    entitlement: EntitlementBridge = EntitlementBridge(
      store: .appGroup(), receiptStatus: { stillReceiptStatusCache.current })
  ) {
    self.settings = settings
    self.entitlement = entitlement
  }

  /// Refresh the cached receipt snapshot and route it through the stamp policy (the receipt lane's
  /// restamp — R5/R16). Called at launch (before install-id publication), on foreground, and after
  /// purchase/restore so the Safari extension unlocks without any account.
  func refreshReceiptStamp() async {
    let status = await purchases.refreshReceiptStatus()
    _ = entitlement.applyReceipt(status)
    // Cohort capture rides along on the same moments the receipt is read, but is deliberately NOT
    // awaited: launch defers publishing the install-generation id until this method returns, and
    // AppTransaction can take an unbounded App Store round trip on a cold cache. It is idempotent,
    // so the overlapping calls from launch, foreground, purchase, and restore are harmless.
    Task { await self.captureOriginalInstall() }
  }

  func handle(_ body: Any, reply: @escaping (Any?, String?) -> Void) {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else {
      reply(nil, "still: malformed message")
      return
    }

    switch kind {
    case "get", "set":
      // U17 settings bridge — synchronous; reply is the resolved settings JSON string (or "").
      if let json = settings.handle(rawBody: body) {
        reply(json, nil)
      } else {
        reply(nil, "still: unrecognized settings message")
      }

    case "signInWithApple":
      Task { await self.handleSignIn(reply: reply) }

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

    case "purchase":
      guard MonetizationConfig.paidTierEnabled else {
        reply(Self.json(["outcome": "unavailable", "entitled": false]), nil)
        return
      }
      Task {
        let outcome = await self.purchases.purchaseStillPro()
        // Restamp from the fresh receipt before acknowledging (R5): Safari unlocks even if the
        // webview dies right after the sheet. Harmless for cancelled/failed (noSignal no-ops).
        await self.refreshReceiptStamp()
        reply(Self.json(Self.outcomePayload(outcome)), nil)
      }

    case "restore":
      guard MonetizationConfig.paidTierEnabled else {
        reply(Self.json(["entitled": false]), nil)
        return
      }
      Task {
        let restored = await self.purchases.restore()
        await self.refreshReceiptStamp()
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
        let status = await self.purchases.refreshReceiptStatus()
        _ = self.entitlement.applyReceipt(status)
        reply(Self.json(["receipt": status.rawValue]), nil)
      }

    case "attachPurchases":
      // R7: attach the device receipt to the signed-in account. PurchaseManager's eligibility
      // gate (session + SDK identity equality + purchased ownership) refuses the teardown race
      // (AE13) and family-shared transactions (AE14).
      Task {
        let entitled = await self.purchases.attachPurchases()
        reply(Self.json(["entitled": entitled]), nil)
      }

    case "price":
      Task {
        let price = await self.purchases.priceString()
        reply(Self.json(price.map { ["price": $0] } ?? [:]), nil)
      }

    case "signOut":
      // Reset the native RevenueCat identity (logOut + clear the configured user) so nothing here
      // can act against the previous account after sign-out. Pairs with the web SyncService sign-out.
      // Awaited before the ok for the same identity-transition reason as configurePurchases above.
      Task {
        await self.purchases.reset()
        reply(Self.json(["ok": true]), nil)
      }

    case "setEntitlement", "getEntitlement":
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
            let fresh = await self.purchases.refreshReceiptStatus()
            if fresh == .verifiedNotEntitled {
              _ = self.entitlement.applyReceipt(fresh)
            }
          }
        }
      } else {
        reply(nil, "still: malformed entitlement message")
      }

    default:
      reply(nil, "still: unknown kind \(kind)")
    }
  }

  /// AppTransaction is unavailable on the deployment floors (iOS 15 and macOS 12), so cohort
  /// capture is best-effort on newer systems. It stays local in the App Group and retries on later
  /// receipt refreshes until one verified transaction has been recorded.
  private func captureOriginalInstall() async {
    guard #available(iOS 16.0, macOS 13.0, *) else { return }
    let defaults = InstallGeneration.appGroupDefaults()
    guard OriginalInstall.current(defaults) == nil else { return }
    guard let result = try? await AppTransaction.shared,
          case .verified(let transaction) = result
    else { return }
    OriginalInstall.recordIfAbsent(
      OriginalInstallRecord(
        applicationVersion: transaction.originalAppVersion,
        originalPurchaseDate: transaction.originalPurchaseDate
      ),
      defaults: defaults
    )
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
