import type { SignInPurpose } from "./controller.svelte.js";

/** A saved code entry, ready for `UiController.rehydrateCodeEntry`. */
export interface RestoredCodeEntry {
  readonly email: string;
  readonly requestedAt?: number;
  readonly purchaseIntent?: boolean;
  readonly purpose?: SignInPurpose;
}

const PURPOSES: readonly SignInPurpose[] = ["sync", "purchase", "restore", "link"];

/**
 * The Apple app's saved pending code entry (the JSON its AuthPersistence writes), read back on
 * relaunch so the sheet returns to code entry with the words it opened with (ISS-0123). Null when
 * nothing usable was saved: the person then starts from the email field.
 */
export function restoredCodeEntry(raw: string | null, purchaseIntent: boolean): RestoredCodeEntry | null {
  if (raw === null) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const { email, requestedAt, purpose } = saved as Record<string, unknown>;
  if (typeof email !== "string") return null;
  return {
    email,
    ...(typeof requestedAt === "number" ? { requestedAt } : {}),
    purchaseIntent,
    ...(PURPOSES.includes(purpose as SignInPurpose) ? { purpose: purpose as SignInPurpose } : {}),
  };
}
