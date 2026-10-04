import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { SettingsCache } from "../../storage/cache.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import { UiController } from "../controller.svelte.js";
import App from "../App.svelte";
import { createDesktopPopupBinding } from "./desktop-popup-binding.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  await writer.initialize("never-linked");
  const commit = vi.fn(writer.commit.bind(writer));
  const cache = new SettingsCache({
    get: storage.get.bind(storage),
    set: storage.set.bind(storage),
    subscribe: storage.subscribe.bind(storage),
    commitIntent: (intent) => commit(intent),
  });
  await cache.hydrate();
  const access = new EntitlementCache({
    get: async () => false,
    set: async () => {},
    subscribe: () => () => {},
  });
  const binding = createDesktopPopupBinding(cache, access);
  const controller = new UiController({ cache, host: { canPurchase: false } });
  return { storage, writer, commit, binding, controller };
}

describe("App-owned popup view binding", () => {
  it("subscribes once and unsubscribes before stopping each replaced or unmounted attachment", async () => {
    const first = await fixture();
    const second = await fixture();
    const order: string[] = [];
    function observe(state: typeof first, name: string) {
      const subscribe = state.binding.subscribe;
      const stop = state.binding.stop;
      const subscription = vi
        .spyOn(state.binding, "subscribe")
        .mockImplementation((listener) => {
          const unsubscribe = subscribe(listener);
          return () => {
            order.push(`${name}:unsubscribe`);
            unsubscribe();
          };
        });
      const stopped = vi.spyOn(state.binding, "stop").mockImplementation(() => {
        order.push(`${name}:stop`);
        stop();
      });
      return { subscription, stopped };
    }
    const a = observe(first, "a");
    const b = observe(second, "b");
    const props = {
      controller: first.controller,
      committedPopupBinding: first.binding,
    };
    const view = render(App, props);
    await tick();

    expect(a.subscription).toHaveBeenCalledOnce();
    expect(a.stopped).not.toHaveBeenCalled();
    await view.rerender({
      controller: second.controller,
      committedPopupBinding: second.binding,
    });
    await tick();
    expect(order).toEqual(["a:unsubscribe", "a:stop"]);
    expect(b.subscription).toHaveBeenCalledOnce();
    view.unmount();
    expect(order).toEqual([
      "a:unsubscribe",
      "a:stop",
      "b:unsubscribe",
      "b:stop",
    ]);
    expect(a.stopped).toHaveBeenCalledOnce();
    expect(b.stopped).toHaveBeenCalledOnce();
  });

  it("returns to controller-owned legacy choices when the optional binding is removed", async () => {
    const f = await fixture();
    // The two independent settings sources deliberately disagree.
    await f.binding.setGlobalOn(false);
    f.controller.settings = { ...f.controller.settings, globalOn: true };
    const props = {
      controller: f.controller,
      committedPopupBinding: f.binding,
    };
    const view = render(App, props);
    await tick();
    expect(
      screen.getByRole("switch", { name: "Still on/off" }),
    ).toHaveAttribute("aria-checked", "false");
    await view.rerender({ ...props, committedPopupBinding: undefined });
    await tick();
    expect(f.binding.current().reason).toBe("stopped");
    expect(
      screen.getByRole("switch", { name: "Still on/off" }),
    ).toHaveAttribute("aria-checked", "true");
    const toggle = vi.spyOn(f.controller, "toggleGlobal");
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    expect(toggle).toHaveBeenCalledOnce();
  });
});
