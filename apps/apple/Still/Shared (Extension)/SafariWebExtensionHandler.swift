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
//

import SafariServices
import StillKit
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let bridge = SettingsBridge(store: .appGroup())
    private let entitlementBridge = EntitlementBridge(store: .appGroup(), readOnly: true)
    private let accountSyncStatus = AccountSyncStatusStore.appGroup()

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        // Account display status has a read-only lane. Unknown kinds, including status setters,
        // fall through to the settings bridge, which ignores them without writing.
        let payload: [String: Any]
        if let statusReply = message.flatMap({ accountSyncStatus.readReply(rawBody: $0) }) {
            payload = statusReply
        } else if let entitlementJSON = message.flatMap({ entitlementBridge.handle(rawBody: $0) }) {
            payload = ["entitlement": entitlementJSON]
        } else {
            let settingsJSON = message.flatMap { bridge.handle(rawBody: $0) } ?? ""
            payload = ["settings": settingsJSON]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
