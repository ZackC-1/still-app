import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CONSENT_KEY, privacyPolicyReady, readAnalyticsPermission, type AnalyticsPermission } from "../consent.js";
import {
  DEFAULT_ON_USAGE_POLICY,
  FIREFOX_STOPPED_KEY,
  NOTICE_VERSION_KEY,
  USAGE_DISCLOSURE,
  USAGE_PERMISSION_VERSION,
  createDefaultOnUsage,
  supabaseSubjectIssuer,
  projectKeySha256,
  SUBJECT_RETRY_MS,
  versionedNotice,
  type SubjectIssuingClient,
} from "../default-on.js";
import { NOTICE_KEY } from "../extension-host.js";
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
    expect(USAGE_DISCLOSURE).toContain("Turning sharing off sends nothing more");
    expect(USAGE_DISCLOSURE).toContain("new anonymous identity");
    expect(USAGE_DISCLOSURE).toContain("attaches the account's email on the server");
    expect(USAGE_DISCLOSURE).toContain("deleted with the account");
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
  function firefox(initiallyGranted: boolean, revoke: "removes" | "refuses" | "rejects" = "removes") {
    const browser = { granted: initiallyGranted, revoked: 0 };
    const kv = memory();
    const usage = createDefaultOnUsage({
      store: kv,
      browserPermission: {
        granted: async () => browser.granted,
        revoke: async () => {
          browser.revoked += 1;
          if (revoke === "rejects") throw new Error("Firefox refused");
          if (revoke === "refuses") return false;
          browser.granted = false;
          return true;
        },
      },
    });
    return { browser, kv, usage };
  }

  for (const revoke of ["refuses", "rejects"] as const) {
    it(`Still's off holds when Firefox ${revoke} to withdraw the permission, until the switch turns it on`, async () => {
      const { browser, kv, usage } = firefox(true, revoke);
      const first = (await usage.permission())!;
      await usage.commit(false);
      expect(browser.granted).toBe(true); // Firefox still reports it
      expect(kv.data[FIREFOX_STOPPED_KEY]).toBe(true);
      expect(await usage.permission()).toBeNull();
      expect(await createDefaultOnUsage({ store: kv, browserPermission: { granted: async () => true, revoke: async () => false } }).permission()).toBeNull(); // nor after a restart
      expect(stored(kv)).toMatchObject({ state: "stopped", origin: first.origin });

      await usage.commit(true);
      expect(kv.data[FIREFOX_STOPPED_KEY]).toBeNull();
      expect((await usage.permission())?.state).toBe("granted");
    });
  }

  it("when Firefox does withdraw it, no mark stays: a grant in the add-on manager before any read turns sharing on", async () => {
    const { browser, kv, usage } = firefox(true);
    await usage.permission();
    await usage.commit(false);
    expect(kv.data[FIREFOX_STOPPED_KEY]).toBeNull();
    browser.granted = true; // granted again in the add-on manager, with no read in between
    expect((await usage.permission())?.state).toBe("granted");
  });

  it("the off mark is dropped once Firefox reports the permission withdrawn, so a later grant there turns sharing on", async () => {
    const { browser, kv, usage } = firefox(true, "refuses");
    await usage.permission();
    await usage.commit(false);
    browser.granted = false; // withdrawn in the add-on manager after all
    expect(await usage.permission()).toBeNull();
    expect(kv.data[FIREFOX_STOPPED_KEY]).toBeNull();
    browser.granted = true; // and granted again there
    expect((await usage.permission())?.state).toBe("granted");
  });

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

describe("the one-time notice, versioned by the disclosure", () => {
  it("an earlier acknowledgement (the 2.1 notice) reads as not seen; acknowledging stores this version", async () => {
    const kv = memory({ [NOTICE_KEY]: true }); // a 2.1 device that saw the 2.1 notice
    const local = versionedNotice(kv);
    expect(await local.get(NOTICE_KEY)).toBe(false);
    await local.set(NOTICE_KEY, true);
    expect(kv.data[NOTICE_VERSION_KEY]).toBe(USAGE_PERMISSION_VERSION);
    expect(await local.get(NOTICE_KEY)).toBe(true);
    kv.data[NOTICE_VERSION_KEY] = "d".repeat(64); // a notice for another disclosure
    expect(await local.get(NOTICE_KEY)).toBe(false);
    // Everything else passes through.
    await local.set("still:analytics:state", { a: 1 });
    expect(await local.get("still:analytics:state")).toEqual({ a: 1 });
  });
});

describe("per-device identity requests (supabaseSubjectIssuer)", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROOF = { originProof: "e".repeat(64) };
  const KEY = "phc_synthetic_project_key";
  const KEY_SHA = createHash("sha256").update(KEY).digest("hex");
  function client(session: { access_token: string; user: { id: string } } | null, reply: { data: unknown; error: unknown }) {
    const invoke = vi.fn(async (..._args: unknown[]) => reply);
    const c: SubjectIssuingClient = {
      auth: { getSession: async () => ({ data: { session }, error: null }) },
      functions: { invoke },
    };
    return { c, invoke };
  }

  it("hashes the trimmed project key as lowercase hex SHA-256", async () => {
    expect(await projectKeySha256(`  ${KEY}\n`)).toBe(KEY_SHA);
    expect(KEY_SHA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends only the origin proof and the project key's digest, with that account's own session", async () => {
    const { c, invoke } = client(
      { access_token: "token-a", user: { id: ACCOUNT.toUpperCase() } },
      { data: { state: "active", subject: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, error: null },
    );
    const signal = new AbortController().signal;
    expect(await supabaseSubjectIssuer(c, KEY)({ ...PROOF, extra: "dropped" } as never, signal, ACCOUNT)).toEqual({
      state: "active",
      subject: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(invoke).toHaveBeenCalledWith("analytics-identify", {
      body: { ...PROOF, projectKeySha256: KEY_SHA },
      headers: { Authorization: "Bearer token-a" },
      signal,
    });
  });

  it("refuses a session for another account, or none, without calling the server", async () => {
    for (const session of [null, { access_token: "token-b", user: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } }]) {
      const { c, invoke } = client(session, { data: null, error: null });
      await expect(supabaseSubjectIssuer(c, KEY)(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it("after a 503 or 429 it waits before asking again, instead of asking at every screen", async () => {
    for (const status of [503, 429]) {
      let clock = 1_000;
      const { c, invoke } = client(
        { access_token: "t", user: { id: ACCOUNT } },
        { data: null, error: Object.assign(new Error(String(status)), { context: { status } }) },
      );
      const issue = supabaseSubjectIssuer(c, KEY, () => clock);
      await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
      await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
      expect(invoke).toHaveBeenCalledTimes(1);
      clock += SUBJECT_RETRY_MS;
      await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
      expect(invoke).toHaveBeenCalledTimes(2);
    }
    // Any other failure (a network error) is tried again at the next screen.
    const { c, invoke } = client({ access_token: "t", user: { id: ACCOUNT } }, { data: null, error: new Error("network") });
    const issue = supabaseSubjectIssuer(c, KEY);
    await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
    await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("a refused request (503 while the server switch is off) throws, so the device keeps waiting", async () => {
    const { c } = client({ access_token: "t", user: { id: ACCOUNT } }, { data: null, error: new Error("503") });
    await expect(supabaseSubjectIssuer(c, KEY)(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow("503");
  });

  it("a test_channel answer is treated like unavailable: it throws, never stops, and waits before asking again", async () => {
    let clock = 5_000;
    const { c, invoke } = client({ access_token: "t", user: { id: ACCOUNT } }, { data: { state: "test_channel" }, error: null });
    const issue = supabaseSubjectIssuer(c, KEY, () => clock);
    await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
    await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    clock += SUBJECT_RETRY_MS;
    await expect(issue(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("a build without a project key never asks", async () => {
    for (const key of [undefined, "", "   "]) {
      const { c, invoke } = client({ access_token: "t", user: { id: ACCOUNT } }, { data: null, error: null });
      await expect(supabaseSubjectIssuer(c, key)(PROOF, new AbortController().signal, ACCOUNT)).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    }
  });
});
