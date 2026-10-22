// ISS-0032 (owner-approved design, 12 Oct 2026): Still Pro is visible and buyable from every popup
// and Settings, only while access is conclusively locked. The paid flag is replaced here before the
// components load (as ProOfferCard.paid-on.test.ts does), so this file is the paid-world matrix:
// every access state on every popup host (Chrome, Firefox, Mac Safari = DesktopPopup; Firefox for
// Android, iPhone Safari = MobilePopup), plus the Settings Still Pro card and its purchased state.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { FEATURE_REGISTRY, PAID_TIER_ENABLED, type AccessState } from "@still/shared-types";
import {
  DESKTOP_LAYOUT_ONLY_PRO,
  phoneLayoutFeatures,
} from "../../entitlement/access-policy.js";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import NativeProOfferCard from "./NativeProOfferCard.svelte";
import { fixture as desktopFixture } from "./DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";
import { POPUP_PRO_VALUE, type DesktopPopupProps } from "./presentation.js";
import type { MobilePopupProps } from "./mobile-presentation.js";

afterEach(cleanup);

/** Owner rule: no Still Pro copy states a number of extras, and the popup shows no price. */
const COUNT = /\b\d+ of the \d+\b|\b(?:12|twelve|9|nine|11|eleven) extras\b|extras work/i;
const PRICE = /[$€£]\s?\d|\d+[.,]\d\d|\bfree forever\b|\beverywhere\b/i;

type Surface = {
  name: string;
  kind: "desktop" | "mobile";
  browser?: "Chrome" | "Firefox";
  host?: "safari" | "firefox";
  appHandoff?: boolean;
};
const SURFACES: Surface[] = [
  { name: "Chrome popup", kind: "desktop", browser: "Chrome" },
  { name: "Firefox popup", kind: "desktop", browser: "Firefox" },
  // The Mac Safari host renders DesktopPopup with its Chrome-shaped browser label.
  { name: "Mac Safari popup", kind: "desktop", browser: "Chrome", appHandoff: true },
  { name: "Firefox for Android popup", kind: "mobile", host: "firefox" },
  { name: "iPhone Safari popup", kind: "mobile", host: "safari", appHandoff: true },
];

async function mountPopup(
  surface: Surface,
  state: AccessState,
  extra: Partial<DesktopPopupProps> = {},
) {
  const { props } = await desktopFixture(state);
  const seePro = vi.fn();
  const signIn = vi.fn();
  const common = {
    ...props,
    onSeePro: seePro,
    onSignIn: signIn,
    appHandoff: surface.appHandoff,
    ...extra,
  };
  if (surface.kind === "desktop") {
    const view = render(DesktopPopup, {
      props: { ...common, browser: surface.browser! } satisfies DesktopPopupProps,
    });
    return { view, seePro, signIn };
  }
  const { browser: _browser, ...mobile } = common;
  const view = render(MobilePopup, {
    props: { ...mobile, host: surface.host! } satisfies MobilePopupProps,
  });
  return { view, seePro, signIn };
}

const proCard = () => screen.queryByRole("region", { name: "Still Pro" });

describe.each(SURFACES)("$name, paid world", (surface) => {
  it("compiles with the paid tier on", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("locked: shows the compact Still Pro card under the site list, below Settings sync (owner, 19 Oct)", async () => {
    const { view, seePro } = await mountPopup(surface, "locked");
    const card = proCard()!;
    expect(card).toBeVisible();
    expect(card).toHaveClass("pro-entry");
    expect(within(card).getByRole("heading", { name: "Still Pro" })).toBeVisible();
    expect(within(card).getByText(POPUP_PRO_VALUE)).toBeVisible();
    expect(card.textContent).not.toMatch(COUNT);
    expect(card.textContent).not.toMatch(/\d/);
    expect(card.textContent).not.toMatch(PRICE);
    // Order: site list, Still Pro card, Settings sync, footer.
    const services = view.container.querySelector(".services")!;
    const sync = screen.getByRole("heading", { name: "Settings sync" }).closest("section")!;
    expect(services.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sync.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Get Still Pro opens the full offer; it never starts a payment (there is no purchase port).
    const get = within(card).getByRole("button", { name: "Get Still Pro" });
    await fireEvent.click(get);
    expect(seePro).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The plain "Purchase Still Pro" button is gone, and so is the old Safari "See Still Pro".
    expect(screen.queryByText("Purchase Still Pro")).toBeNull();
    expect(screen.queryByRole("button", { name: /See Still Pro in the Still app/ })).toBeNull();
  });

  it(`locked: ${surface.appHandoff ? "says" : "does not say"} "Opens the Still app"`, async () => {
    await mountPopup(surface, "locked");
    const get = screen.getByRole("button", { name: "Get Still Pro" });
    if (surface.appHandoff) {
      expect(get).toHaveAccessibleDescription("Opens the Still app");
      expect(within(proCard()!).getByText("Opens the Still app")).toBeVisible();
    } else {
      expect(get).not.toHaveAccessibleDescription();
      expect(within(proCard()!).queryByText("Opens the Still app")).toBeNull();
    }
  });

  it("locked: every drawn Still Pro row shows the lock chip, and each opens the offer", async () => {
    const { seePro } = await mountPopup(surface, "locked");
    let chips = 0;
    for (const site of ["Instagram", "Facebook", "YouTube"]) {
      const expander = screen.getByRole("button", { name: `${site} Blocker` });
      if (expander.getAttribute("aria-expanded") !== "true") await fireEvent.click(expander);
      const panel = screen.getByRole("group", { name: `${site} Blocker` });
      // The free row's switch is the only one that works; each locked row shows its saved switch
      // dimmed beside the lock (CH-96).
      const switches = within(panel).queryAllByRole("switch");
      expect(switches.filter((s) => s.getAttribute("aria-disabled") !== "true")).toHaveLength(1);
      for (const lock of within(panel).getAllByRole("button", {
        name: new RegExp(
          `Included in Still Pro\\. ${surface.appHandoff ? "Open the Still app" : "See Still Pro"}$`,
        ),
      })) {
        expect(lock).toHaveTextContent("Still Pro");
        expect(lock).not.toHaveAttribute("aria-disabled");
        await fireEvent.click(lock);
        chips++;
      }
    }
    const pro = FEATURE_REGISTRY.filter((row) => row.tier === "pro");
    expect(chips).toBe(
      surface.kind === "desktop"
        ? pro.length
        : pro.filter(
            (row) => !(DESKTOP_LAYOUT_ONLY_PRO as readonly string[]).includes(row.id),
          ).length,
    );
    expect(seePro).toHaveBeenCalledTimes(chips);
  });

  it.each([
    "checking",
    "verification_required",
    "purchased",
    "protected",
    "unsupported",
    "free",
  ] as const)("%s: no Still Pro card and nothing asks for money", async (state) => {
    await mountPopup(surface, state);
    expect(proCard()).toBeNull();
    expect(screen.queryByText("Get Still Pro")).toBeNull();
    expect(screen.queryByText(POPUP_PRO_VALUE)).toBeNull();
    if (state !== "checking")
      expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
  });

  it.each(["checking", "verification_required", "purchased", "protected"] as const)(
    "mixed locked and %s access: no card until Still knows for sure",
    async (other) => {
      const { props } = await desktopFixture("locked");
      await mountPopup(surface, "locked", {
        access: {
          ...props.access,
          states: { ...props.access.states, "youtube.related": other },
        },
      });
      expect(proCard()).toBeNull();
      expect(screen.queryByText("Get Still Pro")).toBeNull();
    },
  );

  it("locked but the destination would not sell now: no card, yet the locks still open it", async () => {
    const { seePro } = await mountPopup(surface, "locked", { proOfferReady: false });
    expect(proCard()).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Instagram Blocker" }));
    const panel = screen.getByRole("group", { name: "Instagram Blocker" });
    await fireEvent.click(
      within(panel).getAllByRole("button", { name: /Included in Still Pro\. / })[0]!,
    );
    expect(seePro).toHaveBeenCalledOnce();
  });

  it("locked while settings sync is pending: the Pro offer remains visible", async () => {
    await mountPopup(surface, "locked", {
      account: { address: "person@still.test", status: { tone: "pending", text: "Syncing your settings." } },
    });
    expect(proCard()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Get Still Pro" })).toBeVisible();
  });

  it.each(["failed", "caution"] as const)(
    "locked with a %s account status: no card (the free outcome comes first)",
    async (tone) => {
      await mountPopup(surface, "locked", {
        account: { address: "person@still.test", status: { tone, text: "Fixture status" } },
      });
      expect(proCard()).toBeNull();
    },
  );

  it("locked while setup is needed: no card (the free outcome comes first)", async () => {
    await mountPopup(
      surface,
      "locked",
      surface.kind === "desktop"
        ? { desktopSetup: { title: "Fixture setup", detail: "Fixture detail", actionLabel: "Allow" } }
        : ({ setup: {} } as Partial<DesktopPopupProps>),
    );
    expect(proCard()).toBeNull();
  });

  it("checking: a muted 'Checking your Still Pro access…' line in the card's place, with no button", async () => {
    const { view } = await mountPopup(surface, "checking");
    expect(screen.getByText("Checking your Still Pro access…")).toBeVisible();
    const region = screen.getByText("Checking your Still Pro access…").closest("section")!;
    expect(within(region).queryByRole("button")).toBeNull();
    const services = view.container.querySelector(".services")!;
    const sync = screen.getByRole("heading", { name: "Settings sync" }).closest("section")!;
    expect(services.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sync.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("checking without a destination, or while the destination would not sell: no checking line", async () => {
    const first = await mountPopup(surface, "checking", { onSeePro: undefined });
    expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
    first.view.unmount();
    await mountPopup(surface, "checking", { proOfferReady: false });
    expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
  });

  it("locked without a host destination: no card and inert locks", async () => {
    const { seePro } = await mountPopup(surface, "locked", { onSeePro: undefined });
    expect(proCard()).toBeNull();
    expect(seePro).not.toHaveBeenCalled();
  });

  it("purchased and signed in: the sync card keeps the account's sync status, no Still Pro card", async () => {
    await mountPopup(surface, "purchased", {
      account: {
        address: "person@still.test",
        status: { tone: "success", text: "Synced with your account." },
      },
    });
    expect(proCard()).toBeNull();
    const sync = screen.getByRole("heading", { name: "Settings sync" }).closest("section")!;
    expect(within(sync).getByText("person@still.test")).toBeVisible();
    expect(within(sync).getByText("Synced with your account.")).toBeVisible();
    expect(within(sync).queryByRole("button", { name: /Sign in/ })).toBeNull();
  });

  it(`signed out: Sign in ${surface.appHandoff ? "says it opens the Still app" : "has no hand-off caption"}`, async () => {
    const { signIn } = await mountPopup(surface, "locked");
    const sync = screen.getByRole("heading", { name: "Settings sync" }).closest("section")!;
    const button = within(sync).getByRole("button", { name: "Sign in" });
    if (surface.appHandoff) {
      expect(button).toHaveAccessibleDescription("Opens the Still app");
      expect(within(sync).getByText("Opens the Still app")).toBeVisible();
    } else {
      expect(button).not.toHaveAccessibleDescription();
      expect(within(sync).queryByText("Opens the Still app")).toBeNull();
    }
    await fireEvent.click(button);
    expect(signIn).toHaveBeenCalledOnce();
  });
});

it("iPhone Safari hands off to the app by default, even without the appHandoff flag", async () => {
  const { props } = await desktopFixture("locked");
  const { browser: _browser, ...mobile } = props;
  render(MobilePopup, {
    props: { ...mobile, host: "safari", onSeePro: vi.fn() } satisfies MobilePopupProps,
  });
  expect(screen.getByRole("button", { name: "Get Still Pro" })).toHaveAccessibleDescription(
    "Opens the Still app",
  );
});

describe("Settings Still Pro card (Chrome, Firefox, Firefox for Android), paid world", () => {
  const ready = {
    ownership: "none" as const,
    channel: "ready" as const,
    offer: { price: "", checkoutPriced: true as const },
  };

  it("locked: what the extras hide by site, the one-time terms, Get Still Pro, the checkout note and Restore", async () => {
    const { props } = await settingsFixture("locked");
    const onBuy = vi.fn();
    const onSignIn = vi.fn();
    const onRestore = vi.fn();
    render(ExtensionSettings, {
      props: { ...props, pro: { ...ready, onBuy, onSignIn, onRestore } },
    });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).getByText("Hide more of what distracts you.")).toBeVisible();
    const rows = within(card)
      .getAllByRole("listitem")
      .map((item) => [
        item.querySelector(".site")?.textContent,
        item.querySelector(".what")?.textContent,
      ]);
    expect(rows).toEqual([
      [
        "Instagram",
        "Stories and Highlights, Explore recommendations, suggested accounts and Threads links",
      ],
      ["Facebook", "Stories, the Video tab and desktop sidebar ads"],
      [
        "YouTube",
        "Related videos, end-of-video suggestions, autoplay, comments and live chat",
      ],
    ]);
    expect(within(card).getByText("One-time purchase. Lifetime access.")).toBeVisible();
    const get = within(card).getByRole("button", { name: "Get Still Pro" });
    // Owner's canvas review, 21 Oct 2026: no checkout price note under Get Still Pro.
    expect(within(card).queryByText("The price is shown at checkout.")).toBeNull();
    expect(card.textContent).not.toMatch(COUNT);
    expect(card.textContent).not.toMatch(/\d/);
    expect(card.textContent).not.toMatch(PRICE);
    await fireEvent.click(get);
    expect(onSignIn).toHaveBeenCalledOnce(); // signed out signs in first, as before
    await fireEvent.click(within(card).getByRole("button", { name: "Restore purchase" }));
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("Firefox before its device answer: the value list waits instead of changing rows", async () => {
    const { props } = await settingsFixture("locked");
    const view = render(ExtensionSettings, {
      props: { ...props, features: phoneLayoutFeatures(), platformKnown: false, pro: ready },
    });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).queryByRole("listitem")).toBeNull();
    expect(within(card).getByRole("button", { name: "Get Still Pro" })).toBeVisible();
    await view.rerender({ ...props, features: undefined, platformKnown: true, pro: ready });
    expect(within(screen.getByRole("region", { name: "Still Pro" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Stories, the Video tab and desktop sidebar ads")).toBeVisible();
  });

  it("locked with Buy not open here: the value list stays, the one-time terms and Get Still Pro do not", async () => {
    const { props } = await settingsFixture("locked");
    render(ExtensionSettings, {
      props: { ...props, pro: { ownership: "none", channel: "unverified", onRestore: vi.fn() } },
    });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).queryByText("One-time purchase. Lifetime access.")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(within(card).getByText("Still Pro can't be bought here yet.")).toBeVisible();
  });

  it.each([
    ["a Restore check is in progress", { restore: { state: "checking" as const } }, {}],
    ["the purchase just succeeded", {}, { state: "success" as const }],
  ])("locked while %s: no value list or terms", async (_name, page, pro) => {
    const { props } = await settingsFixture("locked");
    render(ExtensionSettings, {
      props: { ...props, ...page, pro: { ...ready, ...pro } },
    });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).queryByRole("listitem")).toBeNull();
    expect(within(card).queryByText("One-time purchase. Lifetime access.")).toBeNull();
  });

  it("on a phone: lists only the extras the phone draws, still without counts", async () => {
    const { props } = await settingsFixture("locked");
    render(ExtensionSettings, {
      props: { ...props, phone: true, features: phoneLayoutFeatures(), pro: ready },
    });
    const card = screen.getByRole("region", { name: "Still Pro" });
    const text = [...card.querySelectorAll(".what")].map((node) => node.textContent);
    expect(text).toEqual([
      "Stories and Highlights, Explore recommendations, suggested accounts and Threads links",
      "Stories and the Video tab",
      "Related videos, autoplay and comments",
    ]);
    expect(card.textContent).not.toMatch(/desktop sidebar ads|live chat|end-of-video/i);
    expect(card.textContent).not.toMatch(COUNT);
  });

  it.each(["checking", "verification_required"] as const)(
    "%s: no value list, terms or Get Still Pro",
    async (state) => {
      const { props } = await settingsFixture(state);
      render(ExtensionSettings, {
        props: {
          ...props,
          pro: { ...ready, ownership: state === "checking" ? "checking" : "verify" },
        },
      });
      const card = screen.getByRole("region", { name: "Still Pro" });
      expect(within(card).queryByRole("listitem")).toBeNull();
      expect(within(card).queryByText("One-time purchase. Lifetime access.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    },
  );

  it("purchased: the sync card carries the Still Pro tag and no Still Pro card renders", async () => {
    const { props } = await settingsFixture("purchased");
    render(ExtensionSettings, {
      props: {
        ...props,
        sync: {
          account: {
            address: "person@still.test",
            confirmed: true,
            // A browser's Still Pro is always the signed-in account's own (ISS-0105).
            holdsPro: true,
            status: { tone: "success", text: "Synced with your account." },
            onSignOut: vi.fn(),
          },
        },
        pro: { ownership: "owned", channel: "unverified" },
      },
    });
    expect(screen.queryByText("Still Pro and sync")).toBeNull();
    const sync = screen.getByRole("heading", { name: "Settings sync" }).closest("section")!;
    expect(within(sync).getByText("person@still.test")).toBeVisible();
    expect(within(sync).getByText("Synced with your account.")).toBeVisible();
    expect(within(sync).queryByText("Purchased")).toBeNull();
    // Owned (owner, 19 Oct): the tag on the sync card's heading row is the one signal.
    expect(within(sync).getByText("Still Pro User")).toHaveClass("access-tag", "success");
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
  });
});

describe("Mac and iPhone app Still Pro card", () => {
  it("keeps its slim offer with the App Store price left to Apple's sheet", () => {
    render(NativeProOfferCard, {
      props: {
        ownership: "none",
        channel: "ready",
        offer: { price: "fixture StoreKit price", priceNote: "One-time purchase. Lifetime access." },
        onBuy: vi.fn(),
        onRestore: vi.fn(),
      },
    });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).getByText("One-time purchase. Lifetime access.")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Get Still Pro" })).toBeVisible();
    expect(within(card).queryByText("fixture StoreKit price")).toBeNull();
    expect(card.textContent).not.toMatch(COUNT);
  });

  it("purchased: its own Purchased card, with no Restore link", () => {
    render(NativeProOfferCard, {
      props: { ownership: "owned", channel: "ready", onRestore: vi.fn() },
    });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).getByText("Still Pro Purchased")).toBeVisible();
    expect(within(card).queryByRole("button")).toBeNull();
  });
});

it("the registry still has Still Pro rows on Instagram, Facebook and YouTube (guards the matrix)", () => {
  const services = new Set(
    FEATURE_REGISTRY.filter((row) => row.tier === "pro").map((row) => row.service),
  );
  expect([...services].sort()).toEqual(["facebook", "instagram", "youtube"]);
});
