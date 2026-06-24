import type { ServiceId } from "./rules.js";

// Single settings set per account (KTD6, spec §5): one global on/off, four per-service master
// toggles, and a list of per-site pauses. No scope/profile split. Last-write-wins by `updatedAt`.

/** Per-site pause key: the eTLD+1 of the host, e.g. "youtube.com". */
export type PauseHost = string;

export interface StillSettings {
  /** Master kill switch. When false, Still applies nothing anywhere. */
  readonly globalOn: boolean;
  /** Per-service master toggles. A service absent here is treated as its default (off for brand-new). */
  readonly services: Readonly<Record<ServiceId, boolean>>;
  /** eTLD+1 hosts the user has paused. A paused host short-circuits all application there. */
  readonly pauses: readonly PauseHost[];
  /** Epoch milliseconds of the last write; the LWW conflict key. */
  readonly updatedAt: number;
}

/** The default settings for a fresh install: all four services on, global on, nothing paused. */
export const DEFAULT_SETTINGS: StillSettings = {
  globalOn: true,
  services: { youtube: true, instagram: true, tiktok: true, facebook: true },
  pauses: [],
  updatedAt: 0,
};
