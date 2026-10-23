import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import App from "../App.svelte";
import { DATA_PERMISSION_COPY, type DataPermission } from "../data-permission.js";
import { browser, capture, flush, purchase } from "./committed-popup-host.fixtures.js";

// Firefox's email permission on the settings page's signed-out sync card (App.svelte optionsSync):
// a plain decline at Send code stays in the sign-in sheet and the card keeps its pitch; only a
// withdrawal (the background signed the account out) puts the permission line on the card.

const PITCH = "Sync settings across devices and browsers. Free.";

beforeAll(async () => {
  await import("../v3/ExtensionSettings.svelte");
});
afterEach(() => vi.restoreAllMocks());

const declining: DataPermission = {
  ask: vi.fn(async () => false),
  granted: vi.fn(async () => false),
};

async function signedOutOptions() {
  await browser();
  const p = purchase();
  const state = capture({ purchase: { ...p.deps, dataPermission: declining } });
  await flush();
  render(App, {
    controller: state.controller,
    committedPopupBinding: state.binding,
    settingsPresentation: {
      browser: "Firefox" as const,
      loadSettings: () => import("../v3/ExtensionSettings.svelte"),
      help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
    },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
  return { controller: state.controller, requestCode: p.deps.auth.requestCode };
}

describe("the signed-out sync card on Firefox", () => {
  it("keeps its pitch after a plain decline at Send code", async () => {
    const { controller, requestCode } = await signedOutOptions();
    expect(screen.getByText(PITCH)).toBeTruthy();
    await controller.signIn("me@example.com");
    await tick();
    expect(controller.dataPermissionNotice).toBe("email");
    expect(requestCode).not.toHaveBeenCalled();
    expect(screen.getByText(PITCH)).toBeTruthy();
    expect(screen.queryByText(DATA_PERMISSION_COPY.email)).toBeNull();
  });

  it("shows the permission line in place of the pitch after a withdrawal, and drops it once granted again", async () => {
    const { controller } = await signedOutOptions();
    controller.showEmailPermissionWithdrawn();
    await tick();
    expect(screen.getByText(DATA_PERMISSION_COPY.email)).toBeTruthy();
    expect(screen.queryByText(PITCH)).toBeNull();
    controller.clearEmailPermissionWithdrawn();
    await tick();
    expect(screen.getByText(PITCH)).toBeTruthy();
    expect(screen.queryByText(DATA_PERMISSION_COPY.email)).toBeNull();
  });
});
