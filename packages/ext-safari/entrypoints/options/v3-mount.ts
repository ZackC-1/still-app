import { mount, unmount } from "svelte";
import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";
import type { FeatureId } from "@still/shared-types";
import SafariV3Options from "./SafariV3Options.svelte";
import { bindTextScale } from "@still/core/ui/v3/text-scale";
import { createSafariAppHandoff, type SafariAppRoute } from "../../lib/app-handoff.js";
import { NATIVE_APP } from "../../lib/native-settings.js";

// The V3 settings-page components and their global stylesheet. Loaded by ./v3 only after the
// record gate has chosen V3.
export function mountSafariV3Options(target: HTMLElement, composition: SafariV3Composition, features?: readonly FeatureId[], phone = false): () => void {
  // Text size follows the system Text Size on iPhone and iPad (owner decision 51); a Mac stays at
  // the normal size. Removed again if mounting fails, before the legacy page starts.
  const unbindTextScale = bindTextScale(document, "apple");
  // Get Still Pro and the lock chips open the Still app (lib/app-handoff, ISS-0032), as in the
  // Safari popup. Every row drawn (no `features`) means Safari confirmed a Mac (./v3), so the app's
  // native handler opens it; otherwise the fixed still:// link opens in a Safari tab, which works on
  // every Apple device. This settings tab stays open either way.
  const handoff = createSafariAppHandoff(features === undefined ? "desktop" : "mobile", {
    sendNative: (message) => browser.runtime.sendNativeMessage(NATIVE_APP, message),
    openTab: (url) => browser.tabs.create({ url }),
    close: () => {},
  });
  try {
    const instance = mount(SafariV3Options, {
      target,
      props: { composition, features, phone, openApp: (route: SafariAppRoute) => handoff(route) },
    });
    return () => {
      void unmount(instance);
      unbindTextScale();
    };
  } catch (error) {
    unbindTextScale();
    throw error;
  }
}
