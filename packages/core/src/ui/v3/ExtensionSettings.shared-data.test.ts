// Account-wide "Delete shared data on all devices" on the V3 settings page (U5-W3 packet B; owner
// decisions 60, 61 and 74). Every string is decision 74's, verbatim, or a reused approved line.
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { fixture } from "./ExtensionSettings.test-fixtures.js";
import ExtensionSettings from "./ExtensionSettings.svelte";
import type { SharedDataProps } from "./extension-settings-presentation.js";
import { SHARED_DATA_COPY, WITHDRAWAL_OUTCOMES } from "./withdrawal-copy.js";

const LABEL = "Delete shared data on all devices";
const SUB =
  "Stops sharing on every device signed in to this account and deletes what they shared. Your account, settings and purchases stay.";
const TITLE = "Delete shared data from all your devices?";
const BODY =
  "This turns off sharing on every device signed in to this account and deletes the email and usage data shared while signed in. Your account, settings and purchases stay. Anything a device shared while signed out stays until you turn sharing off on that device.";
const ELSEWHERE = "Sharing was turned off from another device.";
const REQUESTED = "Deletion requested. Your shared data hasn't been deleted yet.";
const VERIFYING = "Confirming deletion with our providers…";
const DELETED = "Your shared data has been deleted.";
const FAILED = "We couldn't send your deletion request. Sharing stays off on this device.";

async function setup(shared?: Partial<SharedDataProps>) {
  const { props } = await fixture();
  const onDelete = vi.fn();
  const onRetry = vi.fn();
  props.sync.account = {
    address: "person@fixture.test",
    identity: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: 1,
    confirmed: true,
    onDeleteAccount: vi.fn(),
    sharedData: shared === undefined ? undefined : { withdrawal: "none", onDelete, onRetry, ...shared },
  };
  const view = render(ExtensionSettings, { props });
  return { props, view, onDelete, onRetry };
}

const dialog = () => screen.queryByRole("dialog", { name: TITLE });

describe("Delete shared data on all devices", () => {
  it("uses decision 74's wording verbatim and reuses the approved withdrawal lines", () => {
    expect(SHARED_DATA_COPY).toEqual({
      label: LABEL,
      sub: SUB,
      confirmTitle: TITLE,
      confirmBody: BODY,
      confirm: "Delete shared data",
      cancel: "Cancel",
      stoppedElsewhere: ELSEWHERE,
    });
    expect(Object.fromEntries(Object.entries(WITHDRAWAL_OUTCOMES).map(([k, v]) => [k, v.text]))).toEqual({
      requested: REQUESTED,
      verifying: VERIFYING,
      deleted: DELETED,
      failed: FAILED,
    });
    // Never "everywhere"; nothing says this device's signed-out data is deleted (decision 61).
    const all = JSON.stringify([SHARED_DATA_COPY, WITHDRAWAL_OUTCOMES]).toLowerCase();
    expect(all).not.toContain("everywhere");
    expect(all).not.toMatch(/signed[- ]out data (is|has been|will be) deleted/);
  });

  it("idle: the action sits with Delete account, with its sub-line", async () => {
    const { view, onDelete } = await setup({});
    const action = screen.getByRole("button", { name: LABEL });
    expect(action).toBeEnabled();
    expect(action).toHaveAccessibleDescription(SUB);
    expect(screen.getByText(SUB)).toBeVisible();
    // Next to Delete account, inside the same settings-sync card.
    const card = screen.getByRole("button", { name: "Delete account" }).closest("section")!;
    expect(within(card).getByRole("button", { name: LABEL })).toBe(action);
    expect(dialog()).toBeNull();
    for (const line of [REQUESTED, VERIFYING, DELETED, FAILED, ELSEWHERE]) expect(screen.queryByText(line)).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    view.unmount();
  });

  it("confirm: the dialog asks first; only its confirm button acts, once", async () => {
    const { view, onDelete } = await setup({});
    await fireEvent.click(screen.getByRole("button", { name: LABEL }));
    const open = dialog()!;
    expect(open).toBeVisible();
    expect(within(open).getByText(BODY)).toBeVisible();
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.click(within(open).getByRole("button", { name: "Delete shared data" }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    view.unmount();
  });

  it("cancel: closes without acting, and Escape does too", async () => {
    const { view, onDelete } = await setup({});
    await fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await fireEvent.click(within(dialog()!).getByRole("button", { name: "Cancel" }));
    expect(dialog()).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    view.unmount();
  });

  it("a sign-out or another account closes an open confirmation without acting", async () => {
    const { props, view, onDelete } = await setup({});
    await fireEvent.click(screen.getByRole("button", { name: LABEL }));
    props.sync.account = { ...props.sync.account!, identity: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revision: 2 };
    await view.rerender(props);
    expect(dialog()).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    view.unmount();
  });

  it("sending: the action waits (no handler) and shows no line it was not given", async () => {
    const { view } = await setup({ onDelete: undefined });
    expect(screen.getByRole("button", { name: LABEL })).toBeDisabled();
    for (const line of [REQUESTED, VERIFYING, DELETED, FAILED]) expect(screen.queryByText(line)).toBeNull();
    view.unmount();
  });

  it.each([
    ["requested", REQUESTED],
    ["verifying", VERIFYING],
  ] as const)("progress (%s): the pending line, and the action is not offered again", async (withdrawal, line) => {
    const { view } = await setup({ withdrawal });
    expect(screen.getByRole("status")).toHaveTextContent(line);
    expect(screen.queryByRole("button", { name: LABEL })).toBeNull();
    expect(screen.queryByText(DELETED)).toBeNull();
    view.unmount();
  });

  it("done: the success line; the action may be asked again", async () => {
    const { view } = await setup({ withdrawal: "deleted" });
    expect(screen.getByText(DELETED)).toBeVisible();
    expect(screen.getByRole("button", { name: LABEL })).toBeEnabled();
    view.unmount();
  });

  it("failure and retry: the approved failure line with Try again, which calls retry only", async () => {
    const { view, onRetry, onDelete } = await setup({ withdrawal: "failed" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(FAILED);
    expect(screen.queryByRole("button", { name: LABEL })).toBeNull();
    await fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
    view.unmount();
  });

  it("another device: the other-device line", async () => {
    const { view } = await setup({ stoppedElsewhere: true });
    expect(screen.getByText(ELSEWHERE)).toBeVisible();
    view.unmount();
  });

  it("dormancy: without the host's offer nothing of it renders", async () => {
    const { view } = await setup(undefined);
    expect(screen.getByRole("button", { name: "Delete account" })).toBeVisible();
    for (const text of [LABEL, SUB, ELSEWHERE]) expect(screen.queryByText(text)).toBeNull();
    expect(document.querySelector("[data-shared-data]")).toBeNull();
    view.unmount();
  });

  it("signed out: nothing of it renders even if the host offered it", async () => {
    const { props } = await fixture();
    props.sync = { onSignIn: vi.fn() };
    const view = render(ExtensionSettings, { props });
    expect(screen.queryByText(LABEL)).toBeNull();
    view.unmount();
  });
});
