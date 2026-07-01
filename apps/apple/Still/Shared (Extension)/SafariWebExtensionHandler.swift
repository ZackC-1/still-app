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
//  A second lane serves the entitlement pull: {kind:"getEntitlement"} replies
//  { entitlement: "<json {entitled,updatedAt}>" } from the record the app mirrors into the App
//  Group after each server reconcile — this is how paid Pro blocking reaches Safari's content
//  scripts (the extension never computes entitlement itself).
//

import SafariServices
import StillKit
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let bridge = SettingsBridge(store: .appGroup())
    private let entitlementBridge = EntitlementBridge(store: .appGroup())

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        // Route by lane: entitlement messages reply { entitlement }, everything else goes through
        // the settings bridge and replies { settings }. An unrecognized message yields an empty
        // settings string, which the background treats as "no value".
        let payload: [String: Any]
        if let entitlementJSON = message.flatMap({ entitlementBridge.handle(rawBody: $0) }) {
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
