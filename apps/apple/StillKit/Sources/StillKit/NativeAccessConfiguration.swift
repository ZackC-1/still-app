import Foundation

/// Only code-signed native bundle configuration supplies endpoints and public-key trust.
/// JS requests cannot choose an environment, endpoint, public key or paid mode.
public enum NativeAccessConfiguration {
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

public final class NativeAccessSessionVerifier {
  private let endpoint: URL
  private let publicKey: String
  init(baseURL: URL, publicKey: String) {
    endpoint = baseURL.appendingPathComponent("auth/v1/user"); self.publicKey = publicKey
  }
  public func verify(accessToken: String) async -> VerifiedNativeAccessSession? {
    guard accessJWTPayload(accessToken) != nil else { return nil }
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
      let http = response as? HTTPURLResponse, http.statusCode == 200, http.url == endpoint
    else { return nil }
    return VerifiedNativeAccessSession.validated(userReply: data, acceptedToken: accessToken)
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
