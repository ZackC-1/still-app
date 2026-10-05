import Foundation
import XCTest

/// The simulator QA hooks (apps/apple/Still/Shared (App)/QA) must never ship. The app target is not
/// built by `swift test`, so these read the checked-in sources and project file and pin the four
/// things that keep the hooks out of a Release build:
///   1. every QA source file is wholly inside `#if DEBUG`;
///   2. every use of a QA symbol or launch key outside that folder is inside `#if DEBUG`;
///   3. no Release configuration defines DEBUG, and every Debug one does (so the gate is real);
///   4. the shipping path (archive.sh, shared schemes, Info.plists, xcconfigs) never selects Debug
///      or sets a QA launch key.
/// `apps/apple/scripts/qa-sim.sh verify-release` adds the binary-level proof: a Release build
/// carries none of the QA strings, and the Debug build does.
final class QAHooksReleaseExclusionTests: XCTestCase {
  private var repositoryRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  private var projectDirectory: URL { repositoryRoot.appendingPathComponent("apps/apple/Still") }
  private var qaDirectory: URL { projectDirectory.appendingPathComponent("Shared (App)/QA") }

  /// Identifiers declared by the QA folder and the launch-key prefix they read.
  static let qaTokens = ["QAHooks", "QALayoutSink", "QALayoutProbe", "STILL_QA_"]

  private func swiftFiles(under base: URL) throws -> [URL] {
    let walker = try XCTUnwrap(FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil))
    return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
      .sorted { $0.path < $1.path }
  }

  private func isInsideQAFolder(_ url: URL) -> Bool {
    url.standardizedFileURL.path.hasPrefix(qaDirectory.standardizedFileURL.path + "/")
  }

  // MARK: - 1. QA sources

  func testEveryQASourceFileIsWhollyDebugOnly() throws {
    let files = try swiftFiles(under: qaDirectory)
    XCTAssertFalse(files.isEmpty, "the QA folder should hold the hooks")
    for file in files {
      let source = try String(contentsOf: file, encoding: .utf8)
      XCTAssertTrue(
        Self.isWhollyDebugOnly(source),
        "\(file.lastPathComponent): the first line must open `#if DEBUG` and its matching `#endif` must be the last line, with no `#else`")
    }
  }

  // MARK: - 2. Call sites

  func testEveryQAReferenceOutsideTheFolderIsInsideDebug() throws {
    var found = 0
    var offenders: [String] = []
    for file in try swiftFiles(under: projectDirectory) where !isInsideQAFolder(file) {
      let source = try String(contentsOf: file, encoding: .utf8)
      for (number, line, debugOnly) in Self.linesWithDebugState(source)
      where Self.qaTokens.contains(where: line.contains) && !Self.isComment(line) {
        found += 1
        if !debugOnly { offenders.append("\(file.lastPathComponent):\(number)") }
      }
    }
    // Non-vacuous: the three wired call sites (web view, presenter, Safari status) are found.
    XCTAssertGreaterThanOrEqual(found, 3)
    XCTAssertEqual(offenders, [], "wrap every QA use in `#if DEBUG`")
  }

  // MARK: - 3. Build configurations

  func testReleaseConfigurationsNeverDefineDebugAndDebugOnesDo() throws {
    let project = try String(
      contentsOf: projectDirectory.appendingPathComponent("Still.xcodeproj/project.pbxproj"), encoding: .utf8)
    let configurations = Self.buildConfigurations(project)
    let release = configurations.filter { $0.name == "Release" }
    let debug = configurations.filter { $0.name == "Debug" }
    XCTAssertFalse(release.isEmpty)
    XCTAssertEqual(release.count, debug.count)
    for configuration in release {
      XCTAssertFalse(Self.definesDebug(configuration.settings), "a Release configuration defines DEBUG")
    }
    // The project-level Debug configuration is what turns the hooks on; the gate must be real.
    XCTAssertTrue(debug.contains { Self.definesDebug($0.settings) }, "no Debug configuration defines DEBUG")
  }

  func testQASourcesBelongOnlyToTheTwoAppTargets() throws {
    let project = try String(
      contentsOf: projectDirectory.appendingPathComponent("Still.xcodeproj/project.pbxproj"), encoding: .utf8)
    let lines = project.components(separatedBy: "\n")
    // Exactly one build-file entry per app target (iOS, macOS), and no extension target.
    let buildFiles = lines.filter { $0.contains("QAHooks.swift in Sources */ = {isa = PBXBuildFile") }
      .compactMap { $0.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init) }
    XCTAssertEqual(buildFiles.count, 2)
    XCTAssertEqual(lines.filter { $0.contains("QAHooks.swift in Resources") }.count, 0)
    // Each sits in a Sources phase, and those phases belong to exactly the two app targets.
    let owners = Set(buildFiles.compactMap { Self.targetOwningSourcesEntry($0, in: project) })
    XCTAssertEqual(owners, ["Still (iOS)", "Still (macOS)"])
    XCTAssertEqual(buildFiles.compactMap { Self.targetOwningSourcesEntry($0, in: project) }.count, 2)
  }

  /// The native target whose Sources build phase lists the build-file id, or nil.
  static func targetOwningSourcesEntry(_ buildFileID: String, in project: String) -> String? {
    func objects(_ isa: String) -> [(id: String, body: String)] {
      let pattern = #"([0-9A-F]{24}) /\*[^*]*\*/ = \{\s*isa = "# + isa + #";(.*?)\n\t\t\};"#
      let regex = try! NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
      let ns = project as NSString
      return regex.matches(in: project, range: NSRange(location: 0, length: ns.length)).map {
        (ns.substring(with: $0.range(at: 1)), ns.substring(with: $0.range(at: 2)))
      }
    }
    guard let phase = objects("PBXSourcesBuildPhase").first(where: { $0.body.contains("\(buildFileID) /*") })
    else { return nil }
    guard let target = objects("PBXNativeTarget").first(where: { $0.body.contains("\(phase.id) /* Sources */") }),
      let name = target.body.range(of: #"\n\t\t\tname = "?([^";]+)"?;"#, options: .regularExpression)
    else { return nil }
    return String(target.body[name]).replacingOccurrences(of: "name = ", with: "")
      .trimmingCharacters(in: CharacterSet(charactersIn: "\n\t\";"))
  }

  // MARK: - 4. The shipping path

  func testShippingPathNeverSelectsDebugOrSetsAQAKey() throws {
    let archive = try String(
      contentsOf: repositoryRoot.appendingPathComponent("apps/apple/scripts/archive.sh"), encoding: .utf8)
    XCTAssertTrue(archive.contains("xcodebuild archive"))
    for forbidden in ["-configuration", "SWIFT_ACTIVE_COMPILATION_CONDITIONS", "OTHER_SWIFT_FLAGS", "STILL_QA_"] {
      XCTAssertFalse(archive.contains(forbidden), "archive.sh must not pass \(forbidden)")
    }
    // A shared scheme could change the archive configuration; there is none (Xcode's
    // auto-created schemes archive Release), and if one appears it must archive Release.
    let walker = try XCTUnwrap(FileManager.default.enumerator(at: projectDirectory, includingPropertiesForKeys: nil))
    for case let url as URL in walker {
      let text = try? String(contentsOf: url, encoding: .utf8)
      switch url.pathExtension {
      case "xcscheme":
        let archiveAction = text?.range(of: "<ArchiveAction").map { String(text![$0.lowerBound...]) } ?? ""
        XCTAssertTrue(archiveAction.contains("buildConfiguration = \"Release\""), url.lastPathComponent)
        XCTAssertFalse(text?.contains("STILL_QA_") ?? false, url.lastPathComponent)
      case "xcconfig":
        // Includes a developer's local, ignored Secrets.local.xcconfig: it is part of every build.
        XCTAssertFalse(text?.contains("STILL_QA_") ?? false, "\(url.lastPathComponent) sets a QA key")
        XCTAssertFalse(Self.definesDebug(text ?? "", format: .xcconfig), "\(url.lastPathComponent) defines DEBUG")
      case "plist", "entitlements":
        XCTAssertFalse(text?.contains("STILL_QA_") ?? false, "\(url.lastPathComponent) sets a QA key")
      default:
        break
      }
    }
  }

  // MARK: - The parser these rely on

  func testParserControls() {
    XCTAssertTrue(Self.isWhollyDebugOnly("#if DEBUG\nlet a = 1\n#if os(iOS)\nlet b = 2\n#endif\n#endif\n"))
    XCTAssertFalse(Self.isWhollyDebugOnly("import Foundation\n#if DEBUG\nlet a = 1\n#endif\n"))
    XCTAssertFalse(Self.isWhollyDebugOnly("#if DEBUG\nlet a = 1\n#else\nlet a = 2\n#endif\n"))
    XCTAssertFalse(Self.isWhollyDebugOnly("#if DEBUG\nlet a = 1\n#endif\nlet b = 2\n"))
    let states = Self.linesWithDebugState(
      "QAHooks.a()\n#if DEBUG\nQAHooks.b()\n#if os(iOS)\nQAHooks.c()\n#endif\n#else\nQAHooks.d()\n#endif\n")
      .filter { $0.1.contains("QAHooks") }.map(\.2)
    XCTAssertEqual(states, [false, true, true, false])
    XCTAssertTrue(Self.definesDebug(#"SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";"#))
    XCTAssertFalse(Self.definesDebug(#"SWIFT_ACTIVE_COMPILATION_CONDITIONS = "QA_LANE";"#))
    XCTAssertTrue(Self.definesDebug("OTHER_SWIFT_FLAGS = \"-D DEBUG\";"))
    // pbxproj array forms, spread over lines.
    XCTAssertTrue(Self.definesDebug("SWIFT_ACTIVE_COMPILATION_CONDITIONS = (\n\t\t\t\t\tDEBUG,\n\t\t\t\t\t\"$(inherited)\",\n\t\t\t\t);"))
    XCTAssertTrue(Self.definesDebug("OTHER_SWIFT_FLAGS = (\n\t\"-D\",\n\tDEBUG,\n);"))
    XCTAssertTrue(Self.definesDebug("OTHER_SWIFT_FLAGS = (\"-DDEBUG\");"))
    XCTAssertTrue(Self.definesDebug("\"SWIFT_ACTIVE_COMPILATION_CONDITIONS[sdk=iphonesimulator*]\" = DEBUG;"))
    XCTAssertFalse(Self.definesDebug("SWIFT_ACTIVE_COMPILATION_CONDITIONS = (\n\tQA_LANE,\n\t\"$(inherited)\",\n);\nOTHER_FLAG = DEBUG;"))
    XCTAssertFalse(Self.definesDebug("GCC_PREPROCESSOR_DEFINITIONS = (\n\t\"DEBUG=1\",\n);"))
    // xcconfig forms: one line each, comments ignored.
    XCTAssertTrue(Self.definesDebug("SWIFT_ACTIVE_COMPILATION_CONDITIONS = $(inherited) DEBUG\n", format: .xcconfig))
    XCTAssertTrue(Self.definesDebug("OTHER_SWIFT_FLAGS = $(inherited) -D DEBUG\n", format: .xcconfig))
    XCTAssertFalse(Self.definesDebug("SWIFT_ACTIVE_COMPILATION_CONDITIONS = QA_LANE // not DEBUG\nX = DEBUG\n", format: .xcconfig))
  }

  /// Comments compile to nothing, so a comment may name the hooks anywhere.
  static func isComment(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    return trimmed.hasPrefix("//") || trimmed.hasPrefix("*") || trimmed.hasPrefix("/*")
  }

  static func isWhollyDebugOnly(_ source: String) -> Bool {
    let lines = source.components(separatedBy: "\n")
      .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    guard lines.first == "#if DEBUG", lines.last == "#endif" else { return false }
    var depth = 0
    for (index, line) in lines.enumerated() {
      if line.hasPrefix("#if") { depth += 1 }
      if (line.hasPrefix("#else") || line.hasPrefix("#elseif")) && depth == 1 { return false }
      if line.hasPrefix("#endif") {
        depth -= 1
        if depth == 0 && index != lines.count - 1 { return false }
      }
    }
    return depth == 0
  }

  /// Each line with whether it compiles only when DEBUG is defined: inside the `#if DEBUG` branch
  /// of some enclosing conditional (never its `#else`).
  static func linesWithDebugState(_ source: String) -> [(Int, String, Bool)] {
    var stack: [Bool] = []  // per open conditional: is the current branch DEBUG-only?
    var result: [(Int, String, Bool)] = []
    for (index, raw) in source.components(separatedBy: "\n").enumerated() {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("#if") {
        stack.append(line == "#if DEBUG")
      } else if line.hasPrefix("#elseif") || line.hasPrefix("#else") {
        if !stack.isEmpty { stack[stack.count - 1] = false }
      } else if line.hasPrefix("#endif") {
        _ = stack.popLast()
      } else {
        result.append((index + 1, raw, stack.contains(true)))
      }
    }
    return result
  }

  static func buildConfigurations(_ project: String) -> [(name: String, settings: String)] {
    var result: [(String, String)] = []
    var remainder = Substring(project)
    while let start = remainder.range(of: "isa = XCBuildConfiguration;") {
      let tail = remainder[start.upperBound...]
      guard let nameRange = tail.range(of: "name = "),
        let end = tail[nameRange.upperBound...].firstIndex(of: ";")
      else { break }
      let name = String(tail[nameRange.upperBound..<end])
      result.append((name, String(tail[..<nameRange.lowerBound])))
      remainder = tail[end...]
    }
    return result
  }

  enum SettingsFormat { case pbxproj, xcconfig }

  /// Whether the text sets a Swift compilation condition named DEBUG through
  /// SWIFT_ACTIVE_COMPILATION_CONDITIONS or OTHER_SWIFT_FLAGS (`-D DEBUG`, `-DDEBUG`), in any form:
  /// a scalar, a quoted list, or a pbxproj array spread over several lines, and with or without a
  /// conditional suffix such as `[sdk=iphonesimulator*]`. A pbxproj value runs to its terminating
  /// `;` (outside quotes); an xcconfig value runs to the end of its line (before any `//`).
  static func definesDebug(_ text: String, format: SettingsFormat = .pbxproj) -> Bool {
    let key = try! NSRegularExpression(
      pattern: #"(SWIFT_ACTIVE_COMPILATION_CONDITIONS|OTHER_SWIFT_FLAGS)(\[[^\]\n]*\])?"?[ \t]*=[ \t]*"#)
    let ns = text as NSString
    for match in key.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      let rest = ns.substring(from: match.range.location + match.range.length)
      var value = ""
      var quoted = false
      for character in rest {
        if character == "\"" { quoted.toggle() }
        if format == .pbxproj, character == ";", !quoted { break }
        if format == .xcconfig, character == "\n" { break }
        value.append(character)
      }
      if format == .xcconfig, let comment = value.range(of: "//") { value = String(value[..<comment.lowerBound]) }
      let words = value.split(whereSeparator: { " \t\n\r\",;()".contains($0) })
        .map { $0.drop(while: { $0 == "-" }) }
      if words.contains(where: { $0 == "DEBUG" || $0 == "DDEBUG" }) { return true }
    }
    return false
  }
}
