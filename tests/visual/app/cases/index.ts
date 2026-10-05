import type { ScreenCases } from "../types.js";
import { D01 } from "./d01.js";
import { D02 } from "./d02.js";
import { D03 } from "./d03.js";
import { D04 } from "./d04.js";
import { D12 } from "./d12.js";
import { D14 } from "./d14.js";
import { D18 } from "./d18.js";
import { D28 } from "./d28.js";
import { GALLERY } from "./gallery.js";

export const SCREENS: ScreenCases[] = [
  D01,
  D02,
  D03,
  D04,
  D12,
  D14,
  D18,
  D28,
  GALLERY,
];

/** Reference pages this harness does not cover, with the reason (reported, never silently dropped). */
export const OUT_OF_SCOPE: Record<string, string> = {
  "d41-d43-d45-store-assets-and-icons":
    "store images and icons are static exports, not V1 Svelte screens",
};
