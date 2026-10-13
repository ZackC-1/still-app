//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by Zack Chartash on 6/24/26.
//

import Cocoa
import StillKit

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Before anything this launch writes to the App Group: did Still run here before? Analytics
        // uses it to report an update rather than a new install (AnalyticsIdentity.swift).
        AnalyticsIdentityStore.earlierInstallAtLaunch =
            AnalyticsIdentityStore.earlierInstallEvidence(InstallGeneration.appGroupDefaults())
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        var accepted = false
        for url in urls where StillAppRoute.receive(url) { accepted = true }
        // The Safari popup's Get Still Pro / Sign in opened this link. Since macOS 14 the extension
        // cannot bring Still to the front itself, so a Still that was already running (or launched
        // behind Safari) would show its screen out of sight. Only a fixed route asks to come forward.
        if accepted { Self.bringForward(application) }
    }

    private static func bringForward(_ application: NSApplication) {
        if #available(macOS 14.0, *) {
            application.activate()
        } else {
            application.activate(ignoringOtherApps: true)
        }
        if let window = application.windows.first(where: { $0.canBecomeMain }) {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
    }

}
