// D18–D20, D24, D25 purchase and Restore: ui_kits/still-app/d18-purchase.html + Purchase.babel.
import PurchaseView from "../../../../packages/core/src/ui/v3/PurchaseView.svelte";
import PurchaseSignInSheet from "../../../../packages/core/src/ui/v3/PurchaseSignInSheet.svelte";
import CheckoutReturn from "../../../../packages/core/src/ui/v3/CheckoutReturn.svelte";
import type { PurchaseViewProps } from "../../../../packages/core/src/ui/v3/purchase-presentation.js";
import type {
  PurchaseSignInOperation,
  PurchaseSignInSheetProps,
} from "../../../../packages/core/src/ui/v3/purchase-signin-presentation.js";
import type { CheckoutReturnProps } from "../../../../packages/core/src/ui/v3/checkout-return-presentation.js";
import { noop } from "../fixtures.js";
import type {
  FrameSpec,
  Rendered,
  ScreenCases,
  VisualCase,
  Deviation,
} from "../types.js";

const screen = "d18-d20-d24-d25-purchase-and-restore";

// Purchase.babel ProList: RDS.ProControlList() (browser and Mac) or MOBILE_PRO (no sidebar ads).
const PRO_CONTROLS = [
  { site: "YouTube", label: "Related videos" },
  { site: "YouTube", label: "End-of-video suggestions" },
  { site: "YouTube", label: "Autoplay prevention" },
  { site: "YouTube", label: "Comments" },
  { site: "YouTube", label: "Live chat" },
  { site: "Instagram", label: "Stories and Highlights" },
  { site: "Instagram", label: "Explore recommendations" },
  { site: "Instagram", label: "Suggested accounts" },
  { site: "Instagram", label: "Threads links" },
  { site: "Facebook", label: "Facebook Stories" },
  { site: "Facebook", label: "Videos and Watch" },
  { site: "Facebook", label: "Desktop sidebar ads" },
];
const MOBILE_CONTROLS = PRO_CONTROLS.filter(
  (c) => c.label !== "Desktop sidebar ads",
);

// The design's sample offer ($9.99) stands in for a verified store offer; the view never shows it.
const OFFER = { price: "$9.99", verified: true };
const NOT_OWNED = { state: "none", verified: true } as const;

type Restore = NonNullable<PurchaseViewProps["restore"]>;

/** ProView({ host: 'browser', signedIn, channel, state, owned, checking, restore }). */
function browserView(
  options: {
    signedIn?: boolean;
    channel?: PurchaseViewProps["channel"];
    purchase?: PurchaseViewProps["purchase"];
    access?: PurchaseViewProps["access"];
    restore?: Restore;
  } = {},
): Extract<PurchaseViewProps, { host: "browser" }> {
  return {
    host: "browser",
    controls: PRO_CONTROLS,
    access: options.access ?? NOT_OWNED,
    channel: options.channel ?? "ready",
    offer: OFFER,
    purchase: options.purchase ?? { state: "idle" },
    restore: options.restore,
    onBack: noop,
    account: options.signedIn
      ? { id: "account-1", confirmed: true }
      : undefined,
    checkout: { verified: true, onRequest: noop },
    restorePort: { verified: true, onRequest: noop },
    onSignIn: noop,
  };
}

/** ProView({ host: 'apple', mobile, state, owned, restore }). */
function appleView(
  options: {
    mobile?: boolean;
    purchase?: PurchaseViewProps["purchase"];
    access?: PurchaseViewProps["access"];
    restore?: Restore;
  } = {},
): Extract<PurchaseViewProps, { host: "apple" }> {
  return {
    host: "apple",
    controls: options.mobile ? MOBILE_CONTROLS : PRO_CONTROLS,
    access: options.access ?? NOT_OWNED,
    channel: "ready",
    offer: OFFER,
    purchase: options.purchase ?? { state: "idle" },
    restore: options.restore,
    onBack: noop,
    native: { verified: true, onBuy: noop, onRestore: noop },
  };
}

const view =
  (props: PurchaseViewProps): (() => Rendered) =>
  () => ({ component: PurchaseView, props: { ...props } });

/** SignInToBuy: the signed-out Still Pro view with the sign-in sheet open at the email step. */
function signIn(purpose: "purchase" | "restore"): () => Rendered {
  const operation: PurchaseSignInOperation = {
    requestId: "request-1",
    ownerId: "owner-1",
    purpose,
  };
  const port = { operation, verified: true, onRequest: noop };
  return () => ({
    component: PurchaseSignInSheet,
    props: {
      open: true,
      operation,
      observation: { operation, verified: true, state: "email" },
      email: "",
      code: "",
      emailInput: port,
      codeInput: port,
      send: port,
      verify: port,
      dismiss: port,
      background: browserView(),
    } satisfies PurchaseSignInSheetProps,
  });
}

/** ReturnPage({ state }). */
function checkoutReturn(
  state: "confirming" | "ready" | "unconfirmed" | "cancelled",
): () => Rendered {
  const requestId = "checkout-1";
  const action = { requestId, verified: true, onRequest: noop };
  const outcome: CheckoutReturnProps["outcome"] =
    state === "cancelled"
      ? { requestId, verified: true, source: "provider", state }
      : { requestId, verified: true, source: "server", state };
  return () => ({
    component: CheckoutReturn,
    props: {
      requestId,
      outcome,
      retry: { ...action, pending: false },
      settings: action,
      support: action,
      privacy: action,
    } satisfies CheckoutReturnProps,
  });
}

const PHONE = {
  device: "iphoneapp",
  w: 393,
  h: 852,
  safeTop: 59,
  safeBottom: 34,
} as const;
const proTab = (w: number, h: number, scale?: number): FrameSpec => ({
  kind: "device",
  device: "tab",
  w,
  h,
  url: "Still · Still Pro",
  ...(scale ? { scale } : {}),
});
const returnTab: FrameSpec = {
  kind: "device",
  device: "tab",
  w: 420,
  h: 560,
  url: "still.app/purchase/return",
};
const phone: FrameSpec = { kind: "device", ...PHONE };

function frame(
  index: number,
  reference: string,
  caption: string,
  component: string,
  theme: "light" | "dark",
  spec: FrameSpec,
  render: () => Rendered,
  extra: Partial<VisualCase> = {},
): VisualCase {
  const width = spec.kind === "device" ? spec.w : 0;
  const textScale = spec.kind === "device" ? (spec.scale ?? 1) : 1;
  return {
    id: `d18-${String(index).padStart(2, "0")}`,
    screen,
    reference,
    caption,
    component,
    theme,
    width,
    textScale,
    frame: spec,
    render,
    ...extra,
  };
}

// Owner decision 16 keeps the sheet's accessible behaviour: the email field takes focus when the
// sheet opens, and the Still Pro view behind the sheet is inert. The references draw neither.
const SIGN_IN_DEVIATIONS: Deviation[] = [
  {
    reason:
      "owner decision 16: email field autofocus ring (the reference draws no focus)",
    selector: 'input[type="email"]',
    pad: 6,
  },
  {
    reason:
      "owner decision 16: inert background, so Back to settings renders disabled (grey) where the reference link is blue",
    selector: ".ob-top .link",
  },
];
// The return pages' references keep the review-only demonstration label (only the sign-in and
// account frames were re-captured without it); the shipped page never draws it.
const DEMO_MARK =
  "reference draws the review-only demonstration label that the shipped page never renders";

const cases: VisualCase[] = [
  frame(
    1,
    "01-chrome-signed-out-520-860.png",
    "Chrome · signed out",
    "PurchaseView",
    "light",
    proTab(520, 860),
    view(browserView()),
  ),
  frame(
    2,
    "02-iphone-still-app-393-852.png",
    "iPhone · Still app",
    "PurchaseView",
    "dark",
    phone,
    view(appleView({ mobile: true })),
  ),
  frame(
    3,
    "03-mac-still-app-560-760.png",
    "Mac · Still app",
    "PurchaseView",
    "light",
    { kind: "device", device: "mac", w: 560, h: 760 },
    view(appleView()),
  ),
  frame(
    4,
    "04-waiting-for-checkout-420-820.png",
    "Waiting for checkout",
    "PurchaseView",
    "light",
    proTab(420, 820),
    view(browserView({ signedIn: true, purchase: { state: "pending" } })),
  ),
  frame(
    5,
    "05-waiting-for-apple-393-852.png",
    "Waiting for Apple",
    "PurchaseView",
    "light",
    phone,
    view(appleView({ mobile: true, purchase: { state: "pending" } })),
  ),
  frame(
    6,
    "06-not-confirmed-420-820.png",
    "Not confirmed",
    "PurchaseView",
    "dark",
    proTab(420, 820),
    view(browserView({ signedIn: true, purchase: { state: "failed" } })),
  ),
  frame(
    7,
    "07-checking-access-420-820.png",
    "Checking access",
    "PurchaseView",
    "light",
    proTab(420, 820),
    view(browserView({ access: { state: "checking", verified: true } })),
  ),
  frame(
    8,
    "08-firefox-channel-not-ready-420-820.png",
    "Firefox · channel not ready",
    "PurchaseView",
    "dark",
    proTab(420, 820),
    view(browserView({ channel: "unverified" })),
  ),
  frame(
    9,
    "09-sign-in-to-continue-420-820.png",
    "Sign in to continue",
    "PurchaseSignInSheet",
    "light",
    proTab(420, 820),
    signIn("purchase"),
    { deviations: SIGN_IN_DEVIATIONS },
  ),
  frame(
    11,
    "11-return-confirming-420-560.png",
    "Return · confirming",
    "CheckoutReturn",
    "light",
    returnTab,
    checkoutReturn("confirming"),
    {
      deviations: [DEMO_MARK],
    },
  ),
  frame(
    12,
    "12-return-ready-420-560.png",
    "Return · ready",
    "CheckoutReturn",
    "dark",
    returnTab,
    checkoutReturn("ready"),
    {
      deviations: [DEMO_MARK],
    },
  ),
  frame(
    13,
    "13-return-not-confirmed-420-560.png",
    "Return · not confirmed",
    "CheckoutReturn",
    "light",
    returnTab,
    checkoutReturn("unconfirmed"),
    {
      deviations: [DEMO_MARK],
    },
  ),
  frame(
    14,
    "14-return-cancelled-420-560.png",
    "Return · cancelled",
    "CheckoutReturn",
    "dark",
    returnTab,
    checkoutReturn("cancelled"),
    {
      deviations: [DEMO_MARK],
    },
  ),
  frame(
    15,
    "15-chrome-after-checkout-420-820.png",
    "Chrome · after checkout",
    "PurchaseView",
    "light",
    proTab(420, 820),
    view(
      browserView({
        signedIn: true,
        purchase: { state: "success", confirmed: true },
      }),
    ),
  ),
  frame(
    16,
    "16-iphone-after-apple-393-852.png",
    "iPhone · after Apple",
    "PurchaseView",
    "dark",
    phone,
    view(
      appleView({
        mobile: true,
        purchase: { state: "success", confirmed: true },
      }),
    ),
  ),
  frame(
    17,
    "17-apple-checking-393-852.png",
    "Apple · checking",
    "PurchaseView",
    "light",
    phone,
    view(
      appleView({
        mobile: true,
        restore: { state: "checking", verified: true },
      }),
    ),
  ),
  frame(
    18,
    "18-apple-restored-393-852.png",
    "Apple · restored",
    "PurchaseView",
    "dark",
    phone,
    view(
      appleView({
        mobile: true,
        access: { state: "owned", verified: true },
        restore: { state: "restored", verified: true, conclusive: true },
      }),
    ),
  ),
  frame(
    19,
    "19-apple-nothing-found-393-852.png",
    "Apple · nothing found",
    "PurchaseView",
    "light",
    phone,
    view(
      appleView({
        mobile: true,
        restore: { state: "nothing", verified: true, conclusive: true },
      }),
    ),
  ),
  frame(
    20,
    "20-browser-couldn-t-finish-420-820.png",
    "Browser · couldn't finish",
    "PurchaseView",
    "dark",
    proTab(420, 820),
    view(
      browserView({
        signedIn: true,
        restore: { state: "failed", verified: true, onAction: noop },
      }),
    ),
  ),
  frame(
    21,
    "21-browser-needs-verification-420-820.png",
    "Browser · needs verification",
    "PurchaseView",
    "light",
    proTab(420, 820),
    view(
      browserView({
        signedIn: true,
        restore: { state: "verify", verified: true, onAction: noop },
      }),
    ),
  ),
  frame(
    22,
    "22-browser-sign-in-to-restore-420-820.png",
    "Browser · sign in to restore",
    "PurchaseSignInSheet",
    "dark",
    proTab(420, 820),
    signIn("restore"),
    { deviations: SIGN_IN_DEVIATIONS },
  ),
  frame(
    23,
    "23-iphone-se-xxxlarge-375-667-text-1-35.png",
    "iPhone SE · xxxLarge",
    "PurchaseView",
    "light",
    {
      kind: "device",
      device: "iphoneapp",
      w: 375,
      h: 667,
      safeTop: 20,
      scale: 1.35,
    },
    view(appleView({ mobile: true })),
  ),
  frame(
    24,
    "24-320-wide-1-5-text-320-900-text-1-5.png",
    "320 wide · 1.5× text",
    "PurchaseView",
    "light",
    proTab(320, 900, 1.5),
    view(browserView({ signedIn: true })),
  ),
];

export const D18: ScreenCases = {
  screen,
  page: "ui_kits/still-app/d18-purchase.html",
  cases,
  unmapped: {
    "10-payment-provider-not-drawn.png":
      "placeholder for the payment provider's own checkout page; Still never draws it, so there is no component to mount",
  },
};
