#if DEBUG
//
//  QAHooks.swift
//  Shared (App)
//
//  DEBUG-only QA hooks for the simulator lane (apps/apple/scripts/qa-sim.sh). Every line of this
//  file is inside `#if DEBUG`, and each call site outside this folder is too, so a Release build
//  (the only configuration archive.sh ships) contains none of it. QAHooksReleaseExclusionTests in
//  StillKit pins both, and `qa-sim.sh verify-release` checks a built Release binary for the strings.
//
//  Every hook is inert unless its launch-environment key is set (`simctl launch` passes them as
//  SIMCTL_CHILD_<KEY>), so an ordinary Debug run from Xcode behaves exactly like before.
//
//    STILL_QA_STATE      seed App Group state before the web view loads:
//                          "onboarding"  clear the onboarding gate (first-launch flow shows)
//                          "onboarded"   mark the gate complete (settings shows)
//    STILL_QA_PRESENTER  "web" or "swiftui": stands in for the Info.plist StillOnboardingPresenter
//                        value. The D12-marker check still applies, so "web" with a legacy web
//                        bundle still falls back to SwiftUI, exactly as a real Info.plist would.
//    STILL_QA_SAFARI     "enabled" / "disabled" / "unknown": the Safari extension state the app
//                        reports. Meaningful on macOS only; iOS observations are always unknown.
//    STILL_QA_TAPS       buttons to activate in order, by exact accessible name, "|" separated
//                        (e.g. "Continue|Continue"), to reach later steps without UI automation.
//    STILL_QA_LAYOUT_DUMP "1": after the page settles (and any taps), write the position dump of
//                        the page's landmark elements to Documents/still-qa/layout.json.
//    STILL_QA_SETTLE_MS  settle time before each tap and before the dump (default 2500).
//    STILL_QA_OUTPUT_DIR folder for layout.json instead of Documents/still-qa (the Mac app is not
//                        sandboxed, so its Documents folder is the person's real one).
//
//  The probe runs in its own content world ("stillQA"): it can read the DOM and click buttons, but
//  it never sees the page's globals and the page can never post to its message handler. The
//  bundled page's own "still" bridge, trust checks and navigation lockdown are untouched.
//

import Foundation
import StillKit
import WebKit

enum QAHooks {
  enum Key {
    static let state = "STILL_QA_STATE"
    static let presenter = "STILL_QA_PRESENTER"
    static let safari = "STILL_QA_SAFARI"
    static let taps = "STILL_QA_TAPS"
    static let layoutDump = "STILL_QA_LAYOUT_DUMP"
    static let settleMs = "STILL_QA_SETTLE_MS"
    static let outputDir = "STILL_QA_OUTPUT_DIR"
  }

  private static var environment: [String: String] { ProcessInfo.processInfo.environment }

  /// The value `OnboardingPresenter` reads in place of the Info.plist key, or nil (no override).
  static var presenterInfoValue: String? {
    guard let raw = environment[Key.presenter],
      OnboardingPresenterChoice(rawValue: raw) != nil
    else { return nil }
    return raw
  }

  /// The Safari extension state to report instead of asking Safari, or nil (no override).
  static var safariStatusOverride: SafariExtensionStatus? {
    switch environment[Key.safari] {
    case "enabled": return .enabled
    case "disabled": return .disabled
    case "unknown": return .unknown
    default: return nil
    }
  }

  /// Seeds App Group state and installs the layout probe. Call before the web view loads.
  @MainActor static func prepare(webView: WKWebView) {
    seedState(OnboardingGate.appGroupDefaults())
    installProbe(on: webView)
  }

  /// Applies `STILL_QA_STATE` to the given defaults. Unknown or absent values change nothing.
  static func seedState(_ defaults: UserDefaults) {
    switch environment[Key.state] {
    case "onboarding": OnboardingGate.reset(defaults)
    case "onboarded": OnboardingGate.markComplete(defaults)
    default: break
    }
  }

  /// Where layout.json goes: STILL_QA_OUTPUT_DIR, else the app's Documents/still-qa.
  private static var outputFolder: URL? {
    if let custom = environment[Key.outputDir], !custom.isEmpty {
      return URL(fileURLWithPath: custom, isDirectory: true)
    }
    return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
      .appendingPathComponent("still-qa", isDirectory: true)
  }

  @MainActor private static func installProbe(on webView: WKWebView) {
    let taps = (environment[Key.taps] ?? "").split(separator: "|").map(String.init).filter { !$0.isEmpty }
    let dump = environment[Key.layoutDump] == "1"
    guard dump || !taps.isEmpty else { return }
    let settle = Int(environment[Key.settleMs] ?? "") ?? 2500
    let config: [String: Any] = ["settleMs": max(0, settle), "taps": taps, "dump": dump]
    guard let data = try? JSONSerialization.data(withJSONObject: config),
      let json = String(data: data, encoding: .utf8)
    else { return }
    let world = WKContentWorld.world(name: "stillQA")
    let controller = webView.configuration.userContentController
    controller.add(QALayoutSink(folder: outputFolder), contentWorld: world, name: "stillQA")
    controller.addUserScript(WKUserScript(
      source: QALayoutProbe.source.replacingOccurrences(of: "__STILL_QA_CONFIG__", with: json),
      injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
  }
}

/// Receives the probe's report and writes layout.json. On a simulator the default folder is inside
/// the app's own container, where `xcrun simctl get_app_container <device> com.chartash.still data`
/// finds it.
final class QALayoutSink: NSObject, WKScriptMessageHandler {
  private let folder: URL?
  init(folder: URL?) { self.folder = folder }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "stillQA", let report = message.body as? String, let folder else { return }
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try? Data(report.utf8).write(to: folder.appendingPathComponent("layout.json"), options: .atomic)
  }
}

/// The position-dump probe. One source for both lanes: `qa-sim.sh probe-js` prints the text between
/// the markers so the WebKit bundle lane (T2) can run the identical probe and compare JSON.
enum QALayoutProbe {
  static let source = #"""
  // QA-LAYOUT-PROBE-BEGIN
  (async () => {
    const config = __STILL_QA_CONFIG__;
    // Page errors are reported with the dump, so a capture of a page that failed to render can
    // never pass as a real state. (Error events reach listeners in every content world.)
    const errors = [];
    addEventListener("error", (event) => errors.push(String(event.message || event.type)));
    addEventListener("unhandledrejection", (event) => errors.push(`unhandled: ${String(event.reason)}`));
    if (document.readyState === "loading")
      await new Promise((resolve) => addEventListener("DOMContentLoaded", resolve, { once: true }));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const round = (n) => Math.round(n * 100) / 100;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nameOf = (el) =>
      (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const LANDMARKS = "h1,h2,h3,h4,p,button,a,label,input,li,img,svg,[role]";
    const ACTIONS = "button,[role=button],[role=switch],[role=link],a";
    const collect = () => ({
      schema: 1,
      path: location.pathname.split("/").pop(),
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        readyState: document.readyState,
        elements: document.querySelectorAll("body *").length,
        errors,
      },
      boxes: [...document.querySelectorAll(LANDMARKS)].filter(visible).map((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          name: nameOf(el),
          x: round(r.left + scrollX),
          y: round(r.top + scrollY),
          width: round(r.width),
          height: round(r.height),
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
        };
      }),
    });
    const tapped = [];
    try { await document.fonts.ready; } catch {}
    await sleep(config.settleMs);
    for (const label of config.taps) {
      const target = [...document.querySelectorAll(ACTIONS)].find((el) => visible(el) && nameOf(el) === label);
      tapped.push({ label, found: Boolean(target) });
      if (!target) break;
      target.click();
      await sleep(config.settleMs);
    }
    if (!config.dump) return;
    const report = JSON.stringify({ ...collect(), taps: tapped });
    // In the app the report goes to the QA handler; elsewhere (the WebKit bundle lane, which runs
    // this same text from `qa-sim.sh probe-js`) it is left on the page for the runner to read.
    const sink = window.webkit?.messageHandlers?.stillQA;
    if (sink) sink.postMessage(report);
    else globalThis.__stillQALayout = report;
  })();
  // QA-LAYOUT-PROBE-END
  """#
}
#endif
