import type { FeatureId, SettingsField } from "./feature-registry.js";
import type { ServiceId } from "./rules.js";

/** Bounded unknown supported-version data is retained, never interpreted as access authority. */
export type SettingsJSON =
  | null
  | boolean
  | number
  | string
  | readonly SettingsJSON[]
  | { readonly [key: string]: SettingsJSON };
export type SettingsObject = { readonly [key: string]: SettingsJSON };
export type SettingsFieldStamp = SettingsObject & {
  readonly baseRevision: number;
  readonly localStep: number;
};
export type SettingsV2 = SettingsObject & {
  readonly schemaVersion: 2;
  readonly globalOn: boolean;
  readonly services: SettingsObject & Readonly<Record<ServiceId, boolean>>;
  readonly sites: SettingsObject & Readonly<Record<FeatureId, boolean>>;
  readonly clocks: Readonly<Record<SettingsField, SettingsFieldStamp>> &
    Readonly<Record<string, SettingsFieldStamp>>;
  /** Legacy compatibility/provenance only. Modern field ordering never uses milliseconds. */
  readonly updatedAt: number;
};
export const MAX_SETTINGS_REVISION = 9_007_199_254_740_991;
export const MAX_SETTINGS_LOCAL_STEP = 1_048_575;
