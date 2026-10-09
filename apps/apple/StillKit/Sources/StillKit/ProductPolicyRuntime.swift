import Foundation

/// The Apple app's client for the remote product policy (U6). Its only consumer is the rating path
/// (U13-P3): the app's `RatingPromptPresenter` constructs it and asks `freshCheck(.rating)` once per
/// locally eligible app opening. Ordinary builds retain no rating project URL; a complete compiled
/// shared-hosted-sandbox profile selects only the fixed QA policy function.
/// Nothing asks it about sales.
///
/// Before a purchase may start or a review prompt may be requested, the app asks the public
/// `product-policy` function one fresh question and evaluates the answer with the shared fail-safe
/// evaluator (`ProductPolicy`). Free blocking, free sync and Restore never consult any of this
/// (owner decision 17: Restore is shown and works whatever the policy says).
///
/// The Safari extension does not fetch policy: Safari maps to its Apple host surface, and purchases,
/// Restore and the rating sheet all run in the app. This runtime is the one Apple copy.
///
/// Rules, each pinned by `ProductPolicyRuntimeTests`:
/// - One plain request: POST {"namespace","environment"} to the configured project's origin, no
///   query string, no account, install or device identifier, no session token, no API key (the
///   function is public), an ephemeral session with no cache, cookies or credentials, no redirects,
///   and a 5 second limit. Nothing schedules it: a check runs only when a caller asks for one.
/// - The body is kept as raw bytes, capped one byte past the grammar's limit, and lives only in
///   memory for the one evaluation that requested it. It is never stored, so it cannot be replayed.
/// - The only stored value, in the App Group, is per namespace the highest revision ever accepted,
///   raised with max() only after an accepted verdict. A cached value never authorizes anything.
/// - Offline, timed out, failed, missing, invalid, late or stale is Off.
public final class ProductPolicyRuntime: @unchecked Sendable {
  public static let path = "/functions/v1/product-policy"
  public static let timeoutSeconds: TimeInterval = 5

  typealias Evaluator = (ProductPolicy.Namespace, ProductPolicy.Context, ProductPolicy.Response?, Int, @escaping () -> Int) -> ProductPolicy.Verdict

  private let endpoint: URL?
  private let routeProfile: NativeAccessConfiguration.BackendRouteProfile?
  private let context: ProductPolicy.Context
  private let store: ProductPolicyRevisionStore
  private let transport: ProductPolicyTransport
  private let now: () -> Int
  private let evaluate: Evaluator

  /// `supabaseURL` is the build's configured project URL; only its origin is used, and absent or
  /// malformed means no request is ever made and every check is Off. The QA profile requires an
  /// HTTPS origin and a matching sandbox context. `now` is monotonic
  /// milliseconds (defaults to system uptime).
  public convenience init(supabaseURL: String?, environment: String, surface: String, build: String,
                          routeProfile: NativeAccessConfiguration.BackendRouteProfile? = .production,
                          store: ProductPolicyRevisionStore,
                          transport: ProductPolicyTransport = URLSessionPolicyTransport(),
                          now: @escaping () -> Int = ProductPolicyRuntime.uptimeMilliseconds) {
    self.init(supabaseURL: supabaseURL, context: ProductPolicy.Context(environment: environment, surface: surface, build: build),
              routeProfile: routeProfile,
              store: store, transport: transport, now: now, evaluate: ProductPolicyRuntime.packagedEvaluator)
  }

  init(supabaseURL: String?, context: ProductPolicy.Context,
       routeProfile: NativeAccessConfiguration.BackendRouteProfile? = .production, store: ProductPolicyRevisionStore,
       transport: ProductPolicyTransport, now: @escaping () -> Int, evaluate: @escaping Evaluator) {
    self.endpoint = ProductPolicyRuntime.endpoint(supabaseURL, routeProfile: routeProfile)
    self.routeProfile = routeProfile
    self.context = context
    self.store = store
    self.transport = transport
    self.now = now
    self.evaluate = evaluate
  }

  /// A sandbox route or sandbox policy context may only charge inside Apple's sandbox.
  public var requiresSandboxInstallation: Bool { routeProfile == .sharedHostedSandbox || context.environment == "sandbox" }

  /// The public evaluators, which read the compiled paid switch themselves.
  static let packagedEvaluator: Evaluator = { namespace, context, response, highestSeen, now in
    switch namespace {
    case .sales: return ProductPolicy.evaluateSales(context, response, highestSeenRevision: highestSeen, now: now)
    case .rating: return ProductPolicy.evaluateRating(context, response, highestSeenRevision: highestSeen, now: now)
    }
  }

  public static func uptimeMilliseconds() -> Int {
    Int(DispatchTime.now().uptimeNanoseconds / 1_000_000)
  }

  /// The function URL on the configured project's origin, or nil when the build has none.
  public static func endpoint(_ supabaseURL: String?, routeProfile: NativeAccessConfiguration.BackendRouteProfile? = .production) -> URL? {
    let trimmed = supabaseURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard let routeProfile, !trimmed.isEmpty, let parsed = URLComponents(string: trimmed),
          let scheme = parsed.scheme?.lowercased(), scheme == "https" || scheme == "http",
          let host = parsed.host, !host.isEmpty, parsed.user == nil, parsed.password == nil else { return nil }
    if routeProfile == .sharedHostedSandbox {
      guard scheme == "https", ["", "/"].contains(parsed.path), parsed.query == nil, parsed.fragment == nil else { return nil }
    }
    var origin = URLComponents()
    origin.scheme = scheme
    origin.host = host
    origin.port = parsed.port
    origin.path = routeProfile.policyPath
    return origin.url
  }

  /// The one request shape. Exactly one header; no identifier, token or key.
  static func request(_ endpoint: URL, namespace: ProductPolicy.Namespace, environment: String) -> URLRequest {
    var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeoutSeconds)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{\"namespace\":\"\(namespace.rawValue)\",\"environment\":\"\(environment)\"}".utf8)
    return request
  }

  private static func accepted(_ verdict: ProductPolicy.Verdict) -> Bool {
    verdict.revision != nil && [.on, .off, .build].contains(verdict.reason)
  }

  /// One fresh online check. Never throws; anything but a fresh, valid, current, allowlisted On is Off.
  public func freshCheck(_ namespace: ProductPolicy.Namespace) async -> ProductPolicy.Verdict {
    guard let routeProfile, routeProfile.environment == context.environment else { return ProductPolicy.Verdict(.context) }
    // The packaged context decides some verdicts by itself (with the shipped compiled switch, every
    // sales check). Those never make a request.
    let packaged = evaluate(namespace, context, nil, 0, now)
    if [.context, .compiledOff, .deferredSurface].contains(packaged.reason) { return packaged }
    guard let endpoint else { return ProductPolicy.Verdict(.missing) }
    guard let highestSeen = store.highestSeenRevision(namespace) else { return ProductPolicy.Verdict(.context) }
    let startedAt = now()
    var body: Data?
    do {
      let reply = try await transport.send(Self.request(endpoint, namespace: namespace, environment: context.environment),
                                           maxBytes: ProductPolicy.maxBytes)
      if reply.status == 200 { body = reply.body.prefix(ProductPolicy.maxBytes + 1) }
    } catch {
      body = nil
    }
    let verdict = evaluate(namespace, context, ProductPolicy.Response(body: body, requestStartedAt: startedAt), highestSeen, now)
    // Only accepted verdicts move the fence; "stale" and every failure leave it untouched.
    guard Self.accepted(verdict), let revision = verdict.revision else { return verdict }
    // The fence is re-read inside the store's lock: a concurrent check may have accepted a newer
    // revision while this one was in flight, and then this answer is stale, never returned.
    switch store.raise(namespace, to: revision) {
    case .current: return verdict
    case .stale: return ProductPolicy.Verdict(.stale, revision: revision)
    // An On that cannot be fenced is not an On.
    case .unreadable: return ProductPolicy.Verdict(.context)
    }
  }
}

/// The highest accepted policy revision per namespace, in the App Group. The only thing this
/// feature stores. Absent is 0; anything unreadable is nil, which every check treats as Off.
public final class ProductPolicyRevisionStore: @unchecked Sendable {
  private let defaults: UserDefaults
  private let lock = NSLock()

  public init(defaults: UserDefaults) { self.defaults = defaults }

  /// The shared App Group store, or nil when this process has no container for the group (then no
  /// check can be fenced, so every check is Off). `UserDefaults(suiteName:)` alone cannot tell: for a
  /// group the process is not entitled to, it usually returns a private, non-shared domain rather
  /// than nil, so the container is checked first.
  public static func appGroup(_ identifier: String = StillAppGroup.identifier,
                              container: (String) -> URL? = { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) })
    -> ProductPolicyRevisionStore? {
    guard container(identifier) != nil, let defaults = UserDefaults(suiteName: identifier) else { return nil }
    return ProductPolicyRevisionStore(defaults: defaults)
  }

  static func key(_ namespace: ProductPolicy.Namespace) -> String {
    "still.productPolicy.\(namespace.rawValue).highestSeenRevision.v1"
  }

  public func highestSeenRevision(_ namespace: ProductPolicy.Namespace) -> Int? {
    lock.lock(); defer { lock.unlock() }
    return read(namespace)
  }

  enum RaiseResult: Equatable { case current, stale, unreadable }

  /// Persist max(previous, revision). `.stale` when a newer revision is already fenced (the caller's
  /// answer must not be returned), `.unreadable` when the stored value or the revision is invalid.
  func raise(_ namespace: ProductPolicy.Namespace, to revision: Int) -> RaiseResult {
    lock.lock(); defer { lock.unlock() }
    guard let previous = read(namespace), revision >= 0, revision <= ProductPolicy.maxSafeInteger else { return .unreadable }
    if previous > revision { return .stale }
    if revision > previous { defaults.set(revision, forKey: Self.key(namespace)) }
    return .current
  }

  private func read(_ namespace: ProductPolicy.Namespace) -> Int? {
    guard let object = defaults.object(forKey: Self.key(namespace)) else { return 0 }
    // A Boolean also bridges to NSNumber; only a real integer counts.
    guard let number = object as? NSNumber, CFGetTypeID(number as CFTypeRef) == CFNumberGetTypeID(),
          !CFNumberIsFloatType(number as CFNumber), let value = Int(exactly: number),
          value >= 0, value <= ProductPolicy.maxSafeInteger else { return nil }
    return value
  }
}

/// One HTTP exchange: the status and at most `maxBytes + 1` raw body bytes. Throws on failure.
public protocol ProductPolicyTransport: Sendable {
  func send(_ request: URLRequest, maxBytes: Int) async throws -> (status: Int, body: Data)
}

/// The production transport: an ephemeral session with no cache, cookie or credential storage,
/// a 5 second limit, and redirects refused. The session is created once, in init, with a separate
/// delegate (so it never retains the transport), and is invalidated when the transport goes away.
public final class URLSessionPolicyTransport: ProductPolicyTransport, @unchecked Sendable {
  let session: URLSession

  public convenience init() { self.init(configuration: URLSessionPolicyTransport.configuration()) }

  /// Internal so tests can add a stub `URLProtocol` to the production configuration.
  init(configuration: URLSessionConfiguration) {
    session = URLSession(configuration: configuration, delegate: RedirectRefusal(), delegateQueue: nil)
  }

  deinit { session.finishTasksAndInvalidate() }

  static func configuration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.timeoutIntervalForRequest = ProductPolicyRuntime.timeoutSeconds
    configuration.timeoutIntervalForResource = ProductPolicyRuntime.timeoutSeconds
    return configuration
  }

  public func send(_ request: URLRequest, maxBytes: Int) async throws -> (status: Int, body: Data) {
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    guard http.statusCode == 200 else {
      bytes.task.cancel()
      return (http.statusCode, Data())
    }
    var body = Data()
    for try await byte in bytes {
      body.append(byte)
      if body.count > maxBytes { bytes.task.cancel(); break }
    }
    return (200, body)
  }
}

/// Refuses every redirect: the 3xx itself becomes the final response, which is Off.
final class RedirectRefusal: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
