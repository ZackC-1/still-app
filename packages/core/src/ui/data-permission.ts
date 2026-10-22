// Firefox's optional data-collection permissions, as the Chrome/Firefox host hands them to the UI.
//
// Firefox lists the data an add-on sends in its manifest (`data_collection_permissions`). Still
// marks the sign-in email address and purchase data as optional, so installing Still never asks for
// them. Firefox asks the person instead, from their own click, the first time Still would send one
// of them (Sign in's Send code; Get Still Pro, which starts a checkout). Receiving the account's
// Still Pro status sends no purchase data and never needs a grant. Free blocking, local settings and
// the free controls never touch any of this.
//
// Only the Firefox build supplies a DataPermission (ext-chromium lib/data-permission.ts). Chrome,
// Safari and the Apple apps supply none, so nothing here asks or checks anything there.
//
// Its own module, beside email-consent.ts and for the same reason: the extension packages need the
// type and the copy in node-environment tests, where the rune-based controller cannot be loaded.

/** What is about to leave the device: the sign-in email address, or purchase data (a checkout). */
export type DataPermissionKind = "email" | "purchase";

export interface DataPermission {
  /**
   * Ask Firefox for the permission. Call it synchronously as the first thing a click handler does,
   * before any `await`: Firefox only shows its prompt from inside the handling of a user action,
   * and a handler that has waited on a promise is no longer one. Resolves true when granted
   * (without a prompt when it already is), false when declined or when Firefox refused to ask.
   */
  ask(kind: DataPermissionKind): Promise<boolean>;
  /** Whether it is granted right now. Never prompts; safe anywhere. Checked before every send. */
  granted(kind: DataPermissionKind): Promise<boolean>;
}

/**
 * The lines shown where the person clicked when the permission is declined or was withdrawn.
 * Minimal on purpose (owner rule): what is needed and, for sign-in, that nothing is lost.
 */
export const DATA_PERMISSION_COPY = Object.freeze({
  email: "Sign in needs permission to send your email address. Your settings stay on this device.",
  purchase: "Still Pro needs permission to check your purchase.",
} satisfies Record<DataPermissionKind, string>);
