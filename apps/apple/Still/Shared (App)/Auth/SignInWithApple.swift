//
//  SignInWithApple.swift
//  Shared (App)
//
//  Native Sign in with Apple (U19) — the Apple-only sign-in path (other hosts use the email magic
//  link). Presents the Apple sheet and returns the identity token + the raw nonce; the caller forwards
//  both to Supabase's `id_token` grant to mint a Supabase session, whose UUID becomes the RevenueCat
//  app_user_id (KTD5). The nonce is sent to Apple as its SHA-256 and to Supabase in the raw, so the
//  backend can bind the token to this request (replay protection).
//

import AuthenticationServices
import CryptoKit
import Foundation

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
final class SignInWithAppleCoordinator: NSObject {
  struct AppleCredential {
    let identityToken: String
    let rawNonce: String
    let email: String?
    let fullName: String?
  }

  enum SIWAError: LocalizedError {
    case cancelled
    case noIdentityToken
    case failed(String)

    var errorDescription: String? {
      switch self {
      case .cancelled: return "Sign in was cancelled."
      case .noIdentityToken: return "Apple did not return an identity token."
      case .failed(let message): return message
      }
    }
  }

  private var continuation: CheckedContinuation<AppleCredential, Error>?
  private var currentNonce: String?

  /// Present the Apple sheet and await the credential. One in-flight request at a time.
  func signIn() async throws -> AppleCredential {
    let nonce = Self.randomNonceString()
    currentNonce = nonce

    let request = ASAuthorizationAppleIDProvider().createRequest()
    request.requestedScopes = [.fullName, .email]
    request.nonce = Self.sha256(nonce)

    return try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let controller = ASAuthorizationController(authorizationRequests: [request])
      controller.delegate = self
      controller.presentationContextProvider = self
      controller.performRequests()
    }
  }

  // MARK: Nonce

  private static func randomNonceString(length: Int = 32) -> String {
    let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
    var result = ""
    var remaining = length
    while remaining > 0 {
      var random: UInt8 = 0
      let status = SecRandomCopyBytes(kSecRandomDefault, 1, &random)
      if status == errSecSuccess, random < charset.count * (256 / charset.count) {
        result.append(charset[Int(random) % charset.count])
        remaining -= 1
      }
    }
    return result
  }

  private static func sha256(_ input: String) -> String {
    SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

extension SignInWithAppleCoordinator: ASAuthorizationControllerDelegate {
  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    defer { continuation = nil; currentNonce = nil }
    guard
      let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
      let tokenData = credential.identityToken,
      let token = String(data: tokenData, encoding: .utf8)
    else {
      continuation?.resume(throwing: SIWAError.noIdentityToken)
      return
    }
    let name = credential.fullName.flatMap { components -> String? in
      let formatter = PersonNameComponentsFormatter()
      let formatted = formatter.string(from: components)
      return formatted.isEmpty ? nil : formatted
    }
    continuation?.resume(returning: AppleCredential(
      identityToken: token,
      rawNonce: currentNonce ?? "",
      email: credential.email,
      fullName: name
    ))
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithError error: Error
  ) {
    defer { continuation = nil; currentNonce = nil }
    if let authError = error as? ASAuthorizationError, authError.code == .canceled {
      continuation?.resume(throwing: SIWAError.cancelled)
    } else {
      continuation?.resume(throwing: SIWAError.failed(error.localizedDescription))
    }
  }
}

extension SignInWithAppleCoordinator: ASAuthorizationControllerPresentationContextProviding {
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    #if os(iOS)
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
    #elseif os(macOS)
    return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
    #endif
  }
}
