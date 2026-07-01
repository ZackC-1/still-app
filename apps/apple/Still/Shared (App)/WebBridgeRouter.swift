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
//    • U19 auth + purchase (reply a small JSON object):
//        { kind:"signInWithApple" }           → { identityToken, nonce, email?, fullName? } | { error }
//        { kind:"configurePurchases", appUserID } → { ok:true }   (KTD5 — RC keyed to the Supabase UUID)
//        { kind:"purchase" }                  → { outcome, entitled }
//        { kind:"restore" }                   → { entitled }
//        { kind:"purchaseStatus" }            → { entitled }
//        { kind:"price" }                     → { price } | {}   (localized store price for the CTA)
//        { kind:"signOut" }                   → { ok:true }   (KTD5 — reset RC identity on sign-out)
//
//    • Entitlement mirror (reply the stored record JSON string):
//        { kind:"setEntitlement", entitled }  → "{\"entitled\":…,\"updatedAt\":…}"
//        { kind:"getEntitlement" }            → same, or "" when nothing stored
//      The web SyncService mirrors its server-reconciled entitlement here after every state change;
//      the Safari extension pulls it from the App Group so paid blocking activates in Safari.
//
//  The web layer drives sign-in: native returns the Apple credential, the web client calls Supabase
//  `signInWithIdToken`, then hands the resulting UUID back via `configurePurchases` so RevenueCat is
//  keyed to the same account the webhook (U14) projects the entitlement onto. The buy CTA only ever
//  shows after a session exists (KTD5), so this router does not gate that itself.
//

import WebKit
import StillKit

@MainActor
final class WebBridgeRouter {
  private let settings: SettingsBridge
  private let entitlement: EntitlementBridge
  private let purchases = PurchaseManager.shared
  private let siwa = SignInWithAppleCoordinator()

  init(settings: SettingsBridge, entitlement: EntitlementBridge = EntitlementBridge(store: .appGroup())) {
    self.settings = settings
    self.entitlement = entitlement
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
      purchases.configure(appUserID: appUserID)
      reply(Self.json(["ok": true]), nil)

    case "purchase":
      Task {
        let outcome = await self.purchases.purchaseStillSync()
        reply(Self.json(Self.outcomePayload(outcome)), nil)
      }

    case "restore":
      Task {
        let entitled = await self.purchases.restore()
        reply(Self.json(["entitled": entitled]), nil)
      }

    case "purchaseStatus":
      Task {
        let entitled = await self.purchases.hasStillSync()
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
      purchases.reset()
      reply(Self.json(["ok": true]), nil)

    case "setEntitlement", "getEntitlement":
      // Entitlement mirror: the web layer writes its server-reconciled value into the App Group so
      // the Safari extension can read it. Only the bundled web build reaches this handler (the
      // navigation lockdown in ViewController), the same trust boundary as `purchase` above.
      if let json = entitlement.handle(rawBody: body) {
        reply(json, nil)
      } else {
        reply(nil, "still: malformed entitlement message")
      }

    default:
      reply(nil, "still: unknown kind \(kind)")
    }
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
