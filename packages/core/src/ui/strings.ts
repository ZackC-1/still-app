import type { ServiceId } from "@still/shared-types";

// Outcome-phrased copy (spec §3.2): point at the result, never the mechanism. Sentence case.
// A settings row describes a steady state of the world, not an action.

export const STRINGS = {
  appName: "Still",

  global: {
    on: "Still is on",
    off: "Still is off",
    // The one "Still is on" line everyone sees, because every service is included. "On enabled
    // sites" already hedges per-service state, so it needs no variant for a row someone turned off.
    onSecondary: "Short-form video is removed on enabled sites.",
    // The two lines below belong to the dormant paid tier, where the included set was YouTube
    // Shorts only and the hero had to say what the rest cost. They return with PAID_TIER_ENABLED.
    onFree: "YouTube Shorts are removed. Still Pro adds Reels, TikTok, and sync.",
    // Free user with the YouTube row itself toggled off: Still is on but removing nothing, so the
    // hero must not claim removal (it would contradict the row, PR #96 review). Mirrors the row's
    // own off voice ("Shorts are showing.") and keeps the Pro line.
    onFreeYoutubeOff:
      "YouTube Shorts are showing. Still Pro adds Reels, TikTok, and sync.",
    offSecondary: "Turn Still on to remove short-form video.",
  },

  // Each row is named for what Still removes there rather than for the site, so the same words
  // appear in the app, on the store listings, and on the website.
  services: {
    youtube: {
      name: "YouTube Shorts",
      on: "Shorts are gone.",
      off: "Shorts are showing.",
    },
    instagram: {
      name: "Instagram Reels",
      on: "Reels are gone.",
      off: "Reels are showing.",
    },
    tiktok: {
      name: "TikTok website",
      on: "TikTok stays closed.",
      off: "TikTok is open.",
    },
    facebook: {
      name: "Facebook Reels",
      on: "Reels are gone.",
      off: "Reels are showing.",
    },
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
    headline: "Make every supported browser feel this quiet",
    body: "Remove Instagram Reels and Facebook Reels, block the TikTok website, and keep settings synced across supported browsers and devices.",
    scope:
      "On iPhone and iPad, Still works in Safari only. It does not block short-form video inside native apps.",
    reassurance: "One purchase. No subscription.",
    cta: "Get Still Pro",
    // Home-screen upgrade CTA (signed-out and signed-in-not-entitled states) — routes through
    // UiController.startUpgrade(), never straight to checkout.
    upgradeCta: "Get Still Pro",
    restore: "Restore purchase",
    // Safari only (AE7/3.1.1): its popup has no purchase path — Pro genuinely unlocks by itself
    // via the App-Group entitlement pull once the app purchase lands. Web-purchasable hosts
    // (Chrome/Firefox) never render this line; they get the real checkout flow instead (U4/U6).
    nonApple:
      "Unlock Pro in the Still app on iPhone or Mac — Safari unlocks automatically.",
    dismiss: "Not now",
    // Purchase/restore outcome feedback (P1 #5). The sheet stays open through these.
    purchasing: "Completing your purchase…", // Apple's in-place native purchase only
    // Web checkout hand-off (U3→U4): the purchase continues in a NEW tab, not in place — the
    // Apple `purchasing` line would describe a purchase that hasn't started here.
    openingCheckout: "Opening checkout…",
    pending:
      "Waiting for approval — we'll unlock Pro as soon as it's confirmed.",
    cancelled: "Purchase cancelled.",
    failed: "Something went wrong. Please try again.",
    unavailable: "Still Pro isn't available right now. Try again in a moment.",
    restoring: "Restoring…",
    // Account-agnostic by design (R4): the signed-out purchase-first flow has no account to blame —
    // "on this account" would presuppose one the user was never asked to create.
    restoredNone: "No purchase found on this device.",
    // Signed-out relabel of the SAME secondary restore button (one affordance, one wording): the
    // question a signed-out returner is actually asking (R4/AE11).
    restoreSignedOut: "Already purchased? Restore",
    // Pre-purchase reassurance on the signed-out paywall (5.1.1 resubmission): tells the buyer the
    // account option comes later, pre-empting both user and reviewer doubt. Apple-host-only render
    // (web checkout paywalls are always signed-in by construction).
    noAccountNeeded: "No account needed — you can add sync later.",
    // The R15 stale-identity outcome: signed out, but the purchase identity couldn't be verified
    // anonymous. The remedy is a retry (native reset-then-purchase) — NEVER a sign-out instruction
    // (the user already is signed out).
    staleIdentity: "We couldn't start the purchase. Try again.",
    retryPurchase: "Try again",
    // Success payoff (R6): rendered only after the entitlement store write has landed — see
    // UiController.justUnlocked for the one transition rule that drives it on every host.
    unlocked: "Your quieter web is ready.",
    // Web checkout-pending lifecycle (plan U4/R3): the popup died into the checkout tab and came
    // back to a persisted pending flag. Calm and honest at every stage: a capped fast-poll
    // ("checking"), a between-windows resting line ("quietPending" — reopening starts a fresh
    // window), an explicit escape for the most common outcome, abandonment ("startOver" — never a
    // 24h trap), and the >24h decay into the already-decided support path ("Find my purchase" =
    // mailto, docs/monetization-design.md).
    checking: "Checking your purchase…",
    quietPending:
      "Still checking — this can take a minute. Reopen this window to check again.",
    startOver: "I didn't finish checkout — start over",
    stalePending:
      "We haven't seen your purchase yet. If you paid, we'll find it together.",
    findMyPurchase: "Find my purchase",
    retryCheckout: "Try checkout again",
    // Session died mid-checkout (401 → auth-required): the remedy is re-sign-in, never teardown —
    // the pending flag and the cached entitlement both survive (KTD auth-required semantics).
    authRequired:
      "You've been signed out. Sign in again to check your purchase.",
    signInAgain: "Sign in again",
  },

  // The post-purchase success screen (R3, purchase-first — plan 2026-07-15-001). A dedicated
  // presentation with NO auto-dismiss: two equal-weight choices signed out; a sync confirmation
  // signed in (never an account pitch at someone with a session). Value copy is launch-real —
  // only shipped capabilities; supported-surface phrasing per product truths. The reassurance
  // line mirrors Apple's own sanctioned framing for optional post-purchase registration.
  success: {
    title: "You're Pro",
    accountPitch:
      "Use Still Pro in Chrome, Firefox, and on your other devices — create a free account to sync your purchase and settings.",
    createAccount: "Create free account",
    notNow: "Not now",
    reassure:
      "Without an account, your purchase stays with your Apple Account. Restore Purchases brings it back anytime.",
    synced: "Still Pro is active and synced to your account.",
    done: "Done",
  },

  // The receipt-entitled, no-session home state (pro-no-account, R3/R9): Pro is active on this
  // device; sign-in is the optional path to the other surfaces. Never a buy CTA here.
  proNoAccount: {
    active: "Still Pro is active on this device.",
    hint: "Sign in to use Pro in your other browsers and sync your settings.",
  },

  auth: {
    title: "Sign in for settings sync",
    dismissLabel: "Dismiss sign in",
    // Says what an account is for and, in the same breath, that it is not required. Someone who
    // opened this sheet by accident should be able to close it without wondering what they lost.
    prompt:
      "Enter your email to get a 6-digit sign-in code. Sign-in is optional. Blocking works without an account.",
    cancel: "Cancel",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    invalidEmail: "Enter a valid email address to continue.",
    send: "Email me a link",
    sending: "Sending…",
    sent: "Check your email for a sign-in link.",
    error: "We couldn't sign you in. Try again.",
    resend: "Resend link",
    signOut: "Sign out",
    signInCta: "Sign in to sync",
  },

  // What a browser add-on store requires an extension to say, in its own interface, before it
  // collects an email address. Chrome's program policies want the disclosure at the point of
  // collection rather than only behind a privacy-policy link; Firefox wants an explicit opt-in
  // before anything is collected at all. The Apple apps do not show this: their disclosure lives in
  // the App Store privacy label and the privacy policy, and an extra screen there would be a step
  // between someone and the thing they came for.
  emailConsent: {
    disclosureTitle: "Your email is only for sign-in",
    optInTitle: "Share your email for settings sync?",
    body: "Still uses your email address to send a 6-digit code and sync your settings across devices. Still does not collect your browsing history.",
    agree: "I agree to share my email for sign-in and settings sync.",
    proceed: "Continue",
    notNow: "Not now",
  },

  // Email-OTP code entry (plan U2/R1) — the extension popup can't receive a magic-link redirect,
  // so it signs in with an emailed 6-digit code. None of these lines may say "link": the
  // magic-link strings above (auth.send/sent/error/resend) must never render in the code flow.
  // Every live host (extensions and the Apple app, 2026-07-06) wires the code flow; the magic-link
  // strings stay only for the currently-unwired signIn() path.
  codeAuth: {
    send: "Send code",
    prompt: "Check your email for a 6-digit code.",
    sentTo: "Sent to",
    codeLabel: "6-digit code",
    verify: "Verify code",
    verifying: "Checking…",
    wrongCode: "That code didn't work. Check it and try again.",
    expiredCode: "That code has expired. Send a new one to continue.",
    requestNew: "That code isn't working. Send a new one to continue.",
    verifyError: "We couldn't sign you in. Try again.",
    sendError: "Couldn't send the code. Try again.",
    resendError: "Couldn't send a new code. The last one may still work.",
    // Rate-limit wait copy (R2/R3), split BY VIEW because honesty differs by context: the email
    // view's first-send block must never claim a code exists (under the hourly cap none was ever
    // sent); the code view MAY point back at the one already delivered. The verify line never
    // suggests requesting a new code — that's the worst advice during a verify lockout. sendBlocked
    // is countdown-led (the sheet appends the live seconds) because the review path's genuine
    // retry-after can be minutes, not the 60s default — a fixed "wait a minute" would misstate it.
    sendBlocked: "We can't send a code right now. Try again in", // sheet appends "… 42s"
    resendBlocked: "Too many codes requested. The code already in your email still works.",
    verifyBlocked: "Too many tries. You can enter the code again in", // sheet appends "… 42s"
    resend: "Send a new code",
    resendWait: "Send a new code in", // the sheet appends the live countdown, e.g. "… in 42s"
    differentEmail: "Use a different email",
  },

  // The settings-sync card. It is the only thing an account changes, so it says so plainly and
  // never implies that anything else depends on signing in.
  sync: {
    sectionTitle: "Settings sync",
    signedOut: "Sign in to keep your settings the same across your devices.",
    // Shown where there is no sign-in path at all, which today means the Safari extension popup:
    // App Store Review Guideline 4.4 keeps promotion out of an extension, so it states the fact
    // rather than advertising an account (the host app carries the invitation instead).
    deviceOnly: "Settings are saved on this device.",
    pending: "Getting Still ready.",
    syncing: "Syncing your settings.",
    unreachable:
      "Your settings are saved on this device. Still will sync them when it reconnects.",
    firstSync: "Your settings are now the same across your signed-in devices.",
  },

  // Account management (App Store Guideline 5.1.1): in-app deletion + a reachable privacy policy.
  account: {
    privacyPolicy: "Privacy policy",
    delete: "Delete account",
    deleteConfirmTitle: "Delete account?",
    // Names the one thing people are most likely to fear losing, and says they will not lose it.
    deleteConfirmBody:
      "This permanently deletes your Still account and synced settings. Blocking will keep working on this device.",
    deleteConfirm: "Delete account",
    deleteCancel: "Cancel",
    deleting: "Deleting…",
    deleteError: "Couldn't delete your account. Try again.",
  },
} as const;
