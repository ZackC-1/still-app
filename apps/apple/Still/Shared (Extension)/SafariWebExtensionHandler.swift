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

import SafariServices
import StillKit
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let bridge = SettingsBridge(store: .appGroup())

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        // Route the App-Group reconcile message through the shared bridge. An unrecognized message
        // yields an empty settings string, which the background treats as "no value".
        let settingsJSON = message.flatMap { bridge.handle(rawBody: $0) } ?? ""
        let payload: [String: Any] = ["settings": settingsJSON]

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
