import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { DEFAULT_SETTINGS, type AccessState } from "@still/shared-types";
import {
  AtomicSettingsWriter,
  requireModernSettings,
} from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import FeatureRow from "./FeatureRow.svelte";

async function fixture(state: AccessState) {
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
  await cache.setFeature("youtube.comments", true);
  let pending: Promise<unknown> = Promise.resolve();
  const props = {
    id: "youtube.comments" as const,
    label: "Comments",
    state,
    checked: requireModernSettings(cache.currentRecord()).sites[
      "youtube.comments"
    ],
    inactive: false,
    unsupportedText: "Not available in Safari. Your choice is saved.",
    lockLabel: "Comments. Included in Still Pro. Open the Still app",
    onChange: vi.fn((next: boolean) => {
      pending = cache.setFeature("youtube.comments", next);
    }),
    onLock: undefined as (() => void) | undefined,
  };
  return { props, storage, cache, settled: () => pending };
}

describe("controlled shared feature access row", () => {
  it.each(["free", "purchased", "protected"] as const)(
    "%s forwards one requested change to the real writer and waits for supplied saved state",
    async (state) => {
      const { props, storage, cache, settled } = await fixture(state);
      const view = render(FeatureRow, { props });
      const control = screen.getByRole("switch", { name: "Comments" });
      expect(control).toHaveAttribute("aria-checked", "true");
      await fireEvent.click(control);
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(control).toHaveAttribute("aria-checked", "true");
      await settled();
      expect(
        requireModernSettings((await storage.get())!).sites["youtube.comments"],
      ).toBe(false);
      props.checked = requireModernSettings(cache.currentRecord()).sites[
        "youtube.comments"
      ];
      await view.rerender(props);
      expect(control).toHaveAttribute("aria-checked", "false");
      view.unmount();
    },
  );

  it.each([
    ["checking", "Checking your Still Pro access. Your choice is saved."],
    [
      "verification_required",
      "Verify Still Pro to use this. Your choice is saved.",
    ],
  ] as const)(
    "%s retains the saved choice and accessible explanation without a durable write",
    async (state, note) => {
      const { props, storage, settled } = await fixture(state);
      const saved = await storage.get();
      const view = render(FeatureRow, { props });
      const control = screen.getByRole("switch", { name: "Comments" });
      expect(control).toHaveAttribute("aria-checked", "true");
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).toHaveAccessibleDescription(note);
      control.focus();
      expect(control).toHaveFocus();
      await fireEvent.click(control);
      await settled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onChange).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: props.lockLabel }),
      ).toBeNull();
      view.unmount();
    },
  );

  it("holds usable saved choices while inactive and resumes only after the parent enables the row", async () => {
    const { props, storage, settled } = await fixture("purchased");
    props.inactive = true;
    const saved = await storage.get();
    const view = render(FeatureRow, { props });
    const control = screen.getByRole("switch", { name: "Comments" });
    await fireEvent.click(control);
    await settled();
    expect(await storage.get()).toEqual(saved);
    expect(props.onChange).not.toHaveBeenCalled();
    expect(control).toHaveAttribute("aria-checked", "true");
    props.inactive = false;
    await view.rerender(props);
    await fireEvent.click(control);
    await settled();
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.comments"],
    ).toBe(false);
    view.unmount();
  });

  it("uses each caller's unsupported explanation without exposing or rewriting the saved choice", async () => {
    const { props, storage } = await fixture("unsupported");
    const saved = await storage.get();
    const view = render(FeatureRow, { props });
    expect(screen.getByText(props.unsupportedText)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    props.unsupportedText =
      "Not available in this browser. Your choice is saved.";
    await view.rerender(props);
    expect(screen.getByText(props.unsupportedText)).toBeTruthy();
    expect(screen.queryByText(/in Safari/)).toBeNull();
    expect(await storage.get()).toEqual(saved);
    expect(props.onChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it("uses only the supplied lock action and label, and holds it when the caller withdraws the port", async () => {
    const { props, storage } = await fixture("locked");
    const saved = await storage.get();
    const onLock = vi.fn();
    props.onLock = onLock;
    const view = render(FeatureRow, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: props.lockLabel }),
    );
    expect(onLock).toHaveBeenCalledOnce();
    props.lockLabel = "Comments. Included in Still Pro. See Still Pro";
    props.onLock = undefined;
    await view.rerender(props);
    const held = screen.getByRole("button", { name: props.lockLabel });
    expect(held).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(held);
    expect(onLock).toHaveBeenCalledOnce();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(await storage.get()).toEqual(saved);
    expect(screen.queryByRole("switch")).toBeNull();
    view.unmount();
  });
});
