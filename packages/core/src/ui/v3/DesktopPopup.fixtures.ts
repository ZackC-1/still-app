import { vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type AccessState,
  type BenefitAccessSnapshot,
  type ServiceId,
  type FeatureId,
} from "@still/shared-types";
import {
  AtomicSettingsWriter,
  requireModernSettings,
} from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import {
  ACCESS_BENEFITS,
  initialAccessSnapshot,
} from "../../entitlement/access-policy.js";
import type { DesktopPopupProps } from "./presentation.js";

export async function fixture(state: AccessState = "free") {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  await writer.initialize("never-linked");
  const cache = new SettingsCache({
    get: storage.get.bind(storage),
    set: storage.set.bind(storage),
    subscribe: storage.subscribe.bind(storage),
    commitIntent: writer.commit.bind(writer),
  });
  await cache.hydrate();
  const access = initialAccessSnapshot({
    paidMode: false,
    supported: new Set(ACCESS_BENEFITS),
  });
  const states = { ...access.states };
  for (const row of FEATURE_REGISTRY)
    if (row.tier === "pro") states[row.id] = state;
  const props: DesktopPopupProps = {
    settings: requireModernSettings(cache.currentRecord()),
    access: { ...access, states } satisfies BenefitAccessSnapshot,
    browser: "Chrome",
    privacyUrl: "https://still.test/privacy",
    onGlobalChange: vi.fn(),
    onServiceChange: vi.fn(),
    onFeatureChange: vi.fn(),
    onSignIn: vi.fn(),
    onSettings: vi.fn(),
  };
  return { storage, writer, cache, props };
}

export function bindWriter(cache: SettingsCache, props: DesktopPopupProps) {
  let pending: Promise<unknown> = Promise.resolve();
  props.onFeatureChange = vi.fn((id: FeatureId, next: boolean) => {
    pending = cache.setFeature(id, next);
  });
  props.onServiceChange = vi.fn((id: ServiceId, next: boolean) => {
    pending = cache.setService(id, next);
  });
  props.onGlobalChange = vi.fn((next: boolean) => {
    pending = cache.setGlobalOn(next);
  });
  return () => pending;
}
