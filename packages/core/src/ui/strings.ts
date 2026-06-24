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
    price: "$2.99",
    cta: "Get Still Sync",
    restore: "Restore purchase",
    // Non-Apple desktop: no purchase path, explanatory only (R19).
    nonApple: "Buy once on iPhone, iPad, or Mac — sync turns on here when you sign in.",
    dismiss: "Not now",
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
  },

  sync: {
    pending: "Checking your account…",
    syncing: "Synced across your devices.",
    unreachable: "Sync paused — no connection.",
    firstSync: "Your settings now match your other devices.",
  },
} as const;
