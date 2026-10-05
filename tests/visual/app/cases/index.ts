import type { ScreenCases } from "../types.js";
import { D01 } from "./d01.js";

export const SCREENS: ScreenCases[] = [D01];

/** Reference pages this harness does not cover, with the reason (reported, never silently dropped). */
export const OUT_OF_SCOPE: Record<string, string> = {};
