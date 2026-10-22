// ISS-0105 follow-up (owner, 22 Oct): the Safari popup (Mac and iPhone) and the Safari Settings
// page show "Still Pro User" when the signed-in account itself holds Still Pro and "Still Pro on
// this device" otherwise, exactly as the Apple app decides it. The answer comes from native's
// benefit snapshot (`accountHoldsPro`), through the same helpers the Safari hosts call.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/svelte";
import type { AccessState, BenefitAccessSnapshot } from "@still/shared-types";
import DesktopPopup from "@still/core/ui/v3/DesktopPopup.svelte";
import MobilePopup from "@still/core/ui/v3/MobilePopup.svelte";
import ExtensionSettings from "@still/core/ui/v3/ExtensionSettings.svelte";
import { fixture as popupFixture } from "../../../../core/src/ui/v3/DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "../../../../core/src/ui/v3/ExtensionSettings.test-fixtures.js";
import { appManagedPopupAccount, appManagedSettingsSync, type AppManagedAccountSource } from "../../../lib/safari-v3.js";

const ACCOUNT_TAG = "Still Pro User";
const DEVICE_TAG = "Still Pro on this device";
const TEXT = { unreachable: "u", syncing: "s", synced: "Synced", checking: "c" };
const SIGNED_IN: AppManagedAccountSource = { userId: "00000000-0000-4000-8000-0000000000aa", accountEmail: "person@example.invalid",
  cloudReachable: true, pendingUpload: false, lastSyncedAt: 5, accountRevision: 1 };
const SIGNED_OUT: AppManagedAccountSource = { ...SIGNED_IN, userId: null, accountEmail: null };

type Held = boolean | "absent";
const withHeld = (access: BenefitAccessSnapshot, held: Held): BenefitAccessSnapshot =>
  held === "absent" ? access : { ...access, accountHoldsPro: held };

function expectTag(expected: string | null) {
  const card = screen.getByRole("heading", { name: "Settings sync" }).closest("section") as HTMLElement;
  for (const tag of [ACCOUNT_TAG, DEVICE_TAG]) {
    if (tag === expected) expect(within(card).getByText(tag)).toBeTruthy();
    else expect(within(card).queryByText(tag)).toBeNull();
  }
}

// [name, signed in, native's answer, Pro state, expected tag]
const CASES: [string, AppManagedAccountSource, Held, AccessState, string | null][] = [
  ["signed in, the account holds Still Pro", SIGNED_IN, true, "purchased", ACCOUNT_TAG],
  ["signed in, only this device holds Still Pro", SIGNED_IN, false, "purchased", DEVICE_TAG],
  ["signed in, an older native snapshot without the field", SIGNED_IN, "absent", "purchased", DEVICE_TAG],
  ["signed out with Still Pro on this device", SIGNED_OUT, true, "purchased", DEVICE_TAG],
  ["signed in, the account's answer but Still Pro is not verified here", SIGNED_IN, true, "verification_required", null],
  ["signed in, Still Pro locked", SIGNED_IN, false, "locked", null],
];

describe.each(CASES)("%s", (_name, source, held, state, expected) => {
  it("Safari popup on the Mac", async () => {
    const { props } = await popupFixture(state);
    props.access = withHeld(props.access, held);
    props.appHandoff = true;
    props.account = appManagedPopupAccount(source, TEXT, props.access);
    render(DesktopPopup, { props });
    expectTag(expected);
  });

  it("Safari popup on iPhone and iPad", async () => {
    const { props } = await popupFixture(state);
    const access = withHeld(props.access, held);
    render(MobilePopup, { props: {
      host: "safari", settings: props.settings, access, privacyUrl: props.privacyUrl, appHandoff: true,
      onGlobalChange: vi.fn(), onServiceChange: vi.fn(), onFeatureChange: vi.fn(), onSettings: vi.fn(), onSignIn: vi.fn(),
      account: appManagedPopupAccount(source, TEXT, access),
    } });
    expectTag(expected);
  });

  it("Safari Settings page", async () => {
    const { props } = await settingsFixture(state);
    props.access = withHeld(props.access, held);
    // As the Safari Settings host passes it: no in-page purchase producer, Still Pro opens the app.
    const { pro: _browserOnly, ...safari } = props;
    safari.proHandoff = vi.fn();
    safari.sync = appManagedSettingsSync(source, TEXT, safari.access);
    render(ExtensionSettings, { props: safari });
    expectTag(expected);
  });
});
