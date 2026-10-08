import Foundation
import XCTest
@testable import StillKit

/// The two halves of the paid-tier switch live in different languages and different build systems,
/// so nothing but a test can stop them drifting apart. These read the shipped source text on
/// purpose rather than a compiled value, because the TypeScript half is not reachable from Swift.
final class MonetizationConfigTests: XCTestCase {
  private var repositoryRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  /// A deliberate tripwire, not a mistake if it fails. The paid tier is dormant, so this build
  /// must ship with the switch off; anyone turning it back on changes this expectation in the same
  /// commit and thereby says out loud that the change was intended.
  func testPaidTierShipsDormant() {
    XCTAssertFalse(
      MonetizationConfig.paidTierEnabled,
      "the paid tier is dormant: update this expectation in the commit that turns it back on"
    )
  }

  func testSwiftSwitchMatchesSharedTypeScriptSwitch() throws {
    let sourceURL = repositoryRoot
      .appendingPathComponent("packages/shared-types/src/entitlement.ts")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)
    let sharedSwitch: Bool
    if source.contains("export const PAID_TIER_ENABLED = true;") {
      sharedSwitch = true
    } else {
      XCTAssertTrue(
        source.contains("export const PAID_TIER_ENABLED = false;"),
        "the shared paid-tier switch must remain a literal boolean"
      )
      sharedSwitch = false
    }

    XCTAssertEqual(MonetizationConfig.paidTierEnabled, sharedSwitch)
  }

  /// Checks the property rather than a count of guards, so that adding an unrelated guard to this
  /// router later cannot fail this test with a message about purchases.
  ///
  /// It asserts the refusal comes BEFORE the StoreKit call, inside that action's own arm of the
  /// switch. An earlier version asked only whether the guard appeared somewhere after
  /// `case "purchase":`, and when it could not find where that arm ended it fell back to the whole
  /// rest of the file. Deleting the purchase guard and re-indenting the switch, which is all a
  /// reformat or one more level of nesting would do, left it green while matching the neighbouring
  /// restore arm's guard: a test about money, passing on a router that could charge for something.
  /// So this one refuses to guess, and every failure names what it could not find.
  func testPurchaseAndRestoreBridgeActionsBothUseTheAppleSwitch() throws {
    let source = try routerSource()
    let storeKitCallPerAction = [
      (action: "purchase", call: "self.purchases.purchaseStillPro {"),
      (action: "restore", call: "self.purchases.restore {"),
    ]
    for (action, storeKitCall) in storeKitCallPerAction {
      let block = try XCTUnwrap(
        bridgeActionBody(named: action, in: source),
        "this test can no longer find the \"\(action)\" arm of the router's switch"
      )
      let call = try XCTUnwrap(
        block.range(of: storeKitCall),
        "the \"\(action)\" action no longer reaches StoreKit through \(storeKitCall): "
          + "point this test at the call it makes now"
      )
      XCTAssertTrue(
        block[block.startIndex..<call.lowerBound]
          .contains("guard MonetizationConfig.paidTierEnabled else"),
        "the \"\(action)\" action must be refused while paid access is dormant, before it reaches "
          + "StoreKit"
      )
    }
  }

  /// While the paid tier is off, the Restore tap runs the free-period check and nothing else that
  /// could sell or touch the RevenueCat identity. The refusal's else branch is read on its own: it
  /// must run the read-only check and must not reach PurchaseManager or RevenueCat directly, with
  /// or without an explicit `self.`. The router helpers it calls, and the helpers those call, are
  /// read the same way: their only PurchaseManager call may be the read-only receipt read, and that
  /// read itself is checked to stay on StoreKit's transaction history.
  func testTheFreePeriodRestoreBranchRunsOnlyTheReadOnlyCheck() throws {
    let source = try routerSource()
    let arm = try XCTUnwrap(
      bridgeActionBody(named: "restore", in: source),
      "this test can no longer find the \"restore\" arm of the router's switch"
    )
    let refusal = try XCTUnwrap(
      arm.range(of: "guard MonetizationConfig.paidTierEnabled else {"),
      "the restore arm no longer starts with the paid-tier guard"
    )
    let afterGuard = arm[refusal.upperBound...]
    let close = try XCTUnwrap(
      afterGuard.range(of: "\n      }\n"),
      "this test can no longer find where the restore arm's free-period branch ends"
    )
    let branch = String(afterGuard[afterGuard.startIndex..<close.lowerBound])
    XCTAssertTrue(
      branch.contains("self.freePeriodRestore.run()"),
      "the free-period Restore must run the read-only App Store check"
    )
    for forbidden in ["purchases.", "Purchases.", "purchase(", "restorePurchases", "syncPurchases"] {
      XCTAssertFalse(
        branch.contains(forbidden),
        "the free-period Restore must not reach \(forbidden): nothing is for sale and the "
          + "RevenueCat identity stays untouched while the paid tier is off"
      )
    }

    // Every router method the branch reaches, directly or through another helper.
    let helpers = try routerHelpersReached(from: branch, in: source)
    XCTAssertTrue(
      helpers.keys.contains("refreshReceiptStamp") && helpers.keys.contains("captureOriginalInstall"),
      "this walk no longer reaches the stamp refresh and the cohort capture: it is reading nothing"
    )
    for (name, executable) in helpers {
      // Comments are not code: a helper may mention a forbidden name without reaching it.
      let body = Self.withoutComments(executable)
      for forbidden in Self.forbiddenForFreePeriodHelpers where forbidden.found(in: body) {
        XCTFail("\(name)(), reached from the free-period Restore, must not reach \(forbidden.name)")
      }
      // The one PurchaseManager call allowed is the read-only receipt read.
      let calls = body.components(separatedBy: "purchases.").dropFirst()
      for call in calls {
        XCTAssertTrue(
          call.hasPrefix("refreshReceiptStatus {"),
          "\(name)(), reached from the free-period Restore, calls PurchaseManager beyond the "
            + "read-only receipt read: purchases.\(call.prefix(40))"
        )
      }
    }

    // That receipt read stays on StoreKit's transaction history: no RevenueCat, no purchase.
    let manager = try String(
      contentsOf: repositoryRoot
        .appendingPathComponent("apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift"),
      encoding: .utf8)
    for signature in ["func refreshReceiptStatus(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> ReceiptStatus {",
                      "private static func boundedReceiptRead(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void) async -> ReceiptRead {"] {
      let body = try XCTUnwrap(
        methodBody(signature: signature, in: manager),
        "this test can no longer find PurchaseManager's \(signature)"
      )
      XCTAssertTrue(body.contains("Transaction.latest(for:") || body.contains("boundedReceiptRead(onVerifiedRevocation:"),
                    "the receipt read no longer reads StoreKit's transaction history")
      for forbidden in ["Purchases.", "purchase(", "restorePurchases", "syncPurchases", "logIn", "logOut"] {
        XCTAssertFalse(body.contains(forbidden), "the receipt read must not reach \(forbidden)")
      }
    }
  }

  /// Administrative proof routes are also dormant: configured trust must not bypass the flag.
  func testAppleAccessAdministrativeRoutesRequirePaidModeBeforeAuthorityWork() throws {
    let source = try routerSource()
    for (action, authority) in [("installAppleAccess", "AppleAccessInstallRequest.parse"),
                                ("observeAppleAccess", "entitlement.handle"),
                                ("observeAppleLinkAccess", "verifiedAppleLinkPurchaseIdentities")] {
      let body = try XCTUnwrap(bridgeActionBody(named: action, in: source))
      let guardRange = try XCTUnwrap(body.range(of: "guard MonetizationConfig.paidTierEnabled else"))
      let authorityRange = try XCTUnwrap(body.range(of: authority))
      XCTAssertLessThan(guardRange.lowerBound, authorityRange.lowerBound,
        "\(action) must refuse dormant mode before native authority or storage")
    }
    let receipt = try XCTUnwrap(bridgeActionBody(named: "receiptStatus", in: source))
    XCTAssertTrue(receipt.contains("await self.refreshReceiptStamp()"), "receipt read must use verified revocation commit path")
  }

  func testAppleLinkEligibilityRefusesMultipleCandidatesAndGenerationChange() throws {
    let body = try XCTUnwrap(bridgeActionBody(named: "observeAppleLinkAccess", in: routerSource()))
    XCTAssertTrue(body.contains("guard candidate == nil, observation.rights.count == 1 else"),
      "a second purchaser or duplicate local binding must be unavailable instead of selecting first")
    XCTAssertTrue(body.contains("candidate?.generation == empty.generation"),
      "the chosen right must still belong to the current durable generation")
    XCTAssertFalse(body.contains("encode(observation)"), "do not return from inside the catalog scan")
    XCTAssertTrue(body.contains("encode(candidate ?? empty)"), "reply only after the completed candidate scan")
  }

  /// One identifier the helpers reached from the free-period Restore must not use. It matches the
  /// whole identifier (never a longer name that merely contains it, so `logInfo` is not `logIn`).
  /// A `call` name is a verb that can also be a plain word, so it matches only when it is called
  /// (with parentheses or a trailing closure) or taken as a member reference (`x.name`, as in
  /// `Task(operation: x.attachPurchases)`); every other name matches wherever it appears.
  private struct ForbiddenName {
    let name: String
    let call: Bool

    func found(in source: String) -> Bool {
      // The `{` that ends an `if`/`guard`/`while` line opens its body (Swift does not parse a
      // trailing closure in a condition), so `if let purchase {` binds a name and calls nothing.
      let code = call
        ? source.replacingOccurrences(
          of: #"(?m)^([ \t]*(?:\}[ \t]*else[ \t]+)?(?:if|guard|while)\b[^\n{]*?)\{[ \t]*\r?$"#,
          with: "$1", options: .regularExpression)
        : source
      let escaped = NSRegularExpression.escapedPattern(for: name)
      let pattern = call
        ? #"(?<![\w])"# + escaped + #"\s*[({]|\."# + escaped + #"(?![\w])"#
        : #"(?<![\w])"# + escaped + #"(?![\w])"#
      return code.range(of: pattern, options: .regularExpression) != nil
    }
  }

  private static let forbiddenForFreePeriodHelpers: [ForbiddenName] = [
    ForbiddenName(name: "Purchases", call: false), ForbiddenName(name: "RevenueCat", call: false),
    ForbiddenName(name: "purchase", call: true), ForbiddenName(name: "restorePurchases", call: false),
    ForbiddenName(name: "syncPurchases", call: false), ForbiddenName(name: "purchaseStillPro", call: false),
    ForbiddenName(name: "hasStillPro", call: false), ForbiddenName(name: "attachPurchases", call: false),
    ForbiddenName(name: "priceString", call: false), ForbiddenName(name: "logIn", call: false),
    ForbiddenName(name: "logOut", call: false),
  ]

  /// `source` without `//` line comments and `/* */` blocks (which nest in Swift). Comment markers
  /// inside string literals are text, not comments, and stay: `"..."`, `"""..."""`, and raw strings
  /// (`#"..."#`, any number of hashes). A string interpolation (`\(...)`, or `\#(...)` in a raw
  /// string) is code again, so a comment inside it is removed and a string inside it is read as a
  /// string. A line ends at any newline, including the two-character CRLF, which Swift's `Character`
  /// treats as one character that is not equal to "\n".
  private static func withoutComments(_ source: String) -> String {
    let chars = Array(source)
    var out = ""
    var i = 0
    func at(_ text: String) -> Bool {
      let end = i + text.count
      return end <= chars.count && String(chars[i..<end]) == text
    }
    /// The hash count of a string literal that opens at `i`, or nil when none does.
    func stringOpening() -> (hashes: Int, multiline: Bool)? {
      var hashes = 0
      while i + hashes < chars.count && chars[i + hashes] == "#" { hashes += 1 }
      guard i + hashes < chars.count, chars[i + hashes] == "\"" else { return nil }
      let triple = i + hashes + 2 < chars.count && chars[i + hashes + 1] == "\"" && chars[i + hashes + 2] == "\""
      return (hashes, triple)
    }
    /// The hash count of an extended regex literal (`#/.../#`) that opens at `i`, or nil.
    func regexLiteralOpening() -> Int? {
      var hashes = 0
      while i + hashes < chars.count && chars[i + hashes] == "#" { hashes += 1 }
      guard hashes > 0, i + hashes < chars.count, chars[i + hashes] == "/" else { return nil }
      return hashes
    }
    /// A regex literal is opaque: `//` and quotes inside it are pattern text. Copied to its close.
    func copyRegexLiteral(hashes: Int) {
      let marks = String(repeating: "#", count: hashes)
      out += marks + "/"
      i += hashes + 1
      let close = "/" + marks
      while i < chars.count {
        if at(close) { out += close; i += close.count; return }
        out.append(chars[i])
        i += 1
      }
    }
    /// Copies a string literal through its closing delimiter. A one-line string stops at a newline.
    func copyString(hashes: Int, multiline: Bool) {
      let marks = String(repeating: "#", count: hashes)
      let quote = multiline ? "\"\"\"" : "\""
      out += marks + quote
      i += hashes + quote.count
      let close = quote + marks
      let escape = "\\" + marks
      while i < chars.count {
        if at(close) { out += close; i += close.count; return }
        if !multiline && chars[i].isNewline { return }
        if at(escape) {
          out += escape
          i += escape.count
          if i < chars.count && chars[i] == "(" {
            out.append("(")
            i += 1
            copyCode(untilClosingParenthesis: true)
          } else if i < chars.count && !(chars[i].isNewline && !multiline) {
            out.append(chars[i])
            i += 1
          }
          continue
        }
        out.append(chars[i])
        i += 1
      }
    }
    func copyCode(untilClosingParenthesis: Bool) {
      var depth = 0
      while i < chars.count {
        if at("//") {
          while i < chars.count && !chars[i].isNewline { i += 1 }
          continue
        }
        if at("/*") {
          var blockDepth = 1
          i += 2
          while i < chars.count && blockDepth > 0 {
            if at("/*") { blockDepth += 1; i += 2 }
            else if at("*/") { blockDepth -= 1; i += 2 }
            else { i += 1 }
          }
          continue
        }
        if let hashes = regexLiteralOpening() {
          copyRegexLiteral(hashes: hashes)
          continue
        }
        if let opening = stringOpening() {
          copyString(hashes: opening.hashes, multiline: opening.multiline)
          continue
        }
        if untilClosingParenthesis {
          if chars[i] == "(" { depth += 1 }
          else if chars[i] == ")" {
            if depth == 0 { out.append(")"); i += 1; return }
            depth -= 1
          }
        }
        out.append(chars[i])
        i += 1
      }
    }
    copyCode(untilClosingParenthesis: false)
    return out
  }

  /// The walk follows `self?.helper(` and `Self.helper(`, and the forbidden-name match is exact:
  /// without these, a weakly captured or static call hides a forbidden helper from the scan, and a
  /// comment or a longer name (`logInfo`) would trip it for no reason.
  func testTheHelperScanFollowsWeakAndStaticCallsAndMatchesWholeCallsOnly() throws {
    let router = """
    final class Router {
      func start() {
      }
      func viaWeak() {
        Task { await self?.viaWeakTarget() }
      }
      func viaWeakTarget() {
      }
      func viaStatic() {
      }
      static func viaStaticTarget() {
      }
      func other() {
      }
    }
    """
    let reached = try routerHelpersReached(
      from: "await self?.viaWeakTarget(); Self.viaStaticTarget(); other.viaStatic(); self.viaStatic()",
      in: router)
    XCTAssertTrue(reached.keys.contains("viaWeakTarget"), "self?.helper( must be followed")
    XCTAssertTrue(reached.keys.contains("viaStaticTarget"), "Self.helper( must be followed")
    XCTAssertTrue(reached.keys.contains("viaStatic"), "self.helper( is still followed")
    XCTAssertFalse(reached.keys.contains("viaWeak"), "a method nothing calls is not walked")

    let logIn = ForbiddenName(name: "logIn", call: true)
    XCTAssertFalse(logIn.found(in: "logInfo(\"x\")"), "a longer name is not logIn")
    XCTAssertFalse(logIn.found(in: "let logInState = 1"))
    XCTAssertFalse(logIn.found(in: Self.withoutComments("// never call logIn(user) here\nlet a = 1")))
    XCTAssertFalse(logIn.found(in: Self.withoutComments("/* logIn(user) */ let a = 1")))
    XCTAssertTrue(logIn.found(in: "try await Purchases.shared.logIn(id)"), "a real call is found")
    XCTAssertTrue(logIn.found(in: "self.logIn (id)"), "a call with a space is found")
    XCTAssertTrue(logIn.found(in: Self.withoutComments("let u = \"https://x\"; logIn(id)")), "a URL is not a comment")
    // Trailing-closure calls and function references are the same reach as a call with parentheses.
    let logOut = ForbiddenName(name: "logOut", call: false)
    XCTAssertTrue(logOut.found(in: "x.logOut { _ in }"), "a trailing-closure call is found")
    XCTAssertTrue(logOut.found(in: "logOut { _ in }"))
    let attach = ForbiddenName(name: "attachPurchases", call: false)
    XCTAssertTrue(attach.found(in: "Task(operation: x.attachPurchases)"), "a function reference is found")
    XCTAssertFalse(attach.found(in: "attachPurchasesLater()"))
    let purchase = ForbiddenName(name: "purchase", call: true)
    XCTAssertTrue(purchase.found(in: "try await manager.purchase { _ in }"))
    XCTAssertTrue(purchase.found(in: "Task(operation: manager.purchase)"))
    XCTAssertTrue(purchase.found(in: "purchase(product)"))
    XCTAssertFalse(purchase.found(in: "let purchase = 1"), "a plain word is not a purchase call")
    XCTAssertFalse(purchase.found(in: "purchased(product)"))
    // A comment marker inside a string literal is text: the code after it is still read.
    let masked = Self.withoutComments("let p = \"a//b\"; Purchases.shared.logIn(id)")
    XCTAssertTrue(logIn.found(in: masked), "// inside a string must not hide the call after it")
    XCTAssertTrue(logIn.found(in: Self.withoutComments("let p = \"\"\"\nsee http://x\n\"\"\"; logIn(id)")), "multi-line string")
    XCTAssertTrue(logIn.found(in: Self.withoutComments("let p = \"say \\\"//\\\" now\"; logIn(id)")), "escaped quote")
    XCTAssertFalse(logIn.found(in: Self.withoutComments("/* a /* nested */ logIn(id) */ let a = 1")), "nested block comment")
    XCTAssertFalse(logIn.found(in: Self.withoutComments("let a = 1 // logIn(id)\nlet b = 2")))
    let revenueCat = ForbiddenName(name: "RevenueCat", call: false)
    XCTAssertTrue(revenueCat.found(in: "import RevenueCat"))
    XCTAssertFalse(revenueCat.found(in: "RevenueCatNote"))
  }

  /// The scanner reads Swift the way the compiler does where it matters here: a raw string
  /// (`#"..."#`) holds `//` as text, a string interpolation is code (so a comment inside it is a
  /// comment and a string inside it is a string), and a Windows line ending ends a `//` comment.
  func testTheCommentScannerHandlesRawStringsInterpolationsAndCRLF() {
    let logIn = ForbiddenName(name: "logIn", call: true)
    func hides(_ source: String) -> Bool { !logIn.found(in: Self.withoutComments(source)) }

    // Raw strings: the quote and the comment marker inside are text; the call after them is code.
    XCTAssertFalse(hides("let p = #\"a//b\"#; logIn(id)"), "// inside a raw string is text")
    XCTAssertFalse(hides("let p = #\"say \"//\" now\"#; logIn(id)"), "a bare quote does not end a raw string")
    XCTAssertFalse(hides("let p = ##\"x\"#//y\"##; logIn(id)"), "a raw string ends only at its own hash count")
    XCTAssertFalse(hides("let p = #\"\"\"\nsee http://x\n\"\"\"#; logIn(id)"), "multi-line raw string")
    XCTAssertFalse(hides("let p = #\"\\#(a)//\"#; logIn(id)"), "a raw interpolation is not the end of the string")
    // A backslash is an ordinary character in a raw string, so it never escapes the closing quote.
    XCTAssertFalse(hides("let p = #\"a\\\"#; logIn(id)"), "a trailing backslash in a raw string")

    // Interpolation: code inside a string.
    XCTAssertFalse(hides("let p = \"a \\(\"//\") b\"; logIn(id)"), "a string with // inside an interpolation")
    XCTAssertFalse(hides("let p = \"a \\(dict[\"k\"]) //\"; logIn(id)"), "a quoted key inside an interpolation")
    XCTAssertTrue(hides("let p = \"a \\(x /* logIn(id) */) b\""), "a comment inside an interpolation is a comment")
    XCTAssertFalse(hides("let p = \"a \\(f(\"\\(g())\")) b\"; logIn(id)"), "nested interpolation")

    // Regex literals: `//` inside `#/.../#` is part of the pattern, not a comment.
    XCTAssertFalse(hides("let r = #/a//b/#; logIn(id)"), "// inside a regex literal is text")
    XCTAssertFalse(hides("let r = ##/a/#b//c/##; logIn(id)"), "a regex literal ends only at its own hash count")
    XCTAssertTrue(hides("let r = 1 // #/ logIn(id)\nlet s = 2"), "a #/ inside a comment is still a comment")

    // CRLF: Swift treats \r\n as ONE character, so a scan for \n alone never sees it.
    XCTAssertFalse(hides("let a = 1 // note\r\nlogIn(id)\r\n"), "a // comment ends at a CRLF line end")
    XCTAssertTrue(hides("let a = 1 // logIn(id)\r\nlet b = 2\r\n"), "the comment itself is still removed")
    XCTAssertFalse(hides("let p = \"unterminated\r\nlogIn(id)"), "a one-line string ends at a CRLF")
    XCTAssertTrue(hides("/* a\r\nlogIn(id)\r\n*/ let b = 2"), "a block comment spans CRLF lines")
  }

  /// `purchase` is also an ordinary name: a binding or a condition on it is not a purchase call, and
  /// a real call is still found whether or not it sits inside an `if`.
  func testThePurchaseMatcherIgnoresBindingsAndConditionsButNotCalls() {
    let purchase = ForbiddenName(name: "purchase", call: true)
    for harmless in [
      "if let purchase {\n  show()\n}",
      "if let purchase = stored {\n  show()\n}",
      "guard let purchase else {\n  return\n}",
      "guard let purchase = stored else {\n  return\n}",
      "if purchase {\n  show()\n}",
      "while let purchase = queue.next() {\n  show()\n}",
      "} else if let purchase {\n  show()\n}",
      "if let purchase,\n   purchase.isValid {\n  show()\n}",
    ] {
      XCTAssertFalse(purchase.found(in: harmless), "not a call: \(harmless)")
    }
    for call in [
      "if await manager.purchase(product) {\n}",
      "if purchase(product) {\n}",
      "guard let r = try await manager.purchase(product) else {\n}",
      "if let r = await manager.purchase { _ in } {\n}",
      "try await manager.purchase { _ in }",
      // A real trailing-closure call on the same line as the condition's own brace.
      "if ready { purchase {\n  done()\n} }",
      "if ready { purchase {\n}}",
      "while x { purchase {\n}}",
    ] {
      XCTAssertTrue(purchase.found(in: call), "a call: \(call)")
    }
  }

  /// The bodies of the router methods `code` calls (with or without `self.`), and of the methods
  /// those call, by name. A name that matches no method in the router is not followed.
  private func routerHelpersReached(from code: String, in source: String) throws -> [String: String] {
    let declarations = try NSRegularExpression(pattern: #"\bfunc (\w+)\("#)
    let names = Set(declarations.matches(in: source, range: NSRange(source.startIndex..., in: source))
      .compactMap { Range($0.range(at: 1), in: source).map { String(source[$0]) } })
    // A call on the router itself: bare, `self.name(`, `self?.name(` (a weak capture) or
    // `Self.name(` (a static helper). A call on any other receiver is not the router's method.
    let calls = try NSRegularExpression(pattern: #"(?<![\w.])(?:self\??\.|Self\.)?(\w+)\("#)
    var reached: [String: String] = [:]
    var pending = [code]
    while let next = pending.popLast() {
      for match in calls.matches(in: next, range: NSRange(next.startIndex..., in: next)) {
        guard let range = Range(match.range(at: 1), in: next) else { continue }
        let name = String(next[range])
        guard names.contains(name), reached[name] == nil else { continue }
        let body = try XCTUnwrap(
          methodBody(signature: "func \(name)(", in: source),
          "the router declares \(name)() but this test cannot find its body"
        )
        reached[name] = body
        pending.append(body)
      }
    }
    return reached
  }

  /// One method's body: from its signature to the first line that closes a member at class
  /// indentation. Nil when either end is missing, never the rest of the file.
  private func methodBody(signature: String, in source: String) -> String? {
    guard let start = source.range(of: signature) else { return nil }
    let rest = source[start.upperBound...]
    guard let close = rest.range(of: "\n  }\n") else { return nil }
    return String(rest[rest.startIndex..<close.lowerBound])
  }

  /// The live App Store half of the free-period Restore may only read. It may not import or name
  /// RevenueCat, hold a product, or call anything that starts a purchase or a RevenueCat restore.
  func testTheLiveFreePeriodRestoreCheckCannotReachAPurchaseOrRevenueCat() throws {
    let url = repositoryRoot
      .appendingPathComponent("apps/apple/Still/Shared (App)/Purchases/AppStoreRestoreCheck.swift")
    let text = try String(contentsOf: url, encoding: .utf8)
    let code = text.split(separator: "\n", omittingEmptySubsequences: false)
      .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
      .joined(separator: "\n")
    XCTAssertTrue(code.contains("Transaction.currentEntitlements"), "the check reads current entitlements")
    XCTAssertTrue(code.contains("AppStore.sync()"), "the check syncs with the App Store")
    for forbidden in [
      "RevenueCat", "Purchases", "PurchaseManager", "purchase(", "Product.", "Product(",
      "restorePurchases", "syncPurchases", "AppTransaction",
    ] {
      XCTAssertFalse(
        code.contains(forbidden),
        "AppStoreRestoreCheck must stay read-only: found \(forbidden)"
      )
    }
  }

  /// The cohort record is written from this router at first launch and cannot be recreated later,
  /// so the value it stores has to be interpretable on both platforms. Apple reports
  /// `originalAppVersion` as a build number on iOS and a marketing version on macOS; asking
  /// StillKit which one this platform uses is what keeps the two comparable.
  func testTheCohortRecordTagsApplesVersionNamespaceRatherThanAssumingOne() throws {
    let source = try routerSource()
    XCTAssertTrue(
      source.contains("kind: OriginalInstall.applicationVersionKindForThisPlatform"),
      "the recorded application version must carry the namespace it was read in"
    )
    XCTAssertFalse(
      source.contains("kind: .buildNumber") || source.contains("kind: .marketingVersion"),
      "hardcoding one platform's namespace would misclassify the other platform's installs"
    )
  }

  /// Asking Apple for the app transaction can raise an App Store sign-in prompt on a device with
  /// no cached transaction. Still is free, so the ask has to be counted before it is made and has
  /// to stop, rather than repeating at every launch and every foreground return.
  func testTheCohortRecordBoundsHowOftenItAsksAppleForPurchaseHistory() throws {
    let capture = try captureSource()
    let ask = try XCTUnwrap(
      capture.range(of: "AppTransaction.shared"),
      "the capture no longer reads the app transaction"
    )
    let beforeTheAsk = String(capture[capture.startIndex..<ask.lowerBound])
    XCTAssertTrue(
      beforeTheAsk.contains("OriginalInstall.shouldRequestVerifiedValues"),
      "the capture must check the attempt ceiling before asking Apple"
    )
    XCTAssertTrue(
      beforeTheAsk.contains("OriginalInstall.countVerifiedAttempt"),
      "the attempt must be counted before the ask, so a request that never returns still counts"
    )
    // The capture runs at launch and again when the app becomes active, both on a cold launch, so
    // without a per-launch flag one launch spends two attempts and two requests can be open at once.
    XCTAssertTrue(
      beforeTheAsk.contains("!hasAskedAppleForPurchaseHistoryThisLaunch"),
      "one launch must spend at most one attempt: launch and foreground both reach this capture"
    )
    XCTAssertTrue(
      beforeTheAsk.contains("hasAskedAppleForPurchaseHistoryThisLaunch = true"),
      "the per-launch flag must be set before the ask, not after it returns"
    )
  }

  /// The cohort record's local half is the field the free era is actually read from, and it comes
  /// from the app's own bundle with no App Store round trip. It has to be written before anything
  /// that can stop the capture, or switching the ask to Apple off would take the cohort with it.
  func testTheCohortRecordIsWrittenBeforeAnythingCanStopTheCapture() throws {
    let capture = try captureSource()
    let localWrite = try XCTUnwrap(
      capture.range(of: "OriginalInstall.ensure("),
      "the capture no longer writes the local half of the record"
    )
    let firstGate = try XCTUnwrap(
      capture.range(of: "guard "),
      "this test can no longer find where the capture starts giving up"
    )
    XCTAssertTrue(
      localWrite.upperBound < firstGate.lowerBound,
      "the local half must be written before the first thing that can return early: it needs "
        + "nothing from Apple and every install must get one"
    )
  }

  /// Asking Apple for the app transaction is switched off with the rest of the paid tier
  /// (`OriginalInstall.shouldRequestVerifiedValues`), because it can raise an App Store sign-in
  /// sheet on a device where nobody is signed in and nothing reads the answer while Still sells
  /// nothing. A guard only holds if it is the only way through, so this asks the harder question:
  /// is that the only place in the shipped Apple sources that asks at all. A second one added later
  /// would be behind no switch, and this is what says so.
  ///
  /// It matches the bare type name rather than one member on one line, because `AppTransaction
  /// .shared` split across two lines and `AppTransaction.refresh()` are both the same round trip
  /// to the App Store and both used to walk straight past this. Mentions inside a block comment or
  /// a string literal would be counted too, which fails safe: it names a file that has to be looked
  /// at, rather than missing one that should have been.
  func testTheAppAsksAppleForPurchaseHistoryInExactlyOnePlace() throws {
    var callSites: [String] = []
    for url in try shippedSwiftSources() {
      let text = try String(contentsOf: url, encoding: .utf8)
      for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let code = line.trimmingCharacters(in: .whitespaces)
        if code.hasPrefix("//") { continue }
        if code.contains("AppTransaction") { callSites.append(url.lastPathComponent) }
      }
    }
    XCTAssertEqual(
      callSites, ["WebBridgeRouter.swift"],
      "every ask for Apple's purchase history goes through the one gated capture in "
        + "WebBridgeRouter; a new call site needs the same switch before it ships"
    )
  }

  /// The helper both source-text tests above depend on has to fail when it cannot find the capture,
  /// rather than quietly handing back the whole router. A window that widens to the file turns an
  /// assertion about one method into an assertion about whatever else the file happens to contain,
  /// and both of those tests would then be passing for a reason that has nothing to do with what
  /// they claim to check.
  func testTheCaptureWindowFailsRatherThanWideningToTheWholeRouter() throws {
    let source = try routerSource()
    let capture = try XCTUnwrap(
      captureBody(in: source),
      "the capture is no longer where this test expects it: captureOriginalInstall() not found"
    )

    XCTAssertTrue(
      capture.contains("OriginalInstall.ensure("),
      "the window must actually hold the capture"
    )
    XCTAssertFalse(
      capture.contains("private static var marketingVersion"),
      "the window runs past the end of the capture and into the rest of the router"
    )
    XCTAssertNil(
      captureBody(in: "final class Router {\n  private func other() async {\n    return\n  }\n}\n"),
      "a router with no capture in it must produce no window at all, not the whole file"
    )
    XCTAssertNil(
      captureBody(in: "  private func captureOriginalInstall() async {\n    let defaults = 0\n"),
      "a capture whose closing line cannot be found must produce no window either"
    )
  }

  /// Every Swift file this app actually ships: the app targets and StillKit's sources, without the
  /// tests (which name the call they are asserting about) or any build output.
  private func shippedSwiftSources() throws -> [URL] {
    let roots = [
      repositoryRoot.appendingPathComponent("apps/apple/Still"),
      repositoryRoot.appendingPathComponent("apps/apple/StillKit/Sources"),
    ]
    var found: [URL] = []
    for root in roots {
      let enumerator = try XCTUnwrap(
        FileManager.default.enumerator(atPath: root.path),
        "this test can no longer read \(root.lastPathComponent)"
      )
      var foundHere = 0
      for case let relative as String in enumerator where relative.hasSuffix(".swift") {
        let components = relative.split(separator: "/")
        if components.contains(where: { $0 == "build" || $0 == ".build" || $0 == "Tests" }) {
          continue
        }
        found.append(root.appendingPathComponent(relative))
        foundHere += 1
      }
      // Per root, not over the total: a root that moved or was renamed contributes nothing while
      // the other one still fills the array, and the walk would then pass having read half the app.
      XCTAssertGreaterThan(
        foundHere,
        0,
        "no Swift files under \(root.lastPathComponent): this walk is no longer reading that "
          + "target, so it would pass by looking at nothing"
      )
    }
    return found
  }

  /// The body of the router's cohort capture, from the end of its signature to the line that closes
  /// it. Nil when either end cannot be found, and never the whole file.
  ///
  /// The nil is the point. An earlier version split the file on the signature and took the last
  /// piece, which is the whole file when the signature is absent, then wrapped it in an XCTUnwrap
  /// of a value that can never be nil, so the message it carried could not be reached. Renaming the
  /// capture left one test passing while it scanned the entire router and found its strings
  /// somewhere in it, and made the other fail with a message that sent its reader after a bug that
  /// was not there. That is the same quiet widening the purchase test above refuses, for the same
  /// reason, in the same file.
  private func captureBody(in source: String) -> String? {
    guard let signature = source.range(of: "private func captureOriginalInstall() async {") else {
      return nil
    }
    let body = source[signature.upperBound...]
    guard let close = body.range(of: "\n  }") else { return nil }
    return String(body[body.startIndex..<close.lowerBound])
  }

  private func captureSource() throws -> String {
    let source = try routerSource()
    return try XCTUnwrap(
      captureBody(in: source),
      "this test can no longer find the body of captureOriginalInstall() in WebBridgeRouter: "
        + "point it at the method the cohort capture lives in now"
    )
  }

  private func routerSource() throws -> String {
    let routerURL = repositoryRoot
      .appendingPathComponent("apps/apple/Still/Shared (App)/WebBridgeRouter.swift")
    return try String(contentsOf: routerURL, encoding: .utf8)
  }

  /// The body of one `case "<action>":` arm of the router's message switch, from that arm's colon
  /// to the start of the next one. Nil when either end cannot be found, and nil at any indentation,
  /// because a helper that quietly widens its window turns an assertion about one arm into an
  /// assertion about whatever follows it.
  private func bridgeActionBody(named action: String, in source: String) -> String? {
    guard let start = source.range(of: "case \"\(action)\":") else { return nil }
    let rest = source[start.upperBound...]
    guard let nextArm = rest.range(of: "case \"") else { return nil }
    return String(rest[rest.startIndex..<nextArm.lowerBound])
  }
}
