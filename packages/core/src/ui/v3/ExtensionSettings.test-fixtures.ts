import { vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type AccessState,
  type FeatureId,
  type ServiceId,
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
import type { ExtensionSettingsProps } from "./extension-settings-presentation.js";

async function fixture(state: AccessState = "purchased") {
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
  let pending: Promise<unknown> = Promise.resolve();
  const props: ExtensionSettingsProps & {
    pro: NonNullable<ExtensionSettingsProps["pro"]>;
    sharing: NonNullable<ExtensionSettingsProps["sharing"]>;
  } = {
    settings: requireModernSettings(cache.currentRecord()),
    access: { ...access, states },
    onGlobalChange: vi.fn((next: boolean) => {
      pending = cache.setGlobalOn(next);
    }),
    onServiceChange: vi.fn((id: ServiceId, next: boolean) => {
      pending = cache.setService(id, next);
    }),
    onFeatureChange: vi.fn((id: FeatureId, next: boolean) => {
      pending = cache.setFeature(id, next);
    }),
    sync: { onSignIn: vi.fn() },
    pro: { ownership: "none", channel: "unverified" },
    sharing: {
      state: "off",
      onChange: vi.fn(),
      purposesVerified: true,
      purposes: [
        {
          name: "Fixture email plus usage",
          text: "Fixture purpose disclosure.",
        },
      ],
    },
    help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
  };
  return { storage, cache, props, settled: () => pending };
}

const retainedConfirmationPorts = vi.hoisted(() => [] as (() => void)[]);
vi.mock("./ConfirmationDialog.svelte", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./ConfirmationDialog.svelte")>();
  // Keep the real Svelte dialog and capture exactly the callback passed to it.
  const invoke = original.default as unknown as (
    anchor: unknown,
    props: Record<string, unknown>,
  ) => unknown;
  return {
    default: (anchor: unknown, props: Record<string, unknown>) =>
      invoke(
        anchor,
        new Proxy(props, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (key === "onConfirm" && typeof value === "function")
              retainedConfirmationPorts.push(value as () => void);
            return value;
          },
        }),
      ),
  };
});

export { fixture, retainedConfirmationPorts };
