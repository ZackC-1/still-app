import Foundation

/// Only code-signed native bundle configuration supplies endpoints and public-key trust.
/// JS requests cannot choose an environment, endpoint, public key or paid mode.
public enum NativeAccessConfiguration {
  public enum BackendRouteProfile: String, Sendable {
    case production
    case sharedHostedSandbox = "shared-hosted-sandbox"

    public var environment: String { self == .production ? "production" : "sandbox" }
    public var policyPath: String {
      self == .production ? "/functions/v1/product-policy" : "/functions/v1/qa-sandbox-product-policy"
    }
  }

  /// Route selection is a separate code-signed build input. Missing selection is only the
  /// ordinary production default; sandbox trust never silently selects production routes.
  public static func backendRouteProfile(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> BackendRouteProfile? {
    let environment: String
    if let value = info["StillAccessEnvironment"] {
      guard let text = value as? String, ["production", "sandbox"].contains(text) else { return nil }
      environment = text
    } else { environment = "production" }
    let profile: BackendRouteProfile
    if let value = info["StillBackendRouteProfile"] {
      guard let text = value as? String, let parsed = BackendRouteProfile(rawValue: text) else { return nil }
      profile = parsed
    } else { profile = .production }
    return profile.environment == environment ? profile : nil
  }

  /// The ordinary rating path remains unconfigured. Only a complete compiled QA trust/Auth
  /// configuration supplies its public policy origin; this does not verify a provider or purchase.
  public static func ratingPolicySupabaseURL(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> String? {
    guard backendRouteProfile(info: info) == .sharedHostedSandbox,
      !trust(info: info).keys.isEmpty, sessionVerifier(info: info) != nil
    else { return nil }
    return info["StillAccessSupabaseURL"] as? String
  }

  public static func trust(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> AccessTrust {
    let environment = info["StillAccessEnvironment"] as? String ?? "production"
    guard ["production", "sandbox"].contains(environment)
    else { return AccessTrust(environment: "production", keys: []) }
    guard let rows = info["StillAccessTrustKeys"] as? [[String: String]], rows.count <= 16
    else { return AccessTrust(environment: environment, keys: []) }
    var keys: [AccessTrust.Key] = []
    for row in rows {
      guard Set(row.keys) == Set(["kid", "publicKeyHex", "environment", "purpose"]),
        let kid = row["kid"], kid.range(of: "^[a-z0-9][a-z0-9._-]{0,95}$", options: .regularExpression) != nil,
        !keys.contains(where: { $0.kid == kid }), row["environment"] == environment, row["purpose"] == "access",
        let hex = row["publicKeyHex"], hex.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
      else { return AccessTrust(environment: environment, keys: []) }
      let bytes = stride(from: 0, to: 64, by: 2).map { offset -> UInt8 in
        let start = hex.index(hex.startIndex, offsetBy: offset)
        return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
      }
      keys.append(.init(kid: kid, publicKey: Data(bytes), environment: environment))
    }
    return AccessTrust(environment: environment, keys: keys)
  }

  public static func sessionVerifier(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> NativeAccessSessionVerifier? {
    guard let text = info["StillAccessSupabaseURL"] as? String,
      let url = URL(string: text), url.scheme == "https", url.host != nil,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      ["", "/"].contains(url.path),
      let key = info["StillAccessSupabasePublishableKey"] as? String,
      publicClientKey(key)
    else { return nil }
    return NativeAccessSessionVerifier(baseURL: url, publicKey: key)
  }

  private static func publicClientKey(_ value: String) -> Bool {
    if value.hasPrefix("sb_publishable_") {
      return value.utf8.count <= 1_024 && value.range(of: "^sb_publishable_[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
    guard let payload = accessJWTPayload(value), payload["role"] as? String == "anon" else { return false }
    return true
  }
}

extension AccessTrust {
  public static var compiled: AccessTrust { NativeAccessConfiguration.trust() }
}

/// Created only after the trusted native auth endpoint accepted this exact access token.
public struct VerifiedNativeAccessSession {
  public let accountId: String
  public let sessionId: String
  private init(accountId: String, sessionId: String) { self.accountId = accountId; self.sessionId = sessionId }
  static func validated(userReply: Data, acceptedToken: String) -> VerifiedNativeAccessSession? {
    guard userReply.count <= 65_536,
      let user = try? JSONSerialization.jsonObject(with: userReply) as? [String: Any],
      let id = user["id"] as? String, accessUUID(id),
      let confirmed = user["email_confirmed_at"] as? String, !confirmed.isEmpty,
      let payload = accessJWTPayload(acceptedToken), payload["sub"] as? String == id,
      let sessionId = payload["session_id"] as? String, accessUUID(sessionId)
    else { return nil }
    return VerifiedNativeAccessSession(accountId: id, sessionId: sessionId)
  }
}

/// Hosted Auth's answer about one access token.
public enum NativeAccessSessionCheck {
  case verified(VerifiedNativeAccessSession)
  /// Auth definitively refused the token's account or session: the account was deleted, the
  /// session was revoked or signed out, or the user is banned. `subject` is the token's own,
  /// unverified `sub`; it only scopes which bound account the refusal may end.
  case rejected(subject: String?)
  /// Offline, timeout, redirect, server error, an expired or malformed token, an unconfirmed
  /// email, or any other answer. Callers keep what is stored.
  case unavailable

  /// Only these documented Auth error codes, on a 401/403/404, end an account's stored rights.
  /// An expired token ("bad_jwt") is not one of them: the account may be fine. Both Auth error
  /// formats are read: the default `{"code":403,"error_code":"…","msg":…}` and the
  /// `X-Supabase-Api-Version: 2024-01-01` form `{"code":"…","message":…}`. Anything else is not
  /// a refusal.
  static let definitiveErrorCodes: Set<String> = ["user_not_found", "session_not_found", "user_banned"]
  static func isDefinitiveRejection(status: Int, body: Data) -> Bool {
    guard [401, 403, 404].contains(status), body.count <= 65_536,
      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let code = (object["error_code"] as? String) ?? (object["code"] as? String)
    else { return false }
    return definitiveErrorCodes.contains(code)
  }
}

public final class NativeAccessSessionVerifier {
  private let endpoint: URL
  private let publicKey: String
  init(baseURL: URL, publicKey: String) {
    endpoint = baseURL.appendingPathComponent("auth/v1/user"); self.publicKey = publicKey
  }
  public func verify(accessToken: String) async -> VerifiedNativeAccessSession? {
    if case .verified(let session) = await check(accessToken: accessToken) { return session }
    return nil
  }

  public func check(accessToken: String) async -> NativeAccessSessionCheck {
    guard let payload = accessJWTPayload(accessToken) else { return .unavailable }
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil; config.httpCookieStorage = nil
    config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 10
    let session = URLSession(configuration: config, delegate: RefuseAccessRedirects(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.setValue("Bearer " + accessToken, forHTTPHeaderField: "Authorization")
    request.setValue(publicKey, forHTTPHeaderField: "apikey")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    guard let (data, response) = try? await session.data(for: request),
      let http = response as? HTTPURLResponse, http.url == endpoint
    else { return .unavailable }
    guard http.statusCode == 200 else {
      return NativeAccessSessionCheck.isDefinitiveRejection(status: http.statusCode, body: data)
        ? .rejected(subject: payload["sub"] as? String) : .unavailable
    }
    return VerifiedNativeAccessSession.validated(userReply: data, acceptedToken: accessToken).map { .verified($0) } ?? .unavailable
  }
}

private final class RefuseAccessRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

private func accessJWTPayload(_ token: String) -> [String: Any]? {
  guard token.utf8.count <= 16_384,
    token.range(of: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$", options: .regularExpression) != nil
  else { return nil }
  let segment = String(token.split(separator: ".")[1])
  guard segment.count % 4 != 1 else { return nil }
  let padded = segment.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") +
    String(repeating: "=", count: (4 - segment.count % 4) % 4)
  guard let data = Data(base64Encoded: padded), data.count <= 12_288 else { return nil }
  return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}
