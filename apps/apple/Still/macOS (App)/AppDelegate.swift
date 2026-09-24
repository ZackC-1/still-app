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

}
