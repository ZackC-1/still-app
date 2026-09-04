// What a surface must show before it may collect an email address.
//
// This is an add-on store rule rather than a preference, and it differs by store, so the host
// declares it like every other capability instead of anything sniffing a user agent. It lives in
// its own module, beside surface-guidance.ts and for the same reason: the extension packages need
// the type in a node-environment test, where the rune-based controller module cannot be loaded.
//
//   * "none"       — nothing extra. The Apple apps, whose disclosure is the App Store privacy label
//                    and the privacy policy, and the Safari extension popup, which has no sign-in
//                    path at all.
//   * "disclosure" — a note that has to be acknowledged before the email field appears. Chrome's
//                    program policies want it at the point of collection, in the extension's own
//                    interface, not only behind a privacy-policy link.
//   * "opt-in"     — an explicit, affirmative yes before anything is collected. What Firefox asks
//                    for.
export type EmailConsent = "none" | "disclosure" | "opt-in";
