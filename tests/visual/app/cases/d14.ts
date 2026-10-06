// D14 extension first-run: ui_kits/still-app/d14-first-run.html + FirstRun.babel.
import FirstRun from "../../../../packages/core/src/ui/v3/FirstRun.svelte";
import type { FirstRunProps } from "../../../../packages/core/src/ui/v3/first-run-presentation.js";
import { noop } from "../fixtures.js";
import type { FrameSpec, Rendered, ScreenCases, VisualCase } from "../types.js";
import { OWNER_SYNC_COPY } from "./shared.js";

const screen = "d14-extension-first-run";

// review.babel REVIEW_PURPOSES: the reference's bracketed placeholder purposes.
const REVIEW_PURPOSES = [
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

/**
 * FirstRun.babel props. The reference's owner-pending wording (lede, permission and pin
 * instructions) is supplied as verified caller guidance, which is how the component receives it.
 */
function firstRun({
  browser = "chrome",
  permission = "granted",
  pinned = false,
  consent = "unasked",
  signedIn = false,
}: {
  browser?: "chrome" | "firefox";
  permission?: "needed" | "pending" | "denied" | "granted";
  pinned?: boolean;
  consent?: "unasked" | "on" | "off" | "none";
  signedIn?: boolean;
}): () => Rendered {
  const name = browser === "chrome" ? "Chrome" : "Firefox";
  return () => ({
    component: FirstRun,
    props: {
      browser,
      permission: {
        state: permission,
        verified: true,
        requestVerified: true,
        onRequest: noop,
        guidance: {
          verified: true,
          text: `${name} asks once. Still only runs on these four sites.`,
        },
      },
      blocking: {
        state: permission === "granted" ? "on" : "off",
        verified: true,
      },
      setupDescription: {
        verified: true,
        text: "Allow Still on the sites it works on, and it starts right away.",
      },
      pin: {
        pinned,
        verified: true,
        guidance: {
          verified: true,
          text:
            browser === "chrome"
              ? "Click the puzzle piece in the toolbar, then the pin next to Still."
              : "Click the puzzle piece in the toolbar, then the gear next to Still, then Pin to toolbar.",
        },
      },
      sync: {
        account: signedIn
          ? { address: "sam@example.com", confirmed: true }
          : undefined,
        onSignIn: noop,
      },
      // "none" draws no consent card at all (reference d14-03, redrawn 2026-10-05).
      consent:
        consent === "none"
          ? undefined
          : consent === "unasked"
            ? {
                status: "unasked",
                purposes: REVIEW_PURPOSES,
                purposesVerified: true,
                onShare: noop,
                onDecline: noop,
              }
            : { status: "saved", choice: consent },
      settings: { verified: true, onOpen: noop },
      privacy: { verified: true, onOpen: noop },
    } satisfies FirstRunProps,
  });
}

const tab = (
  w: number,
  h: number,
  scale?: number,
): Extract<FrameSpec, { kind: "device" }> => ({
  kind: "device",
  device: "tab",
  w,
  h,
  url: "Welcome to Still",
  ...(scale ? { scale } : {}),
});
const base = { screen, component: "FirstRun", textScale: 1 } as const;
const signedOut = [OWNER_SYNC_COPY];

const cases: VisualCase[] = [
  {
    ...base,
    id: "d14-01",
    reference: "01-chrome-just-installed-600-1000.png",
    caption: "Chrome · just installed",
    theme: "light",
    width: 600,
    frame: tab(600, 1000),
    render: firstRun({}),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d14-02",
    reference: "02-chrome-pinned-signed-in-consent-answered-600-1000.png",
    caption: "Chrome · pinned, signed in, consent answered",
    theme: "dark",
    width: 600,
    frame: tab(600, 1000),
    render: firstRun({ pinned: true, signedIn: true, consent: "off" }),
  },
  {
    ...base,
    id: "d14-03",
    reference: "03-firefox-permission-needed-420-960.png",
    caption: "Firefox · permission needed",
    theme: "light",
    width: 420,
    // Redrawn 2026-10-05 (owner decision 58): no browser tab header, no combined consent card, and
    // the approved sync wording, so there is no deviation left to declare. `r-bare` hides the
    // simulated tab bar through the package's review.css.
    frame: { ...tab(420, 960), cls: "r-bare" },
    render: firstRun({
      browser: "firefox",
      permission: "needed",
      consent: "none",
    }),
  },
  {
    ...base,
    id: "d14-04",
    reference: "04-firefox-waiting-420-960.png",
    caption: "Firefox · waiting",
    theme: "dark",
    width: 420,
    frame: tab(420, 960),
    render: firstRun({
      browser: "firefox",
      permission: "pending",
      consent: "off",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d14-05",
    reference: "05-firefox-not-allowed-420-960.png",
    caption: "Firefox · not allowed",
    theme: "light",
    width: 420,
    frame: tab(420, 960),
    render: firstRun({
      browser: "firefox",
      permission: "denied",
      consent: "on",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d14-06",
    reference: "06-320-wide-1-5-text-320-1100-text-1-5.png",
    caption: "320 wide · 1.5× text",
    theme: "light",
    width: 320,
    textScale: 1.5,
    frame: tab(320, 1100, 1.5),
    render: firstRun({
      browser: "firefox",
      permission: "needed",
      consent: "off",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d14-07",
    reference: "07-keyboard-focus-on-allow-480-760.png",
    caption: "Keyboard · focus on Allow",
    theme: "dark",
    width: 480,
    // The reference draws `.kbd-allow` (a simulated outline); the harness reaches Allow by Tab.
    frame: { ...tab(480, 760), cls: "kbd-allow" },
    render: firstRun({
      browser: "firefox",
      permission: "needed",
      consent: "off",
    }),
    focus: { selector: ".step .a button.primary" },
    deviations: signedOut,
  },
];

// Every D14 frame receives its wording from the caller: the setup lede, the permission and pin
// guidance, and (when consent is unasked) the reference's bracketed placeholder purposes.
const CALLER_COPY =
  "proves layout with the supplied copy (setup lede, permission and pin guidance, placeholder consent purposes from the reference), not production caller wiring";

export const D14: ScreenCases = {
  screen,
  page: "ui_kits/still-app/d14-first-run.html",
  cases: cases.map((c) => ({ ...c, callerCopy: CALLER_COPY })),
};
