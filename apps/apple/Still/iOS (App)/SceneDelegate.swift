//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by Zack Chartash on 6/24/26.
//

import UIKit
import StillKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }
        for context in connectionOptions.urlContexts { StillProRoute.receive(context.url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { StillProRoute.receive(context.url) }
    }

}
