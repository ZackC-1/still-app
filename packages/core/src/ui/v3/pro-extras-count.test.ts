import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY } from "@still/shared-types";
import {
  ACCESS_HOSTS,
  DESKTOP_LAYOUT_ONLY_PRO,
  IMPLEMENTED_PRO_FEATURES,
  accessCapabilities,
  phoneLayoutFeatures,
} from "../../entitlement/access-policy.js";
import ProOfferCard from "./ProOfferCard.svelte";
import NativeProOfferCard from "./NativeProOfferCard.svelte";
import PurchaseView from "./PurchaseView.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import PurchaseSignInSheet from "./PurchaseSignInSheet.svelte";
import { fixture } from "./ExtensionSettings.test-fixtures.js";

afterEach(cleanup);

// Owner rule, 12 October 2026 (Pro design review, ISS-0029): no Still Pro surface states a number
// of extras or which ones work on a phone ("9 of the 12 extras work...", "twelve extras"). The
// owner chose no replacement disclosure of the computer-only extras.
const COUNT = /\b\d+ of the \d+\b|\b(?:12|twelve|9|nine) extras\b|extras work|need(?:s)? a computer/i;
function expectNoCount(element: HTMLElement) {
  expect(element.textContent ?? "").not.toMatch(COUNT);
}

describe("Still Pro surfaces state no number of extras", () => {
  it("the browser settings offer card, on a computer and on a phone", () => {
    const base = {
      ownership: "none" as const,
      channel: "unverified" as const,
      confirmedAccount: false,
      knownMissing: true,
      onRestore: vi.fn(),
    };
    for (const phone of [false, true]) {
      const view = render(ProOfferCard, { props: { ...base, phone } });
      expectNoCount(screen.getByRole("region", { name: "Still Pro" }));
      view.unmount();
    }
  });

  it("the Mac and iPhone app's offer card", () => {
    const base = {
      ownership: "none" as const,
      channel: "ready" as const,
      offer: { price: "fixture native offer" },
      onBuy: vi.fn(),
      onRestore: vi.fn(),
    };
    for (const phone of [false, true]) {
      const view = render(NativeProOfferCard, { props: { ...base, phone } });
      expectNoCount(screen.getByRole("region", { name: "Still Pro" }));
      view.unmount();
    }
  });

  it("the full purchase screen, Apple and browser", () => {
    const common = {
      controls: [{ site: "YouTube", label: "Comments" }],
      access: { state: "none" as const, verified: true },
      channel: "ready" as const,
      offer: { price: "verified fixture", verified: true },
      purchase: { state: "idle" as const },
    };
    const apple = render(PurchaseView, {
      props: {
        ...common,
        host: "apple" as const,
        native: { verified: true, onBuy: vi.fn(), onRestore: vi.fn() },
        phone: true,
      },
    });
    expectNoCount(document.body);
    expect(screen.getByText("Comments")).toBeVisible();
    apple.unmount();
    render(PurchaseView, {
      props: {
        ...common,
        host: "browser" as const,
        checkout: { verified: true, onRequest: vi.fn() },
        restorePort: { verified: true, onRequest: vi.fn() },
        onSignIn: vi.fn(),
      },
    });
    expectNoCount(document.body);
  });

  it("the settings page, with desktop or phone rows", async () => {
    const { props } = await fixture("locked");
    for (const extra of [{}, { features: phoneLayoutFeatures() }, { features: phoneLayoutFeatures(), phone: true }]) {
      const view = render(ExtensionSettings, { props: { ...props, ...extra } });
      expectNoCount(document.body);
      view.unmount();
    }
  });

  it("the browser purchase screen behind the sign-in sheet", () => {
    const op = { requestId: "r", ownerId: "o", purpose: "purchase" as const };
    const ready = { operation: op, verified: true, onRequest: vi.fn() };
    render(PurchaseSignInSheet, {
      props: {
        open: true,
        operation: op,
        email: "",
        code: "",
        observation: { operation: op, verified: true, state: "email" },
        emailInput: ready,
        codeInput: ready,
        send: ready,
        verify: ready,
        dismiss: ready,
        background: {
          host: "browser",
          controls: [],
          phone: true,
          access: { state: "none", verified: true },
          channel: "ready",
          offer: { verified: true, price: "fixture only" },
          purchase: { state: "idle" },
          checkout: { verified: true, onRequest: vi.fn() },
          restorePort: { verified: true, onRequest: vi.fn() },
          onSignIn: vi.fn(),
        },
      },
    });
    expectNoCount(document.body);
  });

  // Kept from the removed phone note: the capability matrix the Still Pro copy used to describe.
  it("capability matrix: every browser build offers all the extras on a computer and the same subset on a phone", () => {
    const pro = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map(
      (row) => row.id,
    );
    const phonePro = pro.filter(
      (id) => !(DESKTOP_LAYOUT_ONLY_PRO as readonly string[]).includes(id),
    );
    expect(ACCESS_HOSTS).toEqual(["chromium", "firefox", "safari"]);
    for (const host of ACCESS_HOSTS) {
      expect([...IMPLEMENTED_PRO_FEATURES[host]].sort(), host).toEqual(
        [...pro].sort(),
      );
      const desktop = accessCapabilities({
        paidMode: true,
        host,
        platform: "desktop",
      });
      expect(
        pro.filter((id) => desktop.has(id)),
        host,
      ).toEqual(pro);
      for (const platform of ["android", "ios", "unknown"] as const) {
        const phone = accessCapabilities({ paidMode: true, host, platform });
        expect(
          pro.filter((id) => phone.has(id)),
          `${host} ${platform}`,
        ).toEqual(phonePro);
      }
    }
  });
});
