// System gallery (gallery/index.html): component specimens. Only the D29 TikTok blocked page
// frames (Gallery.babel section "D29", 300x420 panes) belong to the V1 screen list; the rest are
// reported as outside it.
import TikTokBlocked from "../../../../packages/core/src/ui/v3/TikTokBlocked.svelte";
import type {
  TikTokActionPort,
  TikTokBlockedPresentation,
} from "../../../../packages/core/src/ui/v3/tiktok-blocked-presentation.js";
import { noop } from "../fixtures.js";
import type { ScreenCases, VisualCase } from "../types.js";

const screen = "system-gallery";

/**
 * A current, verified caller observation with every action port ready, so nothing renders
 * held. These are fixture bindings only; they prove no native tab allowance.
 */
function presentation(
  host: TikTokBlockedPresentation["host"],
  state: TikTokBlockedPresentation["state"],
): TikTokBlockedPresentation {
  const identity = {
    request: "visual-request",
    tab: "visual-tab",
    document: "visual-document",
  };
  const binding = {
    identity,
    observation: "visual-observation",
    verified: true,
    fresh: true,
  };
  const port = (): TikTokActionPort => ({
    ...binding,
    identity: { ...identity },
    status: "ready",
    request: noop,
  });
  return {
    ...binding,
    host,
    state,
    capability: { ...binding, identity: { ...identity }, status: "supported" },
    requestConfirmation: port(),
    confirmOpen: port(),
    cancel: port(),
    settings: port(),
    reload: port(),
    outcome:
      state === "reload"
        ? {
            ...binding,
            identity: { ...identity },
            status: "granted-reload-needed",
            destinationValidated: true,
          }
        : undefined,
  };
}

const base = {
  screen,
  component: "TikTokBlocked",
  width: 300,
  textScale: 1,
  frame: { kind: "gallery", width: 300, height: 420 },
} as const;

const cases: VisualCase[] = [
  {
    ...base,
    id: "d29-28",
    reference: "28-browser.png",
    caption: "Browser",
    theme: "light",
    render: () => ({
      component: TikTokBlocked,
      props: { presentation: presentation("browser", "blocked") },
    }),
  },
  {
    ...base,
    id: "d29-29",
    reference: "29-confirmation.png",
    caption: "Confirmation",
    theme: "dark",
    render: () => ({
      component: TikTokBlocked,
      props: { presentation: presentation("browser", "confirmation") },
    }),
  },
  {
    ...base,
    id: "d29-30",
    reference: "30-iphone-safari-reload-needed.png",
    caption: "iPhone Safari · reload needed",
    theme: "light",
    render: () => ({
      component: TikTokBlocked,
      props: { presentation: presentation("ios", "reload") },
    }),
  },
];

export const GALLERY: ScreenCases = {
  screen,
  page: "gallery/index.html",
  cases,
  defaultUnmappedReason:
    "gallery component specimen, not a V1 screen frame (screens are compared on their D-pages)",
};
