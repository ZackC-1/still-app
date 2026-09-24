// Prints the on-screen windows of one app: "<id> <layer> <x> <y> <width> <height>" (points).
// Used by capture-firefox-window.mjs to find Firefox and its popup. Usage: swift winlist.swift Firefox
import CoreGraphics
import Foundation
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  if owner != CommandLine.arguments[1] { continue }
  let b = w[kCGWindowBounds as String] as! [String: CGFloat]
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  print("\(w[kCGWindowNumber as String]!) \(layer) \(Int(b["X"]!)) \(Int(b["Y"]!)) \(Int(b["Width"]!)) \(Int(b["Height"]!))")
}
