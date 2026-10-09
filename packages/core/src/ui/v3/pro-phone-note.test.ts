import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY } from "@still/shared-types";
import {
  ACCESS_HOSTS,
  DESKTOP_LAYOUT_ONLY_PRO,
  IMPLEMENTED_PRO_FEATURES,
  accessCapabilities,
  phoneLayoutFeatures,
} from "../../entitlement/access-policy.js";
import { proPhoneNote } from "./pro-phone-note.js";
import ProOfferCard from "./ProOfferCard.svelte";
import NativeProOfferCard from "./NativeProOfferCard.svelte";
import PurchaseView from "./PurchaseView.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import PurchaseSignInSheet from "./PurchaseSignInSheet.svelte";
import { fixture } from "./ExtensionSettings.test-fixtures.js";

afterEach(cleanup);

const PHONE =
  "On this device, 9 of the 12 extras work. End-of-video suggestions, live chat and desktop sidebar ads need a computer.";
const GENERAL =
  "On iPhone, iPad and Firefox for Android, 9 of the 12 extras work. End-of-video suggestions, live chat and desktop sidebar ads need a computer.";

describe("Still Pro offer note about phones", () => {
  it("reads the owner-approved copy for phone and every other surface", () => {
    expect(proPhoneNote(true)).toBe(PHONE);
    expect(proPhoneNote(false)).toBe(GENERAL);
  });

  it("derives its counts and names from the capability matrix, not a fixed list", () => {
    const pro = FEATURE_REGISTRY.filter((row) => row.tier === "pro");
    const phonePro = phoneLayoutFeatures().filter((id) =>
      pro.some((row) => row.id === id),
    );
    for (const onPhone of [true, false]) {
      const note = proPhoneNote(onPhone);
      expect(note).toContain(`${phonePro.length} of the ${pro.length} extras`);
      for (const id of DESKTOP_LAYOUT_ONLY_PRO) {
        const name = FEATURE_REGISTRY.find((row) => row.id === id)!.name;
        expect(note.toLowerCase()).toContain(name.toLowerCase());
      }
      for (const id of phonePro) {
        const name = FEATURE_REGISTRY.find((row) => row.id === id)!.name;
        expect(note.toLowerCase()).not.toContain(name.toLowerCase());
      }
      expect(note).not.toMatch(/everywhere/i);
    }
  });

  it("shows on the browser offer card as real text, phone-specific only on a phone", () => {
    const base = {
      ownership: "none" as const,
      channel: "unverified" as const,
      confirmedAccount: false,
      knownMissing: true,
      onRestore: vi.fn(),
    };
    const desktop = render(ProOfferCard, { props: base });
    expect(
      within(screen.getByRole("region", { name: "Still Pro" })).getByText(
        GENERAL,
      ),
    ).toBeVisible();
    desktop.unmount();
    render(ProOfferCard, { props: { ...base, phone: true } });
    expect(screen.getByText(PHONE)).toBeVisible();
    expect(screen.queryByText(GENERAL)).toBeNull();
  });

  it("is absent once Still Pro is owned or while access is being checked", () => {
    const base = {
      channel: "unverified" as const,
      confirmedAccount: false,
      knownMissing: false,
    };
    const owned = render(ProOfferCard, {
      props: { ...base, ownership: "owned" as const },
    });
    expect(screen.queryByText(GENERAL)).toBeNull();
    owned.unmount();
    render(ProOfferCard, {
      props: { ...base, ownership: "checking" as const },
    });
    expect(screen.queryByText(GENERAL)).toBeNull();
  });

  it("shows on the Apple app's offer card for iPhone/iPad and Mac", () => {
    const base = {
      ownership: "none" as const,
      channel: "ready" as const,
      offer: { price: "fixture native offer" },
      onBuy: vi.fn(),
      onRestore: vi.fn(),
    };
    const mac = render(NativeProOfferCard, { props: base });
    expect(screen.getByText(GENERAL)).toBeVisible();
    mac.unmount();
    render(NativeProOfferCard, { props: { ...base, phone: true } });
    expect(screen.getByText(PHONE)).toBeVisible();
  });

  it("shows under the extras list on the full purchase screen", () => {
    const common = {
      controls: [{ site: "YouTube", label: "Comments" }],
      access: { state: "none" as const, verified: true },
      channel: "ready" as const,
      offer: { price: "verified fixture", verified: true },
      purchase: { state: "idle" as const },
    };
    const apple = {
      ...common,
      host: "apple" as const,
      native: { verified: true, onBuy: vi.fn(), onRestore: vi.fn() },
    };
    const phone = render(PurchaseView, { props: { ...apple, phone: true } });
    expect(screen.getByText(PHONE)).toBeVisible();
    phone.unmount();
    render(PurchaseView, {
      props: {
        ...common,
        host: "browser" as const,
        checkout: { verified: true, onRequest: vi.fn() },
        restorePort: { verified: true, onRequest: vi.fn() },
        onSignIn: vi.fn(),
      },
    });
    expect(screen.getByText(GENERAL)).toBeVisible();
  });

  it("speaks about this device on the settings page only when the host confirmed a phone", async () => {
    const { props } = await fixture("locked");
    // Desktop rows, and phone rows drawn while the platform answer is pending or unknown (desktop
    // Firefox or macOS Safari whose answer never came): the general note, true on every surface.
    for (const features of [undefined, phoneLayoutFeatures()]) {
      const view = render(ExtensionSettings, { props: { ...props, features } });
      expect(screen.getByText(GENERAL)).toBeVisible();
      expect(screen.queryByText(PHONE)).toBeNull();
      view.unmount();
    }
    render(ExtensionSettings, {
      props: { ...props, features: phoneLayoutFeatures(), phone: true },
    });
    expect(screen.getByText(PHONE)).toBeVisible();
  });

  it("reaches the browser purchase screen behind the sign-in sheet", () => {
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
    expect(document.body).toHaveTextContent(PHONE);
  });

  it("pins the count it assumes: every browser build offers all the extras on a computer and the same subset on a phone", () => {
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
