import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
  type StoredSettingsRecord,
  requireModernSettings,
} from "../../storage/index.js";
import App from "../App.svelte";
import { STRINGS } from "../strings.js";
import {
  flush,
  gate,
  browser,
  capture,
  globalSwitch,
  serviceSwitch,
} from "./committed-popup-host.fixtures.js";

describe("current-authority recovery in the same mounted host", () => {
  async function readyHost(route = "desktop-global") {
    const f = await browser();
    await f.authority.commitIntent({
      path: "services.instagram",
      value: false,
      updatedAt: 101,
    });
    await f.authority.commitIntent({
      path: "sites.youtube.shorts",
      value: false,
      updatedAt: 102,
    });
    const state = capture();
    await flush();
    const telemetry = vi.fn(),
      onSettings = vi.fn();
    const desktop = route.startsWith("desktop");
    const props = {
      controller: state.controller,
      committedPopupBinding: state.binding,
      compact: true,
      onCommittedPopupToggle: telemetry,
      popupPresentation: desktop
        ? {
            browser: "Chrome" as const,
            onSettings,
            loadDesktop: () => import("../v3/DesktopPopup.svelte"),
          }
        : undefined,
    };
    const view = render(App, props);
    const global = () =>
      desktop ? screen.getByRole("switch", { name: "Still" }) : globalSwitch();
    await waitFor(() => expect(global()).toBeTruthy());
    await flush();
    if (route === "desktop-feature")
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
    const control = () =>
      route.endsWith("feature")
        ? screen.getByRole("switch", { name: "Shorts" })
        : route.endsWith("service")
          ? desktop
            ? screen.getByRole("switch", { name: "Still on Instagram" })
            : serviceSwitch("instagram")
          : global();
    const saved = (await f.authority.get())!;
    const get = vi.spyOn(chrome.storage.local, "get");
    const reread = vi.spyOn(state.binding, "rereadAuthority");
    get.mockClear();
    f.set.mockClear();
    f.sendMessage.mockClear();
    return {
      f,
      state,
      view,
      props,
      telemetry,
      onSettings,
      get,
      reread,
      control,
      saved,
    };
  }

  it.each([
    "desktop-global",
    "desktop-service",
    "desktop-feature",
    "legacy-global",
    "legacy-service",
  ])(
    "%s recovers one failed durable write with one read, no replay, then commits only the next deliberate click",
    async (route) => {
      const h = await readyHost(route);
      h.f.set.mockRejectedValueOnce(new Error("Synthetic local.set refusal"));
      await fireEvent.click(h.control());
      await waitFor(() => expect(h.reread).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(h.state.binding.current().commandAvailability).toBe("ready"),
      );
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
      expect(h.get).toHaveBeenCalledTimes(2); // writer's admission read plus the single recovery read
      expect(h.telemetry).not.toHaveBeenCalled();
      expect(await h.f.authority.get()).toEqual(h.saved);
      expect(h.control()).toHaveAttribute(
        "aria-checked",
        route.endsWith("global") ? "true" : "false",
      );
      await fireEvent.click(h.control());
      await waitFor(() =>
        expect(h.control()).toHaveAttribute(
          "aria-checked",
          route.endsWith("global") ? "false" : "true",
        ),
      );
      expect(h.reread).toHaveBeenCalledOnce();
      expect(h.f.set).toHaveBeenCalledTimes(2);
      expect(h.f.sendMessage).toHaveBeenCalledTimes(2);
      const saved = requireModernSettings((await h.f.authority.get())!);
      expect(saved.globalOn).toBe(!route.endsWith("global"));
      expect(saved.services.instagram).toBe(route.endsWith("service"));
      expect(saved.sites["youtube.shorts"]).toBe(route.endsWith("feature"));
      expect(saved.services.facebook).toBe(true);
      if (route.endsWith("feature")) expect(h.telemetry).not.toHaveBeenCalled();
      else
        await waitFor(() =>
          expect(h.telemetry).toHaveBeenCalledExactlyOnceWith(
            route.endsWith("global")
              ? { enabled: false }
              : { service: "instagram", enabled: true },
          ),
        );
    },
  );

  it.each(["read-failure", "previous-account"] as const)(
    "keeps %s held after the one read without replay or false commit",
    async (reason) => {
      const h = await readyHost();
      const get = h.get.getMockImplementation()!;
      if (reason === "read-failure")
        h.get
          .mockImplementationOnce(get)
          .mockRejectedValueOnce(new Error("Synthetic read refusal"));
      h.f.set.mockImplementationOnce(async () => {
        if (reason === "previous-account")
          h.f.store["still:settings"] = {
            ...h.saved,
            atomic: {
              ...h.saved.atomic!,
              ownership: "previous-account",
              paused: "ownership-unconfirmed",
              scope: { ...h.saved.atomic!.scope, generation: h.saved.atomic!.scope.generation + 1 },
              sequence: h.saved.atomic!.sequence + 1,
            },
          };
        throw new Error("Synthetic write refusal without notification");
      });
      await fireEvent.click(h.control());
      await waitFor(() => expect(h.reread).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(h.state.binding.current().reason).toBe(
          reason === "previous-account" ? "ownership-unconfirmed" : "read-failed",
        ),
      );
      expect(h.state.binding.current().commandAvailability).toBe("unavailable");
      expect(h.control()).toHaveAttribute("aria-disabled", "true");
      expect(h.control()).toHaveAttribute("aria-checked", "true");
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
      expect(h.telemetry).not.toHaveBeenCalled();
      h.control().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(h.reread).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it("keeps a newer durable hold when an admitted recovery read returns an older healthy snapshot", async () => {
    const h = await readyHost();
    const get = h.get.getMockImplementation()!;
    const entered = gate(),
      held = gate();
    h.get.mockImplementationOnce(get).mockImplementationOnce(async () => {
      entered.open();
      await held.promise;
      return { "still:settings": h.saved };
    });
    h.f.set.mockRejectedValueOnce(new Error("Synthetic write refusal"));
    await fireEvent.click(h.control());
    await entered.promise;
    try {
      const newer = {
        ...h.saved,
        atomic: {
          ...h.saved.atomic!,
          sequence: h.saved.atomic!.sequence + 1,
          paused: "ordering-hold",
        },
      };
      await h.f.external(newer);
      held.open();
      await flush();
      await flush();
      expect(h.state.binding.current().reason).toBe("ordering-hold");
      expect(h.state.binding.current().commandAvailability).toBe("unavailable");
      expect(h.reread).toHaveBeenCalledOnce();
      expect(h.control()).toHaveAttribute("aria-checked", "true");
      expect(h.telemetry).not.toHaveBeenCalled();
      expect(await h.f.authority.get()).toEqual(newer);
    } finally {
      held.open();
    }
  });

  it.each(["unmount", "replacement"] as const)(
    "fences a previously admitted read after %s without replaying its failed intent",
    async (close) => {
      const h = await readyHost();
      const get = h.get.getMockImplementation()!;
      const entered = gate(),
        held = gate();
      h.get.mockImplementationOnce(get).mockImplementationOnce(async () => {
        entered.open();
        await held.promise;
        return { "still:settings": h.saved };
      });
      h.f.set.mockRejectedValueOnce(new Error("Synthetic write refusal"));
      await fireEvent.click(h.control());
      await entered.promise;
      try {
        const stopped = h.state.binding.current();
        if (close === "unmount") h.view.unmount();
        else {
          const replacement = capture();
          await flush();
          const otherRead = vi.spyOn(replacement.binding, "rereadAuthority");
          await h.view.rerender({
            ...h.props,
            controller: replacement.controller,
            committedPopupBinding: replacement.binding,
          });
          await fireEvent.click(h.control());
          await waitFor(() =>
            expect(h.control()).toHaveAttribute("aria-checked", "false"),
          );
          expect(otherRead).not.toHaveBeenCalled();
        }
        held.open();
        await flush();
        await flush();
        expect(h.state.binding.current()).toEqual({
          ...stopped,
          commandAvailability: "unavailable",
          reason: "stopped",
        });
        expect(h.reread).toHaveBeenCalledOnce();
        if (close === "unmount") {
          expect(h.f.set).toHaveBeenCalledOnce();
          expect(h.telemetry).not.toHaveBeenCalled();
          expect(await h.f.authority.get()).toEqual(h.saved);
        } else {
          expect(h.f.set).toHaveBeenCalledTimes(2);
          expect(h.control()).toHaveAttribute("aria-checked", "false");
          expect(h.telemetry).toHaveBeenCalledExactlyOnceWith({
            enabled: false,
          });
        }
      } finally {
        held.open();
      }
    },
  );

  it.each(["unmount", "replacement"] as const)(
    "does not recover a late rejected command after %s",
    async (close) => {
      const h = await readyHost();
      const entered = gate(),
        held = gate();
      vi.spyOn(h.state.binding, "setGlobalOn").mockImplementationOnce(
        async () => {
          entered.open();
          await held.promise;
          throw new Error("Synthetic late command rejection");
        },
      );
      await fireEvent.click(h.control());
      await entered.promise;
      try {
        if (close === "unmount") h.view.unmount();
        else {
          const replacement = capture();
          await flush();
          await h.view.rerender({
            ...h.props,
            controller: replacement.controller,
            committedPopupBinding: replacement.binding,
          });
        }
        held.open();
        await flush();
        await flush();
        expect(h.reread).not.toHaveBeenCalled();
        expect(h.telemetry).not.toHaveBeenCalled();
        expect(h.f.set).not.toHaveBeenCalled();
        expect(await h.f.authority.get()).toEqual(h.saved);
      } finally {
        held.open();
      }
    },
  );

  it("does not recover an older failed command after a newer deliberate command", async () => {
    const h = await readyHost();
    const entered = gate(),
      held = gate();
    vi.spyOn(h.state.binding, "setGlobalOn").mockImplementationOnce(
      async () => {
        entered.open();
        await held.promise;
        return { status: "unavailable", reason: "authority-unavailable" };
      },
    );
    await fireEvent.click(h.control());
    await entered.promise;
    try {
      await fireEvent.click(
        screen.getByRole("switch", { name: "Still on Instagram" }),
      );
      await waitFor(() =>
        expect(h.telemetry).toHaveBeenCalledExactlyOnceWith({
          service: "instagram",
          enabled: true,
        }),
      );
      held.open();
      await flush();
      await flush();
      expect(h.reread).not.toHaveBeenCalled();
      expect(h.telemetry).toHaveBeenCalledOnce();
      expect(requireModernSettings((await h.f.authority.get())!)).toMatchObject(
        { globalOn: true, services: { instagram: true } },
      );
    } finally {
      held.open();
    }
  });

  it("reports each real overlapping commit once while the same view remains current", async () => {
    const h = await readyHost();
    const entered = gate(),
      held = gate();
    h.f.port(async (intent) => {
      if (intent.path === "globalOn") {
        entered.open();
        await held.promise;
      }
      return h.f.authority.commitIntent(intent);
    });
    await fireEvent.click(h.control());
    await entered.promise;
    try {
      await fireEvent.click(
        screen.getByRole("switch", { name: "Still on Instagram" }),
      );
      await waitFor(() =>
        expect(h.telemetry).toHaveBeenCalledExactlyOnceWith({
          service: "instagram",
          enabled: true,
        }),
      );
      held.open();
      await waitFor(() => expect(h.telemetry).toHaveBeenCalledTimes(2));
      expect(h.telemetry.mock.calls).toEqual([
        [{ service: "instagram", enabled: true }],
        [{ enabled: false }],
      ]);
      expect(h.reread).not.toHaveBeenCalled();
      expect(requireModernSettings((await h.f.authority.get())!)).toMatchObject(
        { globalOn: false, services: { instagram: true } },
      );
    } finally {
      held.open();
    }
  });

  it("recovers a current rejected command promise once without manufacturing a commit", async () => {
    const h = await readyHost();
    vi.spyOn(h.state.binding, "setGlobalOn").mockRejectedValueOnce(
      new Error("Synthetic boundary rejection"),
    );
    await fireEvent.click(h.control());
    await waitFor(() => expect(h.reread).toHaveBeenCalledOnce());
    expect(h.f.set).not.toHaveBeenCalled();
    expect(h.f.sendMessage).not.toHaveBeenCalled();
    expect(h.telemetry).not.toHaveBeenCalled();
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.control()).toHaveAttribute("aria-checked", "true");
  });

  it("does not reread or replay healthy no-op or invalid/inactive outcomes", async () => {
    const h = await readyHost();
    h.f.port(async () => ({ ...h.saved, intentCommitted: false }));
    await fireEvent.click(h.control());
    await flush();
    expect(h.reread).not.toHaveBeenCalled();
    expect(h.telemetry).not.toHaveBeenCalled();
    vi.spyOn(h.state.binding, "setGlobalOn").mockResolvedValueOnce({
      status: "rejected",
      reason: "invalid-input",
    });
    await fireEvent.click(h.control());
    await flush();
    expect(h.reread).not.toHaveBeenCalled();
    expect(h.telemetry).not.toHaveBeenCalled();
    expect(h.f.set).not.toHaveBeenCalled();
    expect(h.f.sendMessage).toHaveBeenCalledOnce();
  });
});

describe("visible current-settings recovery in the maintained App", () => {
  const key = "still:settings";
  async function heldHost(route: "desktop" | "legacy" = "desktop") {
    const f = await browser();
    await f.authority.commitIntent({
      path: "services.instagram",
      value: false,
      updatedAt: 201,
    });
    await f.authority.commitIntent({
      path: "sites.youtube.shorts",
      value: false,
      updatedAt: 202,
    });
    f.store[key] = {
      ...(f.store[key] as StoredSettingsRecord),
      opaqueRoot: { retained: true },
    };
    const state = capture();
    await flush();
    const telemetry = vi.fn();
    const onSettings = vi.fn();
    const props = {
      controller: state.controller,
      committedPopupBinding: state.binding,
      onCommittedPopupToggle: telemetry,
      compact: true,
      popupPresentation:
        route === "desktop"
          ? {
              browser: "Chrome" as const,
              onSettings,
              loadDesktop: () => import("../v3/DesktopPopup.svelte"),
            }
          : undefined,
    };
    const view = render(App, props);
    const control = () =>
      screen.getByRole("switch", {
        name: route === "desktop" ? "Still" : "Still on/off",
      });
    await waitFor(() => expect(control()).toBeTruthy());
    await flush();
    // This browser fixture implements the single-key Promise form, not callback overloads.
    const local = chrome.storage.local as unknown as {
      get(key: string): Promise<Record<string, unknown>>;
    };
    const working = local.get;
    const get = vi.spyOn(local, "get");
    const reread = vi.spyOn(state.binding, "rereadAuthority");
    const saved = JSON.stringify(f.store[key]);
    f.set.mockClear();
    f.sendMessage.mockClear();
    get.mockClear();
    get
      .mockImplementationOnce(working)
      .mockRejectedValueOnce(
        new Error("Synthetic failed automatic authority read"),
      );
    f.set.mockRejectedValueOnce(
      new Error("Synthetic failed deliberate settings write"),
    );
    await fireEvent.click(control());
    await waitFor(() =>
      expect(state.binding.current().reason).toBe("read-failed"),
    );
    await flush();
    if (route === "desktop")
      expect(control()).toHaveAttribute("aria-disabled", "true");
    else expect(control()).toBeDisabled();
    expect(f.set).toHaveBeenCalledOnce();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(reread).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(2);
    expect(telemetry).not.toHaveBeenCalled();
    return {
      f,
      state,
      props,
      view,
      telemetry,
      onSettings,
      get,
      working,
      reread,
      saved,
      control,
    };
  }
  function recovery() {
    return screen.getByRole("button", {
      name: "Try again",
    }) as HTMLButtonElement;
  }

  it.each(["desktop", "legacy"] as const)(
    "%s offers actual recovery after automatic reread fails, with no write/replay or false telemetry",
    async (route) => {
      const h = await heldHost(route);
      expect(screen.getByRole("status").textContent).toBe(
        "Settings are unavailable.",
      );
      const button = recovery();
      button.focus();
      expect(document.activeElement).toBe(button);
      await fireEvent.click(button);
      await waitFor(() =>
        expect(h.state.binding.current().commandAvailability).toBe("ready"),
      );
      await waitFor(() =>
        expect(screen.queryByText("Settings are unavailable.")).toBeNull(),
      );
      expect(h.get).toHaveBeenCalledTimes(3);
      expect(h.reread).toHaveBeenCalledTimes(2);
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
      expect(JSON.stringify(h.f.store[key])).toBe(h.saved);
      expect(h.telemetry).not.toHaveBeenCalled();
      if (route === "desktop")
        expect(h.control()).not.toHaveAttribute("aria-disabled", "true");
      else expect(h.control()).not.toBeDisabled();
      await fireEvent.click(h.control());
      await waitFor(() =>
        expect(h.control()).toHaveAttribute("aria-checked", "false"),
      );
      expect(h.f.set).toHaveBeenCalledTimes(2);
      expect(h.f.sendMessage).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(h.telemetry).toHaveBeenCalledExactlyOnceWith({ enabled: false }),
      );
      expect((await h.f.authority.get())!.settings.services.instagram).toBe(
        false,
      );
      expect(
        requireModernSettings((await h.f.authority.get())!).sites[
          "youtube.shorts"
        ],
      ).toBe(false);
    },
  );
  it("disables duplicate recovery while its actual pure read is pending", async () => {
    const h = await heldHost();
    const entered = gate(),
      read = gate();
    h.get.mockImplementationOnce(async (keys) => {
      entered.open();
      await read.promise;
      return h.working(keys);
    });
    await fireEvent.click(recovery());
    await entered.promise;
    try {
      expect(recovery().disabled).toBe(true);
      recovery().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(h.get).toHaveBeenCalledTimes(3);
      expect(h.reread).toHaveBeenCalledTimes(2);
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.telemetry).not.toHaveBeenCalled();
    } finally {
      read.open();
    }
    expect(await h.reread.mock.results.at(-1)!.value).toEqual({
      status: "ready",
    });
    await waitFor(() =>
      expect(h.state.binding.current().commandAvailability).toBe("ready"),
    );
    expect(JSON.stringify(h.f.store[key])).toBe(h.saved);
  });
  it.each(["rejected", "missing"] as const)(
    "keeps %s current read truthful and recovery reachable without defaults",
    async (failure) => {
      const h = await heldHost();
      if (failure === "rejected")
        h.get.mockRejectedValueOnce(
          new Error("Synthetic explicit read failed"),
        );
      else h.get.mockResolvedValueOnce({});
      await fireEvent.click(recovery());
      await waitFor(() => expect(h.reread).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(recovery().disabled).toBe(false));
      expect(h.state.binding.current().commandAvailability).toBe("unavailable");
      expect(h.control()).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("status").textContent).toBe(
        "Settings are unavailable.",
      );
      expect(JSON.stringify(h.f.store[key])).toBe(h.saved);
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
      expect(h.telemetry).not.toHaveBeenCalled();
      await fireEvent.click(recovery());
      await waitFor(() =>
        expect(h.state.binding.current().commandAvailability).toBe("ready"),
      );
      expect(h.get).toHaveBeenCalledTimes(4);
      expect(h.f.set).toHaveBeenCalledOnce();
    },
  );
  it("initial actual absence reports unavailable settings and never invents a sync check or seeds defaults", async () => {
    const f = await browser();
    delete f.store[key];
    f.set.mockClear();
    const state = capture();
    await flush();
    render(App, {
      controller: state.controller,
      committedPopupBinding: state.binding,
      compact: true,
    });
    await flush();
    expect(screen.getByRole("status").textContent).toBe(
      "Settings are unavailable.",
    );
    expect(screen.queryByText(STRINGS.sync.checking)).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    await fireEvent.click(recovery());
    await flush();
    expect(state.binding.current().commandAvailability).toBe("unavailable");
    expect(Object.hasOwn(f.store, key)).toBe(false);
    expect(f.set).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Privacy policy" })).toBeTruthy();
  });

  it("stops the old binding after unmount without replay or late view publication", async () => {
    const h = await heldHost();
    const entered = gate(),
      read = gate();
    h.get.mockImplementationOnce(async (keys) => {
      const saved = await h.working(keys);
      entered.open();
      await read.promise;
      return saved;
    });
    await fireEvent.click(recovery());
    await entered.promise;
    h.view.unmount();
    try {
      expect(h.state.binding.current().reason).toBe("stopped");
    } finally {
      read.open();
    }
    expect(await h.reread.mock.results.at(-1)!.value).toEqual({
      status: "unavailable",
      reason: "stopped",
    });
    await flush();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(h.f.set).toHaveBeenCalledOnce();
    expect(h.f.sendMessage).toHaveBeenCalledOnce();
    expect(h.telemetry).not.toHaveBeenCalled();
    expect(JSON.stringify(h.f.store[key])).toBe(h.saved);
  });
  it("an old read finalizer cannot release the replacement binding's pending recovery", async () => {
    const h = await heldHost();
    const oldEntered = gate(),
      oldRead = gate(),
      nextEntered = gate(),
      nextRead = gate();
    h.get.mockImplementationOnce(async (keys) => {
      const saved = await h.working(keys);
      oldEntered.open();
      await oldRead.promise;
      return saved;
    });
    await fireEvent.click(recovery());
    await oldEntered.promise;
    const second = capture();
    await flush();
    h.get.mockRejectedValueOnce(
      new Error("Synthetic replacement authority read fails"),
    );
    await second.binding.rereadAuthority();
    await h.view.rerender({
      ...h.props,
      controller: second.controller,
      committedPopupBinding: second.binding,
    });
    await flush();
    h.get.mockImplementationOnce(async (keys) => {
      const saved = await h.working(keys);
      nextEntered.open();
      await nextRead.promise;
      return saved;
    });
    await fireEvent.click(recovery());
    await nextEntered.promise;
    try {
      oldRead.open();
      await h.reread.mock.results.at(-1)!.value;
      await flush();
      expect(recovery()).toBeDisabled();
      expect(second.binding.current().commandAvailability).toBe("unavailable");
      expect(h.state.binding.current().reason).toBe("stopped");
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.telemetry).not.toHaveBeenCalled();
    } finally {
      oldRead.open();
      nextRead.open();
    }
    await waitFor(() =>
      expect(second.binding.current().commandAvailability).toBe("ready"),
    );
    expect(JSON.stringify(h.f.store[key])).toBe(h.saved);
  });
  it("A-B-A return never offers recovery or enabled commands for the stopped binding", async () => {
    const h = await heldHost();
    const entered = gate(),
      read = gate();
    h.get.mockImplementationOnce(async (keys) => {
      const saved = await h.working(keys);
      entered.open();
      await read.promise;
      return saved;
    });
    await fireEvent.click(recovery());
    await entered.promise;
    const second = capture();
    await flush();
    await h.view.rerender({
      ...h.props,
      controller: second.controller,
      committedPopupBinding: second.binding,
    });
    await flush();
    await h.view.rerender(h.props);
    await flush();
    try {
      expect(h.state.binding.current().reason).toBe("stopped");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(h.control()).toHaveAttribute("aria-disabled", "true");
      h.control().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
    } finally {
      read.open();
    }
    await h.reread.mock.results.at(-1)!.value;
    await flush();
    expect(h.control()).toHaveAttribute("aria-disabled", "true");
    expect(h.reread).toHaveBeenCalledTimes(2);
    expect(h.telemetry).not.toHaveBeenCalled();
  });
  it("a newer external ownership hold supersedes the pending read without enabling or rewriting it", async () => {
    const h = await heldHost();
    const entered = gate(),
      read = gate();
    h.get.mockImplementationOnce(async (keys) => {
      const saved = await h.working(keys);
      entered.open();
      await read.promise;
      return saved;
    });
    await fireEvent.click(recovery());
    await entered.promise;
    const prior = h.f.store[key] as StoredSettingsRecord;
    const newer = {
      ...prior,
      atomic: {
        ...prior.atomic!,
        ownership: "previous-account" as const,
        paused: "ownership-unconfirmed",
        scope: {
          ...prior.atomic!.scope,
          generation: prior.atomic!.scope.generation + 1,
        },
        sequence: prior.atomic!.sequence + 1,
      },
    };
    try {
      await h.f.external(newer);
      await flush();
      expect(h.state.binding.current().reason).toBe("ownership-unconfirmed");
    } finally {
      read.open();
    }
    expect(await h.reread.mock.results.at(-1)!.value).toEqual({
      status: "superseded",
    });
    await flush();
    expect(h.state.binding.current().reason).toBe("ownership-unconfirmed");
    expect(h.control()).toHaveAttribute("aria-disabled", "true");
    expect(recovery()).not.toBeDisabled();
    expect(h.f.store[key]).toEqual(newer);
    expect(h.f.set).toHaveBeenCalledTimes(2);
    expect(h.f.sendMessage).toHaveBeenCalledOnce();
    expect(h.telemetry).not.toHaveBeenCalled();
  });
  it("does not call a binding stopped outside the mounted view through a retained retry button", async () => {
    const h = await heldHost();
    const button = recovery();
    h.state.binding.stop();
    await fireEvent.click(button);
    await flush();
    expect(h.reread).toHaveBeenCalledOnce();
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.f.set).toHaveBeenCalledOnce();
    expect(h.telemetry).not.toHaveBeenCalled();
  });
});
