// The browser rating card's one fresh owner allowance (U13-P3). The only importer of the policy
// client. background.ts loads this module on first use, behind the inline V3 build gate, and hands
// its `freshCheck` to the shared invitation handler (lib/invitation-background.ts), which asks it
// only for an opening the ledger would offer the rating card.
//
// Rules:
//   * Always the fresh check (`freshCheck("rating")`): the ordinary policy cache is never read, so a
//     cached On can never authorize a card.
//   * The policy surface is this build's own: Chrome is chrome_desktop. The Firefox build is one
//     package for desktop Firefox and Firefox for Android, and only the browser can say which:
//     `runtime.getPlatformInfo().os === "android"` is firefox_android, any other answer is
//     firefox_desktop. No answer (a missing API, a failure, no reply within a second) is Off, never
//     a guess, so a phone can never be authorized by the desktop allowance.
//   * No identifier, analytics or notification. The request is the policy client's one plain read.

import type { RatingAllowance } from "@still/core/invitations/rating-allowance";
import {
  createChromeProductPolicyRuntime, type ProductPolicyRuntime, type ProductPolicyRuntimeOptions,
} from "./product-policy-runtime.js";

/** A policy surface, as the policy client names it. */
type ProductPolicySurface = ProductPolicyRuntimeOptions["surface"];

/** How long to wait for the browser's platform answer before the allowance is Off. */
export const PLATFORM_ANSWER_LIMIT_MS = 1_000;

export interface PlatformInfoSource {
  getPlatformInfo?: () => Promise<{ os: string }>;
}

/** Firefox only: "android" or "desktop" from the browser itself, or null when it did not answer. */
export async function firefoxPlatform(
  runtime: PlatformInfoSource | undefined, limitMs = PLATFORM_ANSWER_LIMIT_MS,
): Promise<"android" | "desktop" | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = runtime?.getPlatformInfo?.();
    if (!answer) return null;
    const info = await Promise.race([
      answer,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), limitMs); }),
    ]);
    if (!info || typeof info.os !== "string" || info.os.length === 0) return null;
    return info.os === "android" ? "android" : "desktop";
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The policy surface whose allowance this build needs, or null when it cannot be known. */
export async function ratingPolicySurfaceFor(
  isFirefox: boolean, runtime: PlatformInfoSource | undefined, limitMs = PLATFORM_ANSWER_LIMIT_MS,
): Promise<ProductPolicySurface | null> {
  if (!isFirefox) return "chrome_desktop";
  const platform = await firefoxPlatform(runtime, limitMs);
  return platform === "android" ? "firefox_android" : platform === "desktop" ? "firefox_desktop" : null;
}

export interface BrowserRatingAllowanceOptions {
  readonly isFirefox: boolean;
  /** The configured project URL, or undefined (then every check is Off, with no request). */
  readonly supabaseUrl: string | undefined;
  readonly production: boolean;
  /** The packaged build identifier the policy allowlists (the manifest version). */
  readonly build: string;
  readonly runtime: PlatformInfoSource | undefined;
  /** Test seam: the policy client for a surface. Production uses the chrome.storage.local one. */
  readonly policyFor?: (surface: ProductPolicySurface) => Pick<ProductPolicyRuntime, "freshCheck">;
  readonly platformLimitMs?: number;
}

const OFF = (reason: string): RatingAllowance => ({ allowed: false, reason });

/** One fresh rating allowance per call, for this build's own policy surface. Never throws. */
export function browserRatingAllowance(options: BrowserRatingAllowanceOptions): () => Promise<RatingAllowance> {
  const policyFor = options.policyFor ?? ((surface: ProductPolicySurface) => createChromeProductPolicyRuntime({
    supabaseUrl: options.supabaseUrl,
    environment: options.production ? "production" : "sandbox",
    surface,
    build: options.build,
  }));
  const clients = new Map<ProductPolicySurface, Pick<ProductPolicyRuntime, "freshCheck">>();
  return async () => {
    try {
      const surface = await ratingPolicySurfaceFor(options.isFirefox, options.runtime, options.platformLimitMs);
      if (surface === null) return OFF("platform");
      let client = clients.get(surface);
      if (!client) {
        client = policyFor(surface);
        clients.set(surface, client);
      }
      // Always the fresh check. The ordinary cache is never an allowance.
      const verdict = await client.freshCheck("rating");
      return { allowed: verdict.allowed, reason: verdict.reason };
    } catch {
      return OFF("context");
    }
  };
}
