//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  The native side of the Safari extension's App-Group bridge (KTD4). The extension's background
//  script (packages/ext-safari) reconciles browser.storage.local with the app's settings by sending
//  native messages here: {kind:"get"} / {kind:"set",settings}. We route each through StillKit's
//  SettingsBridge against the shared App-Group container (the same one the app's WKWebView writes),
//  and reply with { settings: "<json>" } — last-write-wins, so a stale store can't silently win.
//
//  A second lane serves the entitlement pull: {kind:"getEntitlement"} replies { entitlement:
//  "<envelope json>" } — the four-key envelope {"entitled":Bool|null,"installId":String|null,
//  "source":String|null,"updatedAt":Int|null}, all keys always present, explicit null when absent
//  (the legacy "" reply is gone; EntitlementBridge.swift is the contract). The app writes the
//  record through StampPolicy from either entitlement authority (server reconcile or the device
//  receipt — ADR 0003); this is how paid Pro blocking reaches Safari's content scripts. The
//  extension never computes OR WRITES entitlement itself: this lane is read-only — the extension
//  process has no receipt oracle, and a writable lane would be an entitlement-forgery surface.
//  {kind:"getBenefitAccess"} (paid builds) rides the same lane: { entitlement: "{ok,snapshot}" }.
//
//  The app hand-off lane, {kind:"openAppRoute", route:"pro"|"sync"}, replies { openAppRoute:
//  {ok, route|null} } and opens nothing but StillAppRoute's two fixed destinations (Mac only).
//

import SafariServices
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif
import StillKit
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    // Atomic commands (initialize, scope, acknowledge) belong to the app and are refused here.
    private let bridge = SettingsBridge.safariExtension(store: .appGroup())
    // Read-only; benefits resolve under the account session the app verified and bound.
    private let entitlementBridge = EntitlementBridge.safariExtension(store: .appGroup())
    private let accountSyncStatus = AccountSyncStatusStore.appGroup()
    private let analytics = AnalyticsIdentityStore.appGroup()

    /// Phone, tablet or desktop, for the analytics lane.
    private static var deviceClass: String {
        #if os(iOS)
        return AnalyticsIdentityStore.deviceClass(isPad: UIDevice.current.userInterfaceIdiom == .pad)
        #else
        return AnalyticsIdentityStore.deviceClass(isPad: false)
        #endif
    }

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        // App hand-off lane: {kind:"openAppRoute", route:"pro"|"sync"} opens this app at one fixed
        // destination (StillAppRoute). Never a URL from the message. On the Mac the handler opens
        // the containing app directly; an iPhone or iPad extension cannot open its app, so it
        // replies ok:false and the popup navigates a Safari tab to the same fixed link instead.
        if let openRequest = message.flatMap({ StillAppRoute.extensionOpenRequest(rawBody: $0) }) {
            Self.open(openRequest) { opened in
                Self.complete(context, payload: openRequest.reply(opened: opened))
            }
            return
        }

        // Account display status has a read-only lane. Unknown kinds, including status setters,
        // fall through to the settings bridge, which ignores them without writing.
        let payload: [String: Any]
        if let statusReply = message.flatMap({ accountSyncStatus.readReply(rawBody: $0) }) {
            payload = statusReply
        } else if let analyticsReply = message.flatMap({
            analytics.extensionReply(
                rawBody: $0, platform: AnalyticsIdentityStore.platformName, device: Self.deviceClass)
        }) {
            // Read-only: the install ids and the app's "Share usage data" switch.
            payload = analyticsReply
        } else if let entitlementJSON = message.flatMap({ entitlementBridge.handle(rawBody: $0) }) {
            payload = ["entitlement": entitlementJSON]
        } else {
            let settingsJSON = message.flatMap { bridge.handle(rawBody: $0) } ?? ""
            payload = ["settings": settingsJSON]
        }

        Self.complete(context, payload: payload)
    }

    private static func complete(_ context: NSExtensionContext, payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// Opens the containing Still app at the fixed destination. The Mac only: the app is the bundle
    /// three levels above this extension (Still.app/Contents/PlugIns/<extension>.appex), so on this
    /// lane another app that also claims `still:` cannot receive the link. (The popup's Safari-tab
    /// path, used on iPhone and iPad and as the Mac fallback, resolves `still:` through the system
    /// like any custom scheme; the links carry nothing private.)
    private static func open(
        _ request: StillAppRoute.ExtensionOpenRequest, completion: @escaping (Bool) -> Void
    ) {
        guard case .open(let destination) = request else { completion(false); return }
        #if os(macOS)
        let app = Bundle.main.bundleURL
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard app.pathExtension == "app" else { completion(false); return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open([destination.url], withApplicationAt: app, configuration: configuration) {
            _, error in completion(error == nil)
        }
        #else
        completion(false)
        #endif
    }

}
