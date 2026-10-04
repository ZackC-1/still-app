import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type AccessState,
  type FeatureId,
  type ServiceId,
} from "@still/shared-types";
import {
  AtomicSettingsWriter,
  requireModernSettings,
} from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import {
  ACCESS_BENEFITS,
  initialAccessSnapshot,
} from "../../entitlement/access-policy.js";
import MobilePopup from "./MobilePopup.svelte";
import DesktopPopup from "./DesktopPopup.svelte";
import type { MobilePopupProps } from "./mobile-presentation.js";

async function fixture(state: AccessState = "purchased") {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  await writer.initialize("never-linked");
  const cache = new SettingsCache({
    get: storage.get.bind(storage),
    set: storage.set.bind(storage),
    subscribe: storage.subscribe.bind(storage),
    commitIntent: writer.commit.bind(writer),
  });
  await cache.hydrate();
  const access = initialAccessSnapshot({
    paidMode: false,
    supported: new Set(ACCESS_BENEFITS),
  });
  const states = { ...access.states };
  for (const row of FEATURE_REGISTRY)
    if (row.tier === "pro") states[row.id] = state;
  let pending: Promise<unknown> = Promise.resolve();
  const props: MobilePopupProps = {
    settings: requireModernSettings(cache.currentRecord()),
    access: { ...access, states },
    host: "safari",
    privacyUrl: "https://still.test/privacy",
    onGlobalChange: vi.fn((next: boolean) => {
      pending = cache.setGlobalOn(next);
    }),
    onServiceChange: vi.fn((id: ServiceId, next: boolean) => {
      pending = cache.setService(id, next);
    }),
    onFeatureChange: vi.fn((id: FeatureId, next: boolean) => {
      pending = cache.setFeature(id, next);
    }),
    onSettings: vi.fn(),
    onSignIn: vi.fn(),
  };
  return { storage, cache, props, settled: () => pending };
}

describe("controlled D02 mobile presentation", () => {
  it("describes optional free sync on supported surfaces", async () => {
    const { props } = await fixture();
    const view = render(MobilePopup, { props });
    expect(
      screen.getByText(
        "Free. Keep your settings updated across every supported surface.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/every device and browser/)).toBeNull();
    view.unmount();
  });

  it("keeps the desktop's optional sync claim within the same supported surfaces", async () => {
    const { props } = await fixture();
    const view = render(DesktopPopup, {
      props: { ...props, browser: "Chrome" },
    });
    expect(
      screen.getByText(
        "Free. Keep your settings updated across every supported surface.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/every device and browser/)).toBeNull();
    view.unmount();
  });

  it("commits free and optional choices through the actual writer, retaining choices while site/global Off", async () => {
    const { props, storage, cache, settled } = await fixture();
    const view = render(MobilePopup, { props });
    const refresh = async () => {
      await settled();
      props.settings = requireModernSettings(cache.currentRecord());
      await view.rerender(props);
    };
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const shorts = screen.getByRole("switch", { name: "Shorts" });
    await fireEvent.click(shorts);
    expect(shorts).toHaveAttribute("aria-checked", "true");
    await refresh();
    expect(shorts).toHaveAttribute("aria-checked", "false");
    const comments = screen.getByRole("switch", { name: "Comments" });
    await fireEvent.click(comments);
    expect(comments).toHaveAttribute("aria-checked", "false");
    await refresh();
    expect(comments).toHaveAttribute("aria-checked", "true");
    const saved = { ...requireModernSettings((await storage.get())!).sites };
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on YouTube" }),
    );
    await refresh();
    const siteOff = await storage.get();
    await fireEvent.click(comments);
    await settled();
    expect(await storage.get()).toEqual(siteOff);
    expect(comments).toHaveAttribute("aria-disabled", "true");
    expect(requireModernSettings((await storage.get())!).sites).toEqual(saved);
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await refresh();
    expect(screen.getByText("Still is off")).toBeTruthy();
    expect(comments).toHaveAttribute("aria-checked", "true");
    const before = await storage.get();
    await fireEvent.click(comments);
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram" }),
    );
    await settled();
    expect(await storage.get()).toEqual(before);
    expect(props.onFeatureChange).toHaveBeenCalledTimes(2);
    expect(props.onServiceChange).toHaveBeenCalledExactlyOnceWith(
      "youtube",
      false,
    );
    expect(requireModernSettings(before!).sites).toEqual(saved);
    view.unmount();
  });

  it("preserves saved choices across access changes and permits free controls while optional access is held", async () => {
    const { props, storage, cache, settled } = await fixture();
    await cache.setFeature("youtube.comments", true);
    props.settings = requireModernSettings(cache.currentRecord());
    props.onSeePro = vi.fn();
    const saved = await storage.get();
    const view = render(MobilePopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    for (const state of [
      "checking",
      "verification_required",
      "unsupported",
      "locked",
      "protected",
      "purchased",
    ] as const) {
      props.access = {
        ...props.access,
        states: { ...props.access.states, "youtube.comments": state },
      };
      await view.rerender(props);
      const row = screen
        .getByText("Comments")
        .closest(".option-row") as HTMLElement;
      if (state === "checking" || state === "verification_required") {
        const input = within(row).getByRole("switch", { name: "Comments" });
        expect(input).toHaveAttribute("aria-checked", "true");
        expect(input).toHaveAttribute("aria-disabled", "true");
        input.focus();
        expect(input).toHaveFocus();
        await fireEvent.click(input);
        expect(
          screen.queryByRole("button", {
            name: "See Still Pro in the Still app",
          }),
        ).toBeNull();
      } else if (state === "unsupported") {
        expect(within(row).queryByRole("switch")).toBeNull();
        expect(
          within(row).getByText(
            "Not available in Safari. Your choice is saved.",
          ),
        ).toBeTruthy();
      } else if (state === "locked") {
        await fireEvent.click(
          within(row).getByRole("button", {
            name: "Comments. Included in Still Pro. Open the Still app",
          }),
        );
      } else {
        expect(
          within(row).getByRole("switch", { name: "Comments" }),
        ).toHaveAttribute("aria-checked", "true");
      }
      await settled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    }
    props.access = {
      ...props.access,
      states: {
        ...props.access.states,
        "youtube.comments": "verification_required",
      },
    };
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await settled();
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.shorts"],
    ).toBe(false);
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.comments"],
    ).toBe(true);
    expect(props.onSeePro).not.toHaveBeenCalled();
    view.unmount();
  });

  it("uses packaged real capability states without making optional rows usable, while free TikTok remains controlled", async () => {
    const { props, storage, settled } = await fixture();
    props.access = initialAccessSnapshot();
    const view = render(MobilePopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    expect(screen.queryByRole("switch", { name: "Comments" })).toBeNull();
    expect(
      screen.getAllByText("Not available in Safari. Your choice is saved."),
    ).toHaveLength(11);
    expect(screen.queryByText("Desktop sidebar ads")).toBeNull();
    await fireEvent.click(
      screen.getByRole("switch", { name: "TikTok website" }),
    );
    await settled();
    expect(requireModernSettings((await storage.get())!).services.tiktok).toBe(
      false,
    );
    expect(props.onServiceChange).toHaveBeenCalledExactlyOnceWith(
      "tiktok",
      false,
    );
    view.unmount();
  });

  it("restores only one locally remembered section without writing settings, and omits desktop-only ads", async () => {
    const { props, storage } = await fixture();
    let remembered: ServiceId | null = "youtube";
    const write = vi.fn((service: ServiceId | null) => {
      remembered = service;
    });
    props.sectionMemory = { read: () => remembered, write };
    const before = await storage.get();
    const view = render(MobilePopup, { props });
    expect(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(write).not.toHaveBeenCalled();
    await fireEvent.click(
      screen.getByRole("button", { name: "Facebook Blocker" }),
    );
    expect(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelectorAll(".service-options.open")).toHaveLength(1);
    expect(screen.queryByText("Desktop sidebar ads")).toBeNull();
    view.unmount();
    const next = render(MobilePopup, { props });
    expect(
      screen.getByRole("button", { name: "Facebook Blocker" }),
    ).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(
      screen.getByRole("button", { name: "Facebook Blocker" }),
    );
    expect(write.mock.calls).toEqual([["facebook"], [null]]);
    expect(await storage.get()).toEqual(before);
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    next.unmount();
  });

  it("routes Safari app actions only with eligible controlled ports and never offers price or Buy", async () => {
    const { props } = await fixture("locked");
    const seePro = vi.fn();
    props.onSeePro = seePro;
    props.onPurchase = vi.fn();
    props.channelReady = true;
    const view = render(MobilePopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "See Still Pro in the Still app" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Comments. Included in Still Pro. Open the Still app",
      }),
    );
    expect(props.onSeePro).toHaveBeenCalledTimes(2);
    expect(props.onPurchase).not.toHaveBeenCalled();
    expect(screen.queryByText("Purchase Still Pro")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$|\bBuy\b/);
    props.onSeePro = undefined;
    await view.rerender(props);
    await fireEvent.click(
      screen.getByRole("button", { name: "See Still Pro in the Still app" }),
    );
    const heldLock = screen.getByRole("button", {
      name: "Comments. Included in Still Pro. Open the Still app",
    });
    expect(heldLock).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(heldLock);
    expect(seePro).toHaveBeenCalledTimes(2);
    expect(props.onPurchase).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not enable Firefox Android purchase until the supplied channel and access are ready", async () => {
    const { props } = await fixture("locked");
    props.host = "firefox";
    props.onPurchase = vi.fn();
    const view = render(MobilePopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const lock = screen.getByRole("button", {
      name: "Comments. Included in Still Pro. See Still Pro",
    });
    await fireEvent.click(lock);
    expect(props.onPurchase).not.toHaveBeenCalled();
    expect(screen.queryByText("Purchase Still Pro")).toBeNull();
    expect(screen.queryByText("See Still Pro")).toBeNull();
    props.channelReady = true;
    await view.rerender(props);
    await fireEvent.click(lock);
    expect(props.onPurchase).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Purchase Still Pro" }),
    );
    expect(props.onPurchase).toHaveBeenCalledTimes(2);
    for (const state of ["checking", "verification_required"] as const) {
      props.access = {
        ...props.access,
        states: { ...props.access.states, "youtube.comments": state },
      };
      await view.rerender(props);
      expect(screen.queryByText("Purchase Still Pro")).toBeNull();
      await fireEvent.click(
        screen.getByRole("button", {
          name: "Related videos. Included in Still Pro. See Still Pro",
        }),
      );
      expect(props.onPurchase).toHaveBeenCalledTimes(2);
    }
    view.unmount();
  });

  it.each(["safari", "firefox"] as const)(
    "uses supplied %s setup/account/action ports without pretending setup or sync succeeded",
    async (host) => {
      const { props, storage } = await fixture("locked");
      props.host = host;
      const onAction = vi.fn();
      const retry = vi.fn();
      props.setup = { onAction };
      props.account = {
        address: "test@still.test",
        status: {
          tone: "failed",
          text: "Sync didn't finish. Your settings are saved on this device.",
          retry,
        },
      };
      const before = await storage.get();
      const view = render(MobilePopup, { props });
      await fireEvent.click(
        screen.getByRole("button", {
          name: host === "safari" ? "Show me how" : "Allow",
        }),
      );
      expect(onAction).toHaveBeenCalledOnce();
      expect(screen.queryByText(/setup complete/i)).toBeNull();
      await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(retry).toHaveBeenCalledOnce();
      expect(
        screen.getByText(
          "Sync didn't finish. Your settings are saved on this device.",
        ),
      ).toBeTruthy();
      await fireEvent.click(
        screen.getByRole("button", {
          name:
            host === "safari"
              ? "Settings. Opens Still settings."
              : "Settings. Find Still in Firefox.",
        }),
      );
      expect(props.onSettings).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("link", { name: "Privacy policy" }),
      ).toHaveAttribute("href", props.privacyUrl);
      expect(await storage.get()).toEqual(before);
      view.unmount();
    },
  );
});

function invitationSpecimen(
  kind: "rating" | "sync" | "link" = "rating",
  surface = "chrome",
): import("./invitation-presentation.js").PopupInvitationPresentation {
  const identity = {
    installation: "specimen-install",
    opening: "specimen-opening",
    surface,
  };
  return {
    kind,
    identity,
    verified: true,
    fresh: true,
    status: "ready",
    ordinaryOpening: true,
    rating: {
      allowance: { verified: true, fresh: true, global: true, surface: true },
      eligibility: {
        verified: true,
        ageDays: 7,
        distinctUseDays: 3,
        laterOpening: true,
      },
      display: {
        verified: true,
        fresh: true,
        status: "admitted",
        receiptId: "specimen-admission",
        identity: { ...identity },
      },
    },
    accept: {
      verified: true,
      status: "ready",
      identity: { ...identity },
      request: vi.fn(),
    },
    dismiss: {
      verified: true,
      status: "ready",
      identity: { ...identity },
      request: vi.fn(),
    },
  };
}

describe("optional D28 mobile invitation", () => {
  it("never draws a browser rating in Safari and keeps optional free sync available", async () => {
    const { props, storage } = await fixture();
    const saved = await storage.get();
    props.invitation = invitationSpecimen("rating", "safari");
    props.channelReady = true;
    const view = render(MobilePopup, { props });
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    props.invitation = invitationSpecimen("sync", "safari");
    await view.rerender(props);
    const card = screen.getByRole("region", {
      name: "Use the same settings in every browser",
    });
    await fireEvent.click(
      within(card).getByRole("button", { name: "Sign in" }),
    );
    expect(props.invitation.accept!.request).toHaveBeenCalledOnce();
    expect(screen.queryByText("Purchase Still Pro")).toBeNull();
    expect(await storage.get()).toEqual(saved);
  });

  it("requires the illustrative Firefox channel, current surface and setup/error-free opening", async () => {
    const { props } = await fixture();
    props.host = "firefox";
    props.invitation = invitationSpecimen("rating", "firefox-android");
    const view = render(MobilePopup, { props });
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    props.channelReady = true;
    await view.rerender(props);
    expect(screen.getByRole("region", { name: "Rate Still" })).toBeTruthy();
    props.setup = {};
    await view.rerender(props);
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    props.setup = undefined;
    props.account = {
      address: "specimen@still.test",
      status: { tone: "failed", text: "Current sync failed" },
    };
    await view.rerender(props);
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    props.account = undefined;
    props.invitation = invitationSpecimen();
    await view.rerender(props);
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
  });

  it("preserves saved settings and one open site while a higher-priority link invitation replaces rating", async () => {
    const { props, storage, settled } = await fixture();
    props.host = "firefox";
    props.channelReady = true;
    props.invitation = invitationSpecimen("rating", "firefox-android");
    const view = render(MobilePopup, { props });
    const saved = await storage.get();
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    props.invitation = invitationSpecimen("link", "firefox-android");
    await view.rerender(props);
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    expect(document.querySelectorAll(".service-options.open")).toHaveLength(1);
    await fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(props.invitation.accept!.request).toHaveBeenCalledOnce();
    await settled();
    expect(await storage.get()).toEqual(saved);
    expect(props.onFeatureChange).not.toHaveBeenCalled();
  });
});

describe("issued invitation across actual host sync suppression", () => {
  it.each(["accept", "dismiss"] as const)(
    "retains the %s claim through pending sync and identical restoration",
    async (first) => {
      const { props, storage } = await fixture();
      props.host = "firefox";
      props.channelReady = true;
      const p = invitationSpecimen("rating", "firefox-android");
      props.invitation = p;
      const saved = await storage.get();
      const view = render(MobilePopup, { props });
      const name = (choice: "accept" | "dismiss") =>
        choice === "accept" ? "Rate Still" : "Not now";
      const opposite = first === "accept" ? "dismiss" : "accept";
      await fireEvent.click(screen.getByRole("button", { name: name(first) }));
      expect(p[first]!.request).toHaveBeenCalledOnce();
      props.account = {
        address: "specimen@still.test",
        status: { tone: "pending", text: "Current sync pending" },
      };
      await view.rerender(props);
      expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
      props.account = undefined;
      await view.rerender(props);
      expect(props.invitation).toBe(p);
      await fireEvent.click(screen.getByRole("button", { name: name(first) }));
      await fireEvent.click(
        screen.getByRole("button", { name: name(opposite) }),
      );
      expect(p[first]!.request).toHaveBeenCalledOnce();
      expect(p[opposite]!.request).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Rate Still" })).toBeTruthy();
      expect(await storage.get()).toEqual(saved);
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    },
  );
});

describe("per-issued invitation claims through MobilePopup", () => {
  const title = (kind: "rating" | "sync" | "link") =>
    ({
      rating: "Rate Still",
      sync: "Use the same settings in every browser",
      link: "Link Still Pro to an account",
    })[kind];
  const control = (
    kind: "rating" | "sync" | "link",
    choice: "accept" | "dismiss",
  ) =>
    within(screen.getByRole("region", { name: title(kind) })).getByRole(
      "button",
      {
        name:
          choice === "dismiss"
            ? "Not now"
            : { rating: "Rate Still", sync: "Sign in", link: "Link" }[kind],
      },
    );
  it.each(
    (["rating", "sync", "link"] as const).flatMap((kind) =>
      (["accept", "dismiss"] as const).flatMap((first) =>
        (["missing", "unready"] as const).map(
          (unavailable) => [kind, first, unavailable] as const,
        ),
      ),
    ),
  )(
    "holds %s %s when chosen host port is %s",
    async (kind, first, unavailable) => {
      const { props, storage } = await fixture();
      props.host = "firefox";
      props.channelReady = true;
      const a = invitationSpecimen(kind, "firefox-android");
      const opposite = first === "accept" ? "dismiss" : "accept";
      const saved = await storage.get();
      props.invitation = a;
      const view = render(MobilePopup, { props });
      await fireEvent.click(control(kind, first));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      props.invitation = {
        ...a,
        [first]:
          unavailable === "missing"
            ? undefined
            : { ...a[first]!, verified: false, request: vi.fn() },
      };
      await view.rerender(props);
      await fireEvent.click(control(kind, opposite));
      expect(a[opposite]!.request).not.toHaveBeenCalled();
      props.invitation = a;
      await view.rerender(props);
      await fireEvent.click(control(kind, first));
      await fireEvent.click(control(kind, opposite));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      expect(a[opposite]!.request).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    },
  );
  it.each(
    (["rating", "sync", "link"] as const).flatMap((kind) =>
      (["accept", "dismiss"] as const).map((first) => [kind, first] as const),
    ),
  )(
    "holds restored %s %s A after issuing B through the host",
    async (kind, first) => {
      const { props, storage } = await fixture();
      props.host = "firefox";
      props.channelReady = true;
      const a = invitationSpecimen(kind, "firefox-android");
      const b = invitationSpecimen(kind, "firefox-android");
      const opposite = first === "accept" ? "dismiss" : "accept";
      const saved = await storage.get();
      props.invitation = a;
      const view = render(MobilePopup, { props });
      await fireEvent.click(control(kind, first));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      props.invitation = b;
      await view.rerender(props);
      await fireEvent.click(control(kind, first));
      expect(b[first]!.request).toHaveBeenCalledOnce();
      props.invitation = a;
      await view.rerender(props);
      await fireEvent.click(control(kind, first));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      await fireEvent.click(control(kind, opposite));
      expect(a[opposite]!.request).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    },
  );
});
