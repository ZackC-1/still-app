// The deep path (not the "@still/core/ui" barrel, which re-exports Svelte components) keeps this
// module loadable in this package's node-environment vitest.
import type { EmailConsent } from "@still/core/ui/email-consent";

// What this browser's add-on store requires the extension to show, in its own interface, before it
// collects an email address. It is a store rule rather than a preference, and the two stores ask
// for different things:
//
//   * Chrome's program policies want the disclosure at the point of collection, inside the
//     extension, not only behind a privacy-policy link.
//   * Firefox wants an explicit, affirmative opt-in before anything is collected at all.
//
// Neither applies to the Safari build, whose popup has no sign-in path to begin with.

/** Pure branch so tests can cover both targets without WXT's build-time flag replacement. */
export function pickEmailConsent(isFirefox: boolean): EmailConsent {
  return isFirefox ? "opt-in" : "disclosure";
}

// WXT replaces the target flag at build time, so each build carries only its own rule.
export const emailConsent: EmailConsent = pickEmailConsent(Boolean(import.meta.env.FIREFOX));
