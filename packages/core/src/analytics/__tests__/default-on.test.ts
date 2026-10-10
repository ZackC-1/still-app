import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CONSENT_KEY, privacyPolicyReady, readAnalyticsPermission, type AnalyticsPermission } from "../consent.js";
import {
  DEFAULT_ON_USAGE_POLICY,
  USAGE_DISCLOSURE,
  USAGE_PERMISSION_VERSION,
  createDefaultOnUsage,
} from "../default-on.js";
import type { AnalyticsKeyValue } from "../identity.js";
import { TEST_PRIVACY_POLICY } from "./privacy-fixture.js";

// A V3 build: the default-on basis is compiled in (build-basis.ts reads the build flags).
vi.mock("../build-basis.js", () => ({ USAGE_ON_BY_DEFAULT_BUILD: true }));

function memory(initial: Record<string, unknown> = {}): AnalyticsKeyValue & {
  data: Record<string, unknown>;
  writes: number;
} {
  const kv = {
    data: { ...initial },
    writes: 0,
    get: async (k: string) => structuredClone(kv.data[k]) ?? null,
    set: async (k: string, v: unknown) => {
      kv.writes += 1;
      kv.data[k] = structuredClone(v);
    },
  };
  return kv;
}

const stored = (kv: { data: Record<string, unknown> }) => readAnalyticsPermission(kv.data[CONSENT_KEY]);

describe("the default-on usage basis (ADR 0004)", () => {
  it("versions the permission by the digest of what it discloses", () => {
    expect(createHash("sha256").update(USAGE_DISCLOSURE).digest("hex")).toBe(USAGE_PERMISSION_VERSION);
    expect(USAGE_DISCLOSURE).toContain("on by default");
    expect(USAGE_DISCLOSURE).toContain("technicalAndInteraction");
    expect(USAGE_DISCLOSURE).toContain("Never used for advertising");
  });

  it("is ready in a V3 build without capability evidence, and only in an ordinary context with a valid version", () => {
    expect(privacyPolicyReady(DEFAULT_ON_USAGE_POLICY)).toBe(true);
    expect(privacyPolicyReady({ ...DEFAULT_ON_USAGE_POLICY, context: "private" })).toBe(false);
    expect(privacyPolicyReady({ ...DEFAULT_ON_USAGE_POLICY, context: "unknown" })).toBe(false);
    expect(privacyPolicyReady({ ...DEFAULT_ON_USAGE_POLICY, permissionVersion: "v1" })).toBe(false);
    // The capability-evidence gate is unchanged for every other policy.
    expect(privacyPolicyReady({ ...DEFAULT_ON_USAGE_POLICY, basis: undefined })).toBe(false);
    expect(privacyPolicyReady(TEST_PRIVACY_POLICY)).toBe(true);
    expect(privacyPolicyReady(undefined)).toBe(false);
  });
});

describe("default-on usage permission (Chrome and the Apple app)", () => {
  it("grants on the first read when no choice is recorded, once, however many reads race", async () => {
    const kv = memory();
    const usage = createDefaultOnUsage({ store: kv });
    const reads = await Promise.all([usage.permission(), usage.permission(), usage.consent()]);
    const [a, b, on] = reads as [AnalyticsPermission, AnalyticsPermission, boolean];
    expect(a).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION, generation: 1 });
    expect(b).toEqual(a);
    expect(on).toBe(true);
    expect(stored(kv)).toEqual(a);
    expect(kv.writes).toBe(1);
    expect(await usage.permission()).toEqual(a); // stable afterwards: same origin, same ids
  });

  it("keeps a 2.1 choice: the 2.1 default on stays on, a 2.1 off stays off", async () => {
    const on = memory({ [CONSENT_KEY]: true });
    expect(await createDefaultOnUsage({ store: on }).permission()).toMatchObject({ state: "granted" });

    const off = memory({ [CONSENT_KEY]: false });
    expect(await createDefaultOnUsage({ store: off }).permission()).toBeNull();
    expect(await createDefaultOnUsage({ store: off }).consent()).toBe(false);
    expect(off.writes).toBe(0);
  });

  it("off stops and is never re-granted by a read; on starts again under a new origin", async () => {
    const kv = memory();
    const usage = createDefaultOnUsage({ store: kv });
    const first = (await usage.permission())!;
    await usage.commit(false);
    expect(stored(kv)).toMatchObject({ state: "stopped", origin: first.origin, generation: 2 });
    expect(await usage.permission()).toBeNull();
    expect(await createDefaultOnUsage({ store: kv }).permission()).toBeNull(); // nor after a restart

    await usage.commit(true);
    const again = (await usage.permission())!;
    expect(again).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION, generation: 3 });
    expect(again.origin).not.toBe(first.origin);
    expect(again.provider.anonymousId).not.toBe(first.provider.anonymousId);
    expect(again.provider.deviceId).not.toBe(first.provider.deviceId);
  });

  it("an off asked while a default grant is on its way wins", async () => {
    const kv = memory();
    const usage = createDefaultOnUsage({ store: kv });
    const read = usage.permission();
    const off = usage.commit(false);
    await Promise.all([read, off]);
    expect(stored(kv)?.state).toBe("stopped");
    expect(await usage.permission()).toBeNull();
  });

  it("holds without writing when storage cannot be read, or holds something it does not recognise", async () => {
    const failing: AnalyticsKeyValue = {
      get: async () => {
        throw new Error("unreadable");
      },
      set: vi.fn(async () => {}),
    };
    expect(await createDefaultOnUsage({ store: failing }).permission()).toBeNull();
    expect(failing.set).not.toHaveBeenCalled();

    const odd = memory({ [CONSENT_KEY]: { state: "granted" } });
    expect(await createDefaultOnUsage({ store: odd }).permission()).toBeNull();
    expect(odd.writes).toBe(0);
  });

  it("re-grants a permission that was on under an earlier disclosure", async () => {
    const kv = memory();
    await createDefaultOnUsage({ store: kv }).permission();
    const earlier = { ...stored(kv)!, version: "c".repeat(64) };
    kv.data[CONSENT_KEY] = earlier;
    const next = (await createDefaultOnUsage({ store: kv }).permission())!;
    expect(next.version).toBe(USAGE_PERMISSION_VERSION);
    expect(next.origin).not.toBe(earlier.origin);
  });
});

describe("default-on usage permission (Firefox: the optional technicalAndInteraction permission)", () => {
  function firefox(initiallyGranted: boolean) {
    const browser = { granted: initiallyGranted, revoked: 0 };
    const kv = memory();
    const usage = createDefaultOnUsage({
      store: kv,
      browserPermission: {
        granted: async () => browser.granted,
        revoke: async () => {
          browser.revoked += 1;
          browser.granted = false;
          return true;
        },
      },
    });
    return { browser, kv, usage };
  }

  it("is off, and writes nothing, while the permission was not granted at install", async () => {
    const { kv, usage } = firefox(false);
    expect(await usage.permission()).toBeNull();
    expect(await usage.consent()).toBe(false);
    expect(kv.writes).toBe(0);
  });

  it("is on from install when Firefox's install prompt granted it", async () => {
    const { usage } = firefox(true);
    expect(await usage.permission()).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION });
  });

  it("withdrawing it in the add-on manager stops sharing at the next read", async () => {
    const { browser, kv, usage } = firefox(true);
    const first = (await usage.permission())!;
    browser.granted = false;
    expect(await usage.permission()).toBeNull();
    expect(stored(kv)).toMatchObject({ state: "stopped", origin: first.origin });
  });

  it("the switch: on takes effect only if the prompt was accepted; off stops and withdraws", async () => {
    const { browser, kv, usage } = firefox(false);
    await usage.commit(true); // the page's request was declined
    expect(await usage.permission()).toBeNull();
    expect(kv.writes).toBe(0);

    browser.granted = true; // accepted in the page, inside the tap
    await usage.commit(true);
    const on = (await usage.permission())!;
    expect(on.state).toBe("granted");

    await usage.commit(false);
    expect(browser.revoked).toBe(1);
    expect(stored(kv)?.state).toBe("stopped");
    expect(await usage.permission()).toBeNull();

    browser.granted = true; // granted again, from the add-on manager
    const again = (await usage.permission())!;
    expect(again.state).toBe("granted");
    expect(again.origin).not.toBe(on.origin);
  });
});
