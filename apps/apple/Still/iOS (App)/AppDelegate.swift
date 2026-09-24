//
//  AppDelegate.swift
//  iOS (App)
//
//  Created by Zack Chartash on 6/24/26.
//

import UIKit
import StillKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Before anything this launch writes to the App Group: did Still run here before? Analytics
        // uses it to report an update rather than a new install (AnalyticsIdentity.swift).
        AnalyticsIdentityStore.earlierInstallAtLaunch =
            AnalyticsIdentityStore.earlierInstallEvidence(InstallGeneration.appGroupDefaults())
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

}
