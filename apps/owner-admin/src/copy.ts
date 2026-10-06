// Every word the owner page shows. All of it is approved: the exact wording from the approved
// design (D28 OwnerAllowances, design system v3.2), copy Still already ships
// (packages/core/src/ui/strings.ts codeAuth, the "Not available here" access tag), and the
// owner-approved wording for the states those references don't cover. copy.test.ts pins the strings
// so they cannot drift.
// Nothing here describes the owner, the allowlist, or who may sign in.

export const APPROVED = Object.freeze({
  // D28 OwnerAllowances (approved owner view copy).
  allowances: {
    title: "Rating prompt allowances",
    body: "Off everywhere until you allow it. Nothing changes until Apply.",
    all: "All surfaces",
    deferred: "Deferred",
    changed: "Changed",
    previewLead: "After Apply, prompts are allowed on ",
    previewNone: "no surfaces",
    apply: "Apply",
    discard: "Discard changes",
    applying: "Applying…",
    readback: "Reading back the saved allowances…",
    applied: "Applied and read back. The server matches.",
    stale: "These changed since you loaded them. Reload to see the current state.",
    reload: "Reload",
    failed: "Apply didn't finish. Nothing changed.",
    tryAgain: "Try again",
  },
  // D28 surface names, in the design's order. Edge is remembered but deferred (never live).
  surfaces: {
    chrome_desktop: "Chrome desktop",
    edge_desktop: "Edge desktop",
    firefox_desktop: "Firefox desktop",
    firefox_android: "Firefox Android",
    apple_mobile_host: "Apple mobile host",
    apple_macos_host: "Apple macOS host",
  },
  // Shipped sign-in copy (strings.ts codeAuth / auth / emailConsent wording reused verbatim).
  signIn: {
    prompt: "Enter your email to get a 6-digit sign-in code.",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    invalidEmail: "Enter a valid email address to continue.",
    send: "Send code",
    sending: "Sending…",
    sentTo: "Sent to",
    codeLabel: "6-digit code",
    verify: "Verify code",
    verifying: "Checking…",
    wrongCode: "That code didn't work. Check it and try again.",
    verifyError: "We couldn't sign you in. Try again.",
    sendError: "Couldn't send the code. Try again.",
    differentEmail: "Use a different email",
    signOut: "Sign out",
  },
  // The shipped neutral access tag. Shown to anyone who isn't an owner, and when the page isn't
  // configured; it says nothing about who the owner is or why.
  unavailable: "Not available here",
  loading: "Checking…",
  // Owner-approved page wording for states the design references don't cover.
  /** Q1: environment picker label and its two options. */
  environmentLabel: "Environment",
  environmentSandbox: "Sandbox",
  environmentProduction: "Production",
  /** Q2: the sales section. */
  salesTitle: "Sales",
  salesBody: "Off until you allow it. Nothing changes until Apply.",
  salesSwitch: "Sales allowed",
  salesReadback: "Reading back the saved sales setting…",
  /** Q3: the server refuses to turn sales on before the paid cutoff exists (R4). */
  salesCutoffRefused: "The server refused: sales can't turn on until the paid cutoff is set up. Nothing changed.",
  /** Q4: apply was accepted but the readback could not confirm it either way. */
  unconfirmed: "Apply was sent but couldn't be read back. Reload to see the current state.",
  /** Q5: loading the current state failed (network or server). */
  loadFailed: "Couldn't load the current state. Try again.",
  /** Q6: undo the last applied change (rollback publishes the previous values at a new revision). */
  rollback: "Undo last change",
  /** Q8: the policy lists no approved app builds, so no surface can act on it yet. */
  noBuilds: "No approved app builds are listed yet, so switching this on has no effect until they are.",
});
// Q7: the page heading and the tab title are the word "Still" (App.svelte, index.html).
