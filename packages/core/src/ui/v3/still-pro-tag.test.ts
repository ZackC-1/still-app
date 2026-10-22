// ISS-0073: after a Still Pro purchase the popups drop the Still Pro card, so the sync card's
// account row carries one small boxed "Still Pro" tag instead (on the Settings page and in the
// Apple app it sits on the heading row since the owner's 19 Oct review). Only verified purchased ownership
// shows it, on every popup and on the shared sync card (browser Settings and the Apple app).
// ISS-0105 (owner, 21 Oct, option B): the tag reads "Still Pro User" only when the signed-in
// account itself holds Still Pro; a device that holds Still Pro while signed out, or while signed
// in to an account that does not hold it (including one linked to another account), reads
// "Still Pro on this device".
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/svelte";
import {
  FEATURE_REGISTRY,
  type AccessState,
  type BenefitAccessSnapshot,
} from "@still/shared-types";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import AppleSettings from "./AppleSettings.svelte";
import { fixture as popupFixture } from "./DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";
import type { MobilePopupProps } from "./mobile-presentation.js";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";
import { proPurchased } from "./presentation.js";

const ADDRESS = "person@still.test";
const ACCOUNT_TAG = "Still Pro User";
const DEVICE_TAG = "Still Pro on this device";

function withPro(
  access: BenefitAccessSnapshot,
  state: AccessState,
  first?: AccessState,
): BenefitAccessSnapshot {
  const states = { ...access.states };
  const pro = FEATURE_REGISTRY.filter((row) => row.tier === "pro");
  for (const row of pro) states[row.id] = state;
  if (first) states[pro[0]!.id] = first;
  return { ...access, states };
}

function syncCard() {
  const card = screen
    .getByRole("heading", { name: "Settings sync" })
    .closest("section");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

function expectTagBesideAddress(text = ACCOUNT_TAG) {
  // Since the owner's 19 Oct review every surface carries the tag on the heading row.
  expectTagOnHeading(text);
  expect(within(syncCard()).getByText(ADDRESS)).toBeVisible();
}

/** Popups, signed out holding Still Pro (owner, 21 Oct): "Settings sync" stays on one line; the tag
 * sits in the right column, level with the heading and directly above Sign in (and its "Opens the
 * Still app" line). */
function expectTagBesideSignIn(safari: boolean) {
  // Signed out, Still Pro can only be this device's (ISS-0105).
  // Chrome and Firefox keep the tag on the heading row (owner, 19 Oct).
  if (!safari) {
    expectTagOnHeading(DEVICE_TAG);
    expect(within(syncCard()).getByRole("button", { name: /^Sign in/ })).toBeVisible();
    expect(syncCard().querySelector(".pro-signed-out")).toBeNull();
    return;
  }
  const card = syncCard();
  expect(within(card).queryByText(ACCOUNT_TAG)).toBeNull();
  const tag = within(card).getByText(DEVICE_TAG);
  expect(tag).toHaveClass("access-tag", "boxed", "success");
  expect(tag).toBeVisible();
  const heading = within(card).getByRole("heading", { name: "Settings sync" });
  expect(heading.parentElement).not.toContainElement(tag);
  const signIn = within(card).getByRole("button", { name: /^Sign in/ });
  expect(signIn).toBeVisible();
  expect(tag.parentElement).toBe(signIn.parentElement);
  expect(tag.parentElement).toHaveClass("popup-action");
  expect(tag.nextElementSibling).toBe(signIn);
  // The grid (owner-layout-pass.test.ts pins its CSS) levels the tag with the heading.
  expect(card.querySelector(".sync-row")).toHaveClass("pro-signed-out");
}

/** The shared sync card (browser Settings, Apple app) carries the tag on its heading row, in the
 * success green (owner, 19 Oct), whether signed in or out. Exactly one of the two wordings shows. */
function expectTagOnHeading(text: string) {
  const card = syncCard();
  const other = text === ACCOUNT_TAG ? DEVICE_TAG : ACCOUNT_TAG;
  expect(within(card).queryByText(other)).toBeNull();
  const tag = within(card).getByText(text);
  expect(tag).toHaveClass("access-tag", "boxed", "success");
  expect(tag).toBeVisible();
  const heading = within(card).getByRole("heading", { name: "Settings sync" });
  expect(tag.parentElement).toContainElement(heading);
  expect(
    heading.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

function expectNoTag() {
  expect(within(syncCard()).queryByText(ACCOUNT_TAG)).toBeNull();
  expect(within(syncCard()).queryByText(DEVICE_TAG)).toBeNull();
}

const NOT_PURCHASED: [string, AccessState, AccessState?][] = [
  ["protected (released-free protection)", "protected"],
  ["checking", "checking"],
  ["verification_required", "verification_required"],
  ["locked", "locked"],
  ["unsupported (paid tier off)", "unsupported"],
  ["purchased while another row is still checking", "purchased", "checking"],
  ["purchased while another row needs verifying", "purchased", "verification_required"],
];

describe("proPurchased", () => {
  it("is true only for verified purchased ownership", async () => {
    const { props } = await popupFixture("purchased");
    expect(proPurchased(props.access)).toBe(true);
    expect(proPurchased(withPro(props.access, "protected", "purchased"))).toBe(
      true,
    );
    for (const [, state, first] of NOT_PURCHASED)
      expect(proPurchased(withPro(props.access, state, first))).toBe(false);
  });
});

describe.each([
  ["Chrome or Firefox desktop popup", false],
  ["Safari popup on the Mac", true],
] as const)("%s", (_name, appHandoff) => {
  it("shows Still Pro User beside the account address when the account holds Still Pro", async () => {
    const { props } = await popupFixture("purchased");
    props.appHandoff = appHandoff;
    props.account = {
      address: ADDRESS,
      holdsPro: true,
      status: { tone: "success", text: "Synced with your account." },
    };
    render(DesktopPopup, { props });
    expectTagBesideAddress(ACCOUNT_TAG);
  });

  it("shows Still Pro on this device when only the device holds Still Pro (ISS-0105)", async () => {
    const { props } = await popupFixture("purchased");
    props.appHandoff = appHandoff;
    props.account = {
      address: ADDRESS,
      status: { tone: "success", text: "Synced with your account." },
    };
    const view = render(DesktopPopup, { props });
    expectTagBesideAddress(DEVICE_TAG);
    props.account = { ...props.account, holdsPro: false };
    await view.rerender(props);
    expectTagBesideAddress(DEVICE_TAG);
  });

  it("shows Still Pro beside Sign in when signed out and purchased", async () => {
    const { props } = await popupFixture("purchased");
    props.appHandoff = appHandoff;
    render(DesktopPopup, { props });
    expectTagBesideSignIn(appHandoff);
  });

  it.each(NOT_PURCHASED)("shows no tag while %s", async (_s, state, first) => {
    const { props } = await popupFixture("locked");
    props.appHandoff = appHandoff;
    props.access = withPro(props.access, state, first);
    props.account = { address: ADDRESS };
    const view = render(DesktopPopup, { props });
    expectNoTag();
    props.account = undefined;
    await view.rerender(props);
    expectNoTag();
  });
});

async function mobileProps(
  host: MobilePopupProps["host"],
  state: AccessState,
): Promise<MobilePopupProps> {
  const { props } = await popupFixture(state);
  return {
    settings: props.settings,
    access: props.access,
    host,
    privacyUrl: props.privacyUrl,
    onGlobalChange: vi.fn(),
    onServiceChange: vi.fn(),
    onFeatureChange: vi.fn(),
    onSettings: vi.fn(),
    onSignIn: vi.fn(),
  };
}

describe.each([
  ["Safari on iPhone popup", "safari"],
  ["Firefox for Android popup", "firefox"],
] as const)("%s", (_name, host) => {
  it("shows Still Pro User beside the account address when the account holds Still Pro", async () => {
    const props = await mobileProps(host, "purchased");
    props.account = {
      address: ADDRESS,
      holdsPro: true,
      status: { tone: "success", text: "Synced with your account." },
    };
    render(MobilePopup, { props });
    expectTagBesideAddress(ACCOUNT_TAG);
  });

  it("shows Still Pro on this device when only the device holds Still Pro (ISS-0105)", async () => {
    const props = await mobileProps(host, "purchased");
    props.account = {
      address: ADDRESS,
      status: { tone: "success", text: "Synced with your account." },
    };
    render(MobilePopup, { props });
    expectTagBesideAddress(DEVICE_TAG);
  });

  it("shows Still Pro beside Sign in when signed out and purchased", async () => {
    render(MobilePopup, { props: await mobileProps(host, "purchased") });
    expectTagBesideSignIn(host === "safari");
  });

  it.each(NOT_PURCHASED)("shows no tag while %s", async (_s, state, first) => {
    const props = await mobileProps(host, "locked");
    props.access = withPro(props.access, state, first);
    props.account = { address: ADDRESS };
    const view = render(MobilePopup, { props });
    expectNoTag();
    props.account = undefined;
    await view.rerender(props);
    expectNoTag();
  });
});

describe("browser Settings sync card", () => {
  it("shows Still Pro User beside the account address when the account holds Still Pro", async () => {
    const { props } = await settingsFixture("purchased");
    props.pro = { ownership: "owned", channel: "ready" };
    props.sync = { account: { address: ADDRESS, confirmed: true, holdsPro: true } };
    render(ExtensionSettings, { props });
    expectTagOnHeading(ACCOUNT_TAG);
    expect(within(syncCard()).getByText(ADDRESS)).toBeVisible();
  });

  it("shows Still Pro on this device when the signed-in account does not hold it (ISS-0105)", async () => {
    const { props } = await settingsFixture("purchased");
    props.pro = { ownership: "owned", channel: "ready" };
    props.sync = { account: { address: ADDRESS, confirmed: true } };
    render(ExtensionSettings, { props });
    expectTagOnHeading(DEVICE_TAG);
    expect(within(syncCard()).getByText(ADDRESS)).toBeVisible();
  });

  it("shows Still Pro on this device beside Sign in when signed out and purchased", async () => {
    const { props } = await settingsFixture("purchased");
    render(ExtensionSettings, { props });
    expectTagOnHeading(DEVICE_TAG);
    expect(within(syncCard()).getByRole("button", { name: /^Sign in/ })).toBeVisible();
  });

  it.each(NOT_PURCHASED)("shows no tag while %s", async (_s, state, first) => {
    const { props } = await settingsFixture("locked");
    props.access = withPro(props.access, state, first);
    props.sync = { account: { address: ADDRESS, confirmed: true } };
    const view = render(ExtensionSettings, { props });
    expectNoTag();
    props.sync = { onSignIn: vi.fn() };
    await view.rerender(props);
    expectNoTag();
  });
});

async function appleProps(state: AccessState): Promise<AppleSettingsProps> {
  const { props } = await settingsFixture(state);
  return {
    platform: "ios",
    settings: props.settings,
    access: props.access,
    onGlobalChange: vi.fn(),
    onServiceChange: vi.fn(),
    onFeatureChange: vi.fn(),
    sync: { onSignIn: vi.fn() },
    help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
  };
}

describe.each(["ios", "mac"] as const)("Apple app sync card (%s)", (platform) => {
  it("shows Still Pro User beside the account address when the account holds Still Pro", async () => {
    const props = await appleProps("purchased");
    props.platform = platform;
    props.sync = { account: { address: ADDRESS, confirmed: true, holdsPro: true } };
    render(AppleSettings, { props });
    expectTagOnHeading(ACCOUNT_TAG);
    expect(within(syncCard()).getByText(ADDRESS)).toBeVisible();
  });

  it("shows Still Pro on this device when the device's purchase is not this account's (ISS-0105)", async () => {
    const props = await appleProps("purchased");
    props.platform = platform;
    props.sync = { account: { address: ADDRESS, confirmed: true, holdsPro: false } };
    render(AppleSettings, { props });
    expectTagOnHeading(DEVICE_TAG);
    expect(within(syncCard()).getByText(ADDRESS)).toBeVisible();
  });

  it("shows Still Pro on this device beside Sign in when signed out and purchased (Apple local proof)", async () => {
    const props = await appleProps("purchased");
    props.platform = platform;
    render(AppleSettings, { props });
    expectTagOnHeading(DEVICE_TAG);
    expect(within(syncCard()).getByRole("button", { name: /^Sign in/ })).toBeVisible();
  });

  it.each(NOT_PURCHASED)("shows no tag while %s", async (_s, state, first) => {
    const props = await appleProps("locked");
    props.platform = platform;
    props.access = withPro(props.access, state, first);
    props.sync = { account: { address: ADDRESS, confirmed: true } };
    const view = render(AppleSettings, { props });
    expectNoTag();
    props.sync = { onSignIn: vi.fn() };
    await view.rerender(props);
    expectNoTag();
  });
});
