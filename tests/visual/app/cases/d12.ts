// D12 Apple onboarding: ui_kits/still-app/d12-apple-onboarding.html + AppleOnboarding.babel.
import AppleOnboarding from "../../../../packages/core/src/ui/v3/AppleOnboarding.svelte";
import type { AppleOnboardingProps } from "../../../../packages/core/src/ui/v3/apple-onboarding-presentation.js";
import { noop } from "../fixtures.js";
import type { FrameSpec, ScreenCases, VisualCase } from "../types.js";

const screen = "d12-apple-onboarding";

// Review-only sample wording from review.babel REVIEW_PURPOSES / AppleOnboarding.babel SAFARI_STEPS.
const PURPOSES = [
  {
    name: "Email",
    text: "[Approved purpose text: how your email is used with your usage data]",
  },
  {
    name: "Usage analytics",
    text: "[Provider]: which settings are used, so they can be improved.",
  },
  { name: "AI processing", text: "[Provider]: [approved purpose text]" },
];
const SAFARI_STEPS = {
  ios: [
    "Open the Settings app.",
    "Go to Apps, then Safari, then Extensions.",
    "Turn on Still and allow it on every website.",
  ],
  mac: [
    "Open Safari, then Settings, then Extensions.",
    "Turn on Still.",
    "Allow it on every website.",
  ],
};

function onboarding(
  step: AppleOnboardingProps["step"],
  platform: AppleOnboardingProps["platform"] = "ios",
  detect?: "waiting" | "on",
): () => { component: typeof AppleOnboarding; props: Record<string, unknown> } {
  return () => ({
    component: AppleOnboarding,
    props: {
      step,
      platform,
      onBack: noop,
      onContinue: noop,
      setup: {
        steps: SAFARI_STEPS[platform],
        actionLabel:
          platform === "mac" ? "Open Safari Settings" : "Open Settings",
        onOpen: noop,
      },
      detection: detect ? { state: detect, verified: true } : undefined,
      onAssertEnabled: noop,
      onDoLater: noop,
      consent: {
        status: "unasked",
        purposes: PURPOSES,
        purposesVerified: true,
        onShare: noop,
        onDecline: noop,
      },
      onOpenSafari: noop,
      onGoToSettings: noop,
    } satisfies AppleOnboardingProps,
  });
}

const PHONE = {
  device: "iphoneapp",
  w: 393,
  h: 852,
  safeTop: 59,
  safeBottom: 34,
} as const;
const phone = (scale?: number): FrameSpec => ({
  kind: "device",
  ...PHONE,
  scale,
});
const base = { screen, component: "AppleOnboarding", textScale: 1 } as const;

const cases: VisualCase[] = [
  ...([1, 2, 3, 4] as const).map((step): VisualCase => ({
    ...base,
    id: `d12-0${step}`,
    reference: `0${step}-iphone-15-step-${step}-393-852.png`,
    caption: `iPhone 15 · step ${step}`,
    theme: "light",
    width: 393,
    frame: phone(),
    render: onboarding(step),
  })),
  {
    ...base,
    id: "d12-05",
    reference: "05-iphone-15-step-1-393-852.png",
    caption: "iPhone 15 · step 1 (dark)",
    theme: "dark",
    width: 393,
    frame: phone(),
    render: onboarding(1),
  },
  {
    ...base,
    id: "d12-06",
    reference: "06-iphone-se-step-2-xxxlarge-375-667-text-1-35.png",
    caption: "iPhone SE · step 2 · xxxLarge",
    theme: "light",
    width: 375,
    textScale: 1.35,
    frame: {
      kind: "device",
      device: "iphoneapp",
      w: 375,
      h: 667,
      safeTop: 20,
      scale: 1.35,
    },
    render: onboarding(2),
  },
  {
    ...base,
    id: "d12-07",
    reference: "07-iphone-15-step-1-accessibility-size-393-852-text-2.png",
    caption: "iPhone 15 · step 1 · accessibility size",
    theme: "dark",
    width: 393,
    textScale: 2,
    frame: phone(2),
    render: onboarding(1),
  },
  {
    ...base,
    id: "d12-08",
    reference: "08-ipad-step-2-820-760.png",
    caption: "iPad · step 2",
    theme: "light",
    width: 820,
    frame: {
      kind: "device",
      device: "ipadapp",
      w: 820,
      h: 760,
      safeTop: 24,
      safeBottom: 20,
    },
    render: onboarding(2),
  },
  {
    ...base,
    id: "d12-09",
    reference: "09-mac-step-2-waiting-640-600.png",
    caption: "Mac · step 2 · waiting",
    theme: "light",
    width: 640,
    frame: { kind: "device", device: "mac", w: 640, h: 600 },
    render: onboarding(2, "mac", "waiting"),
  },
  {
    ...base,
    id: "d12-10",
    reference: "10-mac-step-2-on-640-600.png",
    caption: "Mac · step 2 · on",
    theme: "dark",
    width: 640,
    frame: { kind: "device", device: "mac", w: 640, h: 600 },
    render: onboarding(2, "mac", "on"),
  },
];

export const D12: ScreenCases = {
  screen,
  page: "ui_kits/still-app/d12-apple-onboarding.html",
  cases,
};
