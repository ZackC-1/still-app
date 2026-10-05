import Foundation
import XCTest
@testable import StillKit

/// The real production transport, driven through a stub `URLProtocol` added to its own
/// configuration. No network: every request is answered by `StubProtocol`.
final class URLSessionPolicyTransportTests: XCTestCase {
  final class StubProtocol: URLProtocol {
    struct Answer { let status: Int; let headers: [String: String]; let chunks: [Data] }
    private static let lock = NSLock()
    private static var answers: [String: Answer] = [:]
    private static var seen: [String] = []

    static func reset(_ answers: [String: Answer]) {
      lock.lock(); defer { lock.unlock() }
      self.answers = answers
      seen = []
    }
    static var requested: [String] { lock.lock(); defer { lock.unlock() }; return seen }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      let url = request.url!
      let answer: Answer? = {
        Self.lock.lock(); defer { Self.lock.unlock() }
        Self.seen.append(url.absoluteString)
        return Self.answers[url.absoluteString]
      }()
      guard let answer, let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1",
                                                        headerFields: answer.headers) else {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        return
      }
      if (300..<400).contains(answer.status), let location = answer.headers["Location"], let target = URL(string: location) {
        client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
      }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      for chunk in answer.chunks { client?.urlProtocol(self, didLoad: chunk) }
      client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
  }

  private let endpoint = "https://project.example/functions/v1/product-policy"
  private let elsewhere = "https://elsewhere.example/policy"

  private func transport() -> URLSessionPolicyTransport {
    let configuration = URLSessionPolicyTransport.configuration()
    configuration.protocolClasses = [StubProtocol.self]
    return URLSessionPolicyTransport(configuration: configuration)
  }

  private func request() -> URLRequest {
    ProductPolicyRuntime.request(URL(string: endpoint)!, namespace: .rating, environment: "production")
  }

  func testRedirectIsRefusedAndItsTargetIsNeverRequested() async throws {
    StubProtocol.reset([
      endpoint: .init(status: 302, headers: ["Location": elsewhere], chunks: []),
      elsewhere: .init(status: 200, headers: [:], chunks: [Data("{\"schema\":1}".utf8)]),
    ])
    let reply = try await transport().send(request(), maxBytes: 100)
    XCTAssertEqual(reply.status, 302)
    XCTAssertEqual(reply.body, Data())
    XCTAssertEqual(StubProtocol.requested, [endpoint])
  }

  func testOversizedBodyStopsOneBytePastTheCap() async throws {
    let chunks = (0..<40).map { _ in Data(repeating: 0x20, count: 256) }
    StubProtocol.reset([endpoint: .init(status: 200, headers: [:], chunks: chunks)])
    let reply = try await transport().send(request(), maxBytes: 100)
    XCTAssertEqual(reply.status, 200)
    XCTAssertEqual(reply.body.count, 101)
  }

  func testWholeBodyWithinTheCapIsReturnedAsRawBytes() async throws {
    let bytes = Data([0xef, 0xbb, 0xbf, 0x7b, 0x7d])
    StubProtocol.reset([endpoint: .init(status: 200, headers: [:], chunks: [bytes])])
    let reply = try await transport().send(request(), maxBytes: 100)
    XCTAssertEqual(reply.body, bytes)
  }

  func testNon200GivesAnEmptyBody() async throws {
    StubProtocol.reset([endpoint: .init(status: 503, headers: [:], chunks: [Data("{\"schema\":1}".utf8)])])
    let reply = try await transport().send(request(), maxBytes: 100)
    XCTAssertEqual(reply.status, 503)
    XCTAssertEqual(reply.body, Data())
  }

  /// The session's delegate is a separate object, so the session never retains the transport and
  /// deinit (which invalidates the session) actually runs.
  func testSessionDoesNotRetainTheTransport() async throws {
    StubProtocol.reset([endpoint: .init(status: 404, headers: [:], chunks: [])])
    weak var released: URLSessionPolicyTransport?
    do {
      let transport = transport()
      released = transport
      _ = try await transport.send(request(), maxBytes: 100)
    }
    XCTAssertNil(released)
  }
}
