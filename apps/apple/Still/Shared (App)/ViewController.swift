//
//  ViewController.swift
//  Shared (App)
//
//  The native shell for the one shared Still UI (U17): a WKWebView loads the bundled web build
//  (packages/app-webview) and persists settings through the App-Group bridge (KTD4). The web side's
//  WKWebViewStorageAdapter posts {kind:"get"} / {kind:"set",settings} to the "still" message handler;
//  we route each through StillKit's SettingsBridge against the shared App-Group container, so the
//  app, the Safari extension, and the WKWebView all read/write the same settings.
//

import WebKit
import StillKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
typealias PlatformViewController = NSViewController
#endif

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandlerWithReply {

    @IBOutlet var webView: WKWebView!

    // Routes web messages to native: the App-Group settings bridge (U17) plus the U19 auth/purchase
    // actions. The settings store falls back to in-memory if the App Group isn't provisioned, so the
    // UI still launches.
    private let router = WebBridgeRouter(settings: SettingsBridge(store: .appGroup()))

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = true
#endif

        // Register the request/reply bridge the WKWebViewStorageAdapter posts to. Reply-style so the
        // web `await postMessage(...)` resolves with the resolved settings JSON.
        self.webView.configuration.userContentController.addScriptMessageHandler(
            self, contentWorld: .page, name: "still")

        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "WebUI") {
            self.webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        } else {
            assertionFailure("WebUI/index.html missing from the app bundle — build the web bundle first")
        }
    }

    // Present the first-launch onboarding (U18) over the Settings WebView, once. The presenter gates
    // on OnboardingGate, so this no-ops on every launch after the user finishes the flow.
#if os(iOS)
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        OnboardingPresenter.presentIfNeeded(from: self)
    }
#elseif os(macOS)
    override func viewDidAppear() {
        super.viewDidAppear()
        OnboardingPresenter.presentIfNeeded(from: self)
    }
#endif

    // WKScriptMessageHandlerWithReply: bridge web → App Group and reply with the resolved settings.
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == "still" else {
            replyHandler(nil, "still: unexpected handler \(message.name)")
            return
        }
        router.handle(message.body, reply: replyHandler)
    }
}
