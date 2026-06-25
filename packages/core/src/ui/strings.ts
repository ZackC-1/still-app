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

  // One calm line, shown across the Shorts-no-id / Reels / TikTok placeholder contexts.
  placeholder: "Nothing here. That's the point.",

  paywall: {
    title: "Still Sync",
    body: "Your settings, on every device. Buy once.",
    cta: "Get Still Sync",
    restore: "Restore purchase",
    // Non-Apple desktop: no purchase path, explanatory only (R19).
    nonApple: "Buy once on iPhone, iPad, or Mac — sync turns on here when you sign in.",
    dismiss: "Not now",
    // Purchase/restore outcome feedback (P1 #5). The sheet stays open through these.
    purchasing: "Completing your purchase…",
    pending: "Waiting for approval — we'll unlock sync as soon as it's confirmed.",
    cancelled: "Purchase cancelled.",
    failed: "Something went wrong. Please try again.",
    unavailable: "Still Sync isn't available right now. Try again in a moment.",
    restoring: "Restoring…",
    restoredNone: "No purchase to restore on this account.",
  },

  auth: {
    prompt: "Sign in to sync your settings.",
    emailLabel: "Email",
    emailPlaceholder: "you@email.com",
    send: "Email me a link",
    sending: "Sending…",
    sent: "Check your email for a sign-in link.",
    error: "Couldn't send the link. Try again.",
    resend: "Resend link",
    signOut: "Sign out",
    apple: "Sign in with Apple",
    signingIn: "Signing in…",
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
