import { FEATURE_REGISTRY } from "@still/shared-types";
import { DESKTOP_LAYOUT_ONLY_PRO } from "../../entitlement/access-policy.js";

/**
 * The Still Pro offer's one-line answer to "what works on a phone?" (owner decision, 9 October
 * 2026): iPhone/iPad Safari and Firefox for Android hide the desktop-layout-only extras, so a
 * buyer on any surface is told which ones. Counts and names come from the feature registry and
 * DESKTOP_LAYOUT_ONLY_PRO, never a hard-coded list, so the copy follows the capability matrix.
 *
 * `onPhone` is true only where the surface itself draws the phone-layout inventory; every other
 * surface gets the general sentence, which is true wherever it is read.
 */
export function proPhoneNote(onPhone: boolean): string {
  const pro = FEATURE_REGISTRY.filter((row) => row.tier === "pro");
  const desktopOnly = pro.filter((row) =>
    (DESKTOP_LAYOUT_ONLY_PRO as readonly string[]).includes(row.id),
  );
  if (!desktopOnly.length) return "";
  const phoneCount = pro.length - desktopOnly.length;
  // Registry names are sentence-case labels ("Live chat"); in running prose they read lower-case.
  const names = desktopOnly.map(
    (row) => row.name.charAt(0).toLowerCase() + row.name.slice(1),
  );
  const last = names.pop() ?? "";
  const list = names.length ? `${names.join(", ")} and ${last}` : last;
  const where = onPhone
    ? "On this device"
    : "On iPhone, iPad and Firefox for Android";
  return `${where}, ${phoneCount} of the ${pro.length} extras work. ${list.charAt(0).toUpperCase()}${list.slice(1)} ${desktopOnly.length === 1 ? "needs" : "need"} a computer.`;
}
