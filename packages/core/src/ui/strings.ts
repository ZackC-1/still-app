import type { ServiceId } from "@still/shared-types";

// Outcome-phrased copy (spec §3.2): point at the result, never the mechanism. Sentence case.
// A settings row describes a steady state of the world, not an action.

export const STRINGS = {
  appName: "Still",

  global: {
    on: "Still is on",
    off: "Still is off",
    secondary: "Short-form is removed everywhere it appears.",
  },

  services: {
    youtube: { name: "YouTube", on: "Shorts are gone.", off: "Shorts are showing." },
    instagram: { name: "Instagram", on: "Reels are gone.", off: "Reels are showing." },
    tiktok: { name: "TikTok", on: "TikTok stays closed.", off: "TikTok is open." },
    facebook: { name: "Facebook", on: "Reels are gone.", off: "Reels are showing." },
  } satisfies Record<ServiceId, { name: string; on: string; off: string }>,

  pause: {
    pause: "Pause on this site",
    resume: "Resume on this site",
    pausedNote: "Paused here.",
  },

  // Locked (Pro-gated) service rows for un-entitled users.
  pro: {
    locked: "Included in Still Pro",
  },

  // One calm line, shown across the Shorts-no-id / Reels / TikTok placeholder contexts.
  placeholder: "Nothing here. That's the point.",

  // The user-facing label is "Still Pro"; the internal product/entitlement id stays `still_sync`
  // everywhere (StoreKit, RevenueCat, DB — see docs/monetization-design.md §5, do NOT rename ids).
  // Ratified copy (plan U3/D6/R10). Value copy is launch-real: only shipped capabilities
  // (Instagram Reels / TikTok / Facebook Reels blocking + sync) — no YT recs/comments bullets
  // until that feature exists. NEVER put a web price in this shared file (3.1.3 anti-steering):
  // the Apple CTA price comes from StoreKit and the web display price is host-injected by the
  // ext-chromium entrypoint only.
  paywall: {
    title: "Still Pro",
    headline: "The rest of the noise, gone too",
    body: "Instagram Reels, TikTok, and Facebook Reels go quiet — with your settings synced on every device.",
    reassurance: "One payment. Yours forever.",
    cta: "Unlock Pro",
    restore: "Restore purchase",
    // Safari only (AE7/3.1.1): its popup has no purchase path — Pro genuinely unlocks by itself
    // via the App-Group entitlement pull once the app purchase lands. Web-purchasable hosts
    // (Chrome/Firefox) never render this line; they get the real checkout flow instead (U4/U6).
    nonApple: "Unlock Pro in the Still app on iPhone or Mac — Safari unlocks automatically.",
    dismiss: "Not now",
    // Purchase/restore outcome feedback (P1 #5). The sheet stays open through these.
    purchasing: "Completing your purchase…", // Apple's in-place native purchase only
    // Web checkout hand-off (U3→U4): the purchase continues in a NEW tab, not in place — the
    // Apple `purchasing` line would describe a purchase that hasn't started here.
    openingCheckout: "Opening checkout…",
    pending: "Waiting for approval — we'll unlock Pro as soon as it's confirmed.",
    cancelled: "Purchase cancelled.",
    failed: "Something went wrong. Please try again.",
    unavailable: "Still Pro isn't available right now. Try again in a moment.",
    restoring: "Restoring…",
    restoredNone: "No purchase to restore on this account.",
    // Success payoff (R6): rendered only after the entitlement store write has landed — see
    // UiController.justUnlocked for the one transition rule that drives it on every host.
    unlocked: "Pro unlocked. Enjoy the quiet.",
    // Web checkout-pending lifecycle (plan U4/R3): the popup died into the checkout tab and came
    // back to a persisted pending flag. Calm and honest at every stage: a capped fast-poll
    // ("checking"), a between-windows resting line ("quietPending" — reopening starts a fresh
    // window), an explicit escape for the most common outcome, abandonment ("startOver" — never a
    // 24h trap), and the >24h decay into the already-decided support path ("Find my purchase" =
    // mailto, docs/monetization-design.md).
    checking: "Checking your purchase…",
    quietPending: "Still checking — this can take a minute. Reopen this window to check again.",
    startOver: "I didn't finish checkout — start over",
    stalePending: "We haven't seen your purchase yet. If you paid, we'll find it together.",
    findMyPurchase: "Find my purchase",
    retryCheckout: "Try checkout again",
    // Session died mid-checkout (401 → auth-required): the remedy is re-sign-in, never teardown —
    // the pending flag and the cached entitlement both survive (KTD auth-required semantics).
    authRequired: "You've been signed out. Sign in again to check your purchase.",
    signInAgain: "Sign in again",
  },

  auth: {
    title: "Sign in to Still",
    prompt: "Your Pro unlock and settings follow your account across iPhone, iPad, and Mac.",
    notNow: "Not now",
    emailLabel: "Email",
    emailPlaceholder: "you@email.com",
    send: "Email me a link",
    sending: "Sending…",
    sent: "Check your email for a sign-in link.",
    error: "Couldn't send the link. Try again.",
    resend: "Resend link",
    signOut: "Sign out",
    apple: "Sign in with Apple",
    signInCta: "Sign in to sync",
    signingIn: "Signing in…",
  },

  // Email-OTP code entry (plan U2/R1) — the extension popup can't receive a magic-link redirect,
  // so it signs in with an emailed 6-digit code. None of these lines may say "link": the
  // magic-link strings above (auth.send/sent/error/resend) must never render in the code flow.
  // The Apple magic-link strings stay untouched.
  codeAuth: {
    send: "Email me a code",
    prompt: "Check your email for a 6-digit code.",
    sentTo: "Sent to",
    codeLabel: "6-digit code",
    verify: "Verify code",
    verifying: "Checking…",
    wrongCode: "That code didn't match. Check it and try again.",
    expiredCode: "That code has expired. Send a new one to continue.",
    requestNew: "That code isn't working. Send a new one to continue.",
    verifyError: "Couldn't check the code. Try again.",
    sendError: "Couldn't send the code. Try again.",
    resendError: "Couldn't send a new code. The last one may still work.",
    resend: "Send a new code",
    resendWait: "Send a new code in", // the sheet appends the live countdown, e.g. "… in 42s"
    differentEmail: "Use a different email",
  },

  sync: {
    pending: "Checking your account…",
    syncing: "Synced across your devices.",
    unreachable: "Sync paused — no connection.",
    firstSync: "Your settings now match your other devices.",
  },

  // Account management (App Store Guideline 5.1.1): in-app deletion + a reachable privacy policy.
  account: {
    privacyPolicy: "Privacy policy",
    delete: "Delete account",
    deleteConfirmTitle: "Delete your account?",
    deleteConfirmBody: "This permanently deletes your account, settings, and purchase record from sync. This can't be undone.",
    deleteConfirm: "Delete account",
    deleteCancel: "Cancel",
    deleting: "Deleting…",
    deleteError: "Couldn't delete your account. Try again.",
  },
} as const;
