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
  // Value copy is launch-real: only shipped capabilities (Reels/TikTok/Facebook blocking + sync) —
  // no YT recs/comments bullets until that feature exists. Never mention web pricing here (3.1.3).
  paywall: {
    title: "Still Pro",
    body: "Quiets Instagram Reels, TikTok, and Facebook too — with your settings synced on every device. One purchase, not a subscription.",
    cta: "Unlock Pro",
    restore: "Restore purchase",
    // Hosts without a purchase path (the browser extensions): explanatory only (R19). Safari
    // genuinely unlocks by itself via the App-Group entitlement pull once the app purchase lands.
    nonApple: "Unlock Pro in the Still app on iPhone or Mac — Safari unlocks automatically. Chrome and Firefox unlock is on the way.",
    dismiss: "Not now",
    // Purchase/restore outcome feedback (P1 #5). The sheet stays open through these.
    purchasing: "Completing your purchase…",
    pending: "Waiting for approval — we'll unlock Pro as soon as it's confirmed.",
    cancelled: "Purchase cancelled.",
    failed: "Something went wrong. Please try again.",
    unavailable: "Still Pro isn't available right now. Try again in a moment.",
    restoring: "Restoring…",
    restoredNone: "No purchase to restore on this account.",
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
