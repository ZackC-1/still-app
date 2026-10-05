import { mount } from "svelte";
import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";
import SafariV3Options from "./SafariV3Options.svelte";

// The V3 settings-page components and their global stylesheet. Loaded by ./v3 only after the
// record gate has chosen V3.
export function mountSafariV3Options(target: HTMLElement, composition: SafariV3Composition): void {
  mount(SafariV3Options, {
    target,
    props: { composition },
  });
}
