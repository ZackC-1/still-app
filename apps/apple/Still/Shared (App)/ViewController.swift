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

    // The App-Group settings bridge (U17). Held directly (not just inside the router) so the Darwin
    // observer below can re-read the stored record when the Safari extension writes settings. The
    // store falls back to in-memory if the App Group isn't provisioned, so the UI still launches.
    private let settingsBridge = SettingsBridge(store: .appGroup())

    // Routes web messages to native: the App-Group settings bridge (U17) plus the U19 auth/purchase
    // actions.
    private lazy var router = WebBridgeRouter(settings: settingsBridge)

    // The block-based didBecomeActive observer's token — NotificationCenter retains the block, and
    // removeObserver(self) does NOT deregister a block observer, so the token is the only handle
    // that can. Held so deinit can remove it.
    private var didBecomeActiveToken: NSObjectProtocol?

    // The bundled web build's index URL — the only origin trusted to drive privileged native actions
    // and the only navigation we allow (P0 #1). Set once the bundle is located in viewDidLoad.
    private var bundledIndexURL: URL?

    override func viewDidLoad() {
        super.viewDidLoad()

        // RevenueCat configures ANONYMOUSLY before the webview loads (purchase-first, R1/R2):
        // synchronous and first, so a stored-session boot's configurePurchases(uuid) can only ever
        // take the logIn re-key branch — never a racing second configure.
        PurchaseManager.shared.configure()

        // Launch ordering (R16, plan 2026-07-15-001): read the device receipt and restamp the App
        // Group BEFORE publishing this install's generation id. A reinstall wipes the App Group
        // (iOS); publishing a fresh id first would let a Safari page-load purge the entitlement
        // while a valid receipt sits unstamped. The read is deadline-bounded (≤8s → noSignal), so
        // publication is deferred at most one deadline, never indefinitely; the extension treats
        // the unpublished (null) id as a strict no-op in the meantime. `ensure` is idempotent: an
        // ordinary relaunch returns the existing id, never a fresh one (issue #63).
        Task { @MainActor in
            await self.router.refreshReceiptStamp()
            InstallGeneration.ensure(InstallGeneration.appGroupDefaults())
        }

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = true
        self.webView.scrollView.alwaysBounceHorizontal = false
        self.webView.scrollView.showsHorizontalScrollIndicator = false
        self.view.backgroundColor = .systemBackground
        self.webView.isOpaque = false
        self.webView.backgroundColor = .clear
        self.webView.scrollView.backgroundColor = .clear
#endif

        // Register the request/reply bridge the WKWebViewStorageAdapter posts to. Reply-style so the
        // web `await postMessage(...)` resolves with the resolved settings JSON.
        self.webView.configuration.userContentController.addScriptMessageHandler(
            self, contentWorld: .page, name: "still")

        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "WebUI") {
            self.bundledIndexURL = indexURL
            self.webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        } else {
            assertionFailure("WebUI/index.html missing from the app bundle — build the web bundle first")
        }

        observeExternalSettingsChanges()
    }

    deinit {
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            CFNotificationName(StillSettingsChangedNotification.name as CFString),
            nil)
        if let token = didBecomeActiveToken {
            NotificationCenter.default.removeObserver(token)
        }
    }

    // Refresh the already-running web UI when another App-Group process writes settings (e.g. the
    // Safari extension reconciles a toggle):
    //
    //   1. Live path — StillKit posts a Darwin notification on every applied settings write (the only
    //      bus that crosses the extension ↔ app process boundary); we push the stored record into the
    //      page via window.__stillApplyRemote. This fires only while BOTH processes run at once
    //      (iPad Split View, macOS) — a suspended process never receives Darwin notifications.
    //   2. Foreground path — on iPhone the app is SUSPENDED the moment the user switches to Safari to
    //      change a setting in the extension popup, so it misses the Darwin post entirely. Re-reading
    //      the App Group when the app becomes active again covers that (the common iPhone case): the
    //      stored value is already correct (App-Group LWW), only the open view was stale.
    //
    // The app's own writes echo through both paths too; harmless, because the web SettingsCache
    // dedupes incoming records by updatedAt/version, so an unchanged record no-ops (no feedback loop).
    private func observeExternalSettingsChanges() {
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                // C-function context: no captures allowed. Recover self from the observer pointer
                // and hop to the main actor before touching the web view.
                guard let observer else { return }
                let controller = Unmanaged<ViewController>.fromOpaque(observer).takeUnretainedValue()
                Task { @MainActor in controller.pushStoredSettingsToWeb() }
            },
            StillSettingsChangedNotification.name as CFString,
            nil,
            .deliverImmediately)

        #if os(iOS)
        let becameActive = UIApplication.didBecomeActiveNotification
        #elseif os(macOS)
        let becameActive = NSApplication.didBecomeActiveNotification
        #endif
        didBecomeActiveToken = NotificationCenter.default.addObserver(
            forName: becameActive, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.pushStoredSettingsToWeb()
                // Foreground receipt refresh (R13/R18): keeps the cached snapshot and the App
                // Group stamp current — an Ask-to-Buy approval or refund that landed while the
                // app was backgrounded is observed here.
                await self?.router.refreshReceiptStamp()
            }
        }
    }

    /// Push the current App-Group settings record into the page. The record JSON (the same
    /// encodeRecord shape the bridge replies with) is passed to window.__stillApplyRemote as a
    /// structured callAsyncJavaScript argument, never concatenated into script source. Guarded so it
    /// no-ops when nothing is stored yet or the page hasn't installed __stillApplyRemote.
    private func pushStoredSettingsToWeb() {
        let json = settingsBridge.handle(.get)
        guard !json.isEmpty else { return }
        // The record travels as the JSON STRING the bridge already returns, bound to `record` via
        // callAsyncJavaScript's arguments dictionary: the web side's parseStoredSettingsRecord sees
        // through strings (it JSON.parses them exactly like the bridge's reply path), so there's no
        // lossy JSON→Foundation→JS round-trip, no double encode, and — the point of this API — no
        // string-into-source concatenation for a crafted record to escape. Runs in .page, the same
        // content world where the "still" handler is registered (viewDidLoad) and where the page's
        // WKWebViewStorageAdapter installs __stillApplyRemote.
        webView.callAsyncJavaScript(
            "if (typeof window.__stillApplyRemote === 'function') { window.__stillApplyRemote(record); }",
            arguments: ["record": json],
            in: nil,
            in: .page,
            completionHandler: nil)
    }

#if os(macOS)
    /// Window-geometry hardening (PR #55 review findings), from the one macOS viewDidAppear below:
    /// the window is restorable="NO" with no autosave name, so without this every relaunch discards
    /// a manual resize and reopens at the storyboard's 480x860 default; and the storyboard minSize
    /// archives as a FRAME minimum (NSMinSize), landing the CONTENT floor ~28pt short of the
    /// intended 440x560 (title-bar height) — contentMinSize makes the floor exact.
    private func applyWindowGeometryPolicy() {
        guard let window = view.window else { return }
        window.setFrameAutosaveName("StillMainWindow")
        window.contentMinSize = NSSize(width: 440, height: 560)
    }
#endif

    // Navigation lockdown (P0 #1): only the bundled web build may load in the web view. A remote
    // navigation (e.g. an injected/compromised page trying to reach an attacker origin) is cancelled;
    // a user-tapped external http(s) link (e.g. the in-app privacy policy) is handed to the system
    // browser instead of loading in-app.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let bundled = bundledIndexURL else { decisionHandler(.allow); return } // pre-load safety
        let url = navigationAction.request.url
        if BridgeTrust.allowsNavigation(to: url, bundledURL: bundled) {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated, BridgeTrust.opensExternally(url), let url {
            #if os(iOS)
            UIApplication.shared.open(url)
            #elseif os(macOS)
            NSWorkspace.shared.open(url)
            #endif
        }
        decisionHandler(.cancel)
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
        applyWindowGeometryPolicy()
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
        // Trust boundary (P0 #1): only the bundled main frame may drive native actions. An iframe or
        // an injected/remote origin posting `still` messages is refused before the router sees it.
        guard let bundled = bundledIndexURL,
              BridgeTrust.isTrusted(
                  isMainFrame: message.frameInfo.isMainFrame,
                  url: message.frameInfo.request.url,
                  bundledURL: bundled
              )
        else {
            replyHandler(nil, "still: untrusted frame")
            return
        }
        router.handle(message.body, reply: replyHandler)
    }
}
