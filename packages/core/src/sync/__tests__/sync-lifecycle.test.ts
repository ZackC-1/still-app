import { expect, it } from "vitest";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { A, B, drain, harness, row } from "./support/sync-lifecycle-harness.js";

it("control: settled A write does not travel into B", async () => {
  expect(PAID_TIER_ENABLED).toBe(false);
  const h = harness();
  await h.cache.hydrate();
  await h.signIn(A);
  await h.cache.setGlobalOn(false);
  await drain();
  await h.sync.signOut();
  await h.signIn(B);
  expect(h.cache.current().globalOn).toBe(true);
  await h.cache.setService("instagram", false);
  await drain();
  expect(h.writes.at(-1)).toMatchObject({
    owner: B,
    settings: { globalOn: true },
  });
});

it("a delayed A response cannot replace B settings or enter B next upload", async () => {
  const h = harness();
  await h.cache.hydrate();
  h.cache.watch();
  const peer = new SettingsCache(h.store);
  await peer.hydrate();
  peer.watch();
  expect(
    (await h.session.verifyCode("alice@example.invalid", "synthetic")).kind,
  ).toBe("verified");
  const late = h.holdWrite();
  await h.cache.setGlobalOn(false);
  await drain();
  expect(await h.session.signOut()).toBe("signed-out");
  expect((await h.session.getState()).userId).toBeNull();
  expect(
    (await h.session.verifyCode("bob@example.invalid", "synthetic")).kind,
  ).toBe("verified");
  expect((await h.session.getState()).userId).toBe(B);
  expect(h.cache.current().globalOn).toBe(true);
  const before = h.cache.currentRecord();
  late.resolve();
  await drain();
  expect(h.cache.currentRecord()).toEqual(before);
  expect(peer.currentRecord()).toEqual(before);
  await h.cache.setService("instagram", false);
  await drain();
  expect(h.writes.at(-1)).toMatchObject({
    owner: B,
    settings: { globalOn: true },
  });
  expect((await h.session.getState()).userId).toBe(B);
});

it.each([
  { outcome: "success", route: "B", expectedGlobalOn: true },
  { outcome: "rejection", route: "B", expectedGlobalOn: true },
  { outcome: "success", route: "same A", expectedGlobalOn: false },
  { outcome: "rejection", route: "same A", expectedGlobalOn: false },
  { outcome: "success", route: "A to B to A", expectedGlobalOn: false },
  { outcome: "rejection", route: "A to B to A", expectedGlobalOn: false },
])(
  "obsolete $outcome cannot drain queued writes after returning to $route",
  async ({ outcome, route, expectedGlobalOn }) => {
    const h = harness();
    await h.cache.hydrate();
    await h.signIn(A);
    const obsolete = h.holdWrite();
    await h.cache.setGlobalOn(false);
    await obsolete.started;
    await h.sync.signOut();
    if (route === "A to B to A") {
      await h.signIn(B);
      await h.sync.signOut();
    }
    const active = route === "B" ? B : A;
    await h.signIn(active);
    const current = h.holdWrite();
    await h.cache.setService("instagram", false);
    await current.started;
    await h.cache.setService("facebook", false);
    const requestsBefore = h.writes.length;
    if (outcome === "success") obsolete.resolve();
    else obsolete.reject();
    await drain();
    expect(h.sync.getState().cloudReachable).toBe(true);
    expect(h.writes).toHaveLength(requestsBefore);
    // Another edit must also wait for B's in-flight response, not an obsolete finally block.
    await h.cache.setService("tiktok", false);
    await drain();
    expect(h.writes).toHaveLength(requestsBefore);
    current.resolve();
    await drain();
    expect(h.writes).toHaveLength(requestsBefore + 1);
    expect(h.writes.at(-1)).toMatchObject({
      owner: active,
      settings: {
        globalOn: expectedGlobalOn,
        services: { instagram: false, facebook: false, tiktok: false },
      },
    });
  },
);

it.each(["success", "rejection"])(
  "a previous lifecycle's reconnect read %s cannot change B",
  async (outcome) => {
    const h = harness();
    await h.cache.hydrate();
    await h.signIn(A);
    h.rows.set(
      A,
      row(
        { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 300 },
        10,
        "a-peer",
      ),
    );
    const oldChannel = h.channels[0]!;
    oldChannel.status("CHANNEL_ERROR");
    const late = h.holdRead();
    oldChannel.status("SUBSCRIBED");
    await late.started;
    await h.sync.signOut();
    await h.signIn(B);
    const before = h.cache.currentRecord();
    if (outcome === "success") late.resolve();
    else late.reject();
    await drain();
    expect(h.cache.currentRecord()).toEqual(before);
    expect(h.sync.getState()).toMatchObject({
      userId: B,
      syncing: true,
      cloudReachable: true,
    });
    await h.cache.setService("instagram", false);
    await drain();
    expect(h.writes.at(-1)).toMatchObject({
      owner: B,
      settings: { globalOn: true },
    });
  },
);

it("an unsubscribed realtime callback cannot publish or reconnect for a later account", async () => {
  const h = harness();
  await h.cache.hydrate();
  await h.signIn(A);
  const old = h.channels[0]!;
  await h.sync.signOut();
  await h.signIn(B);
  expect(old.closed).toBe(true);
  old.emit(
    row(
      { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 300 },
      10,
      "a-late-event",
    ),
  );
  expect(h.cache.current().globalOn).toBe(true);
  const readsBefore = h.reads.length;
  old.status("CHANNEL_ERROR");
  old.status("SUBSCRIBED");
  await drain();
  expect(h.reads).toHaveLength(readsBefore);
  h.channels[1]!.emit(
    row({ ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 400 }, 2, "b-peer"),
  );
  expect(h.cache.current().globalOn).toBe(false);
});

it.each(["same account", "A to B to A"])(
  "a fresh-account write cannot overwrite a later %s session",
  async (route) => {
    const h = harness();
    await h.cache.hydrate();
    await h.signIn(B);
    await h.sync.signOut();
    h.rows.delete(A);
    const late = h.holdWrite();
    const first = h.signIn(A);
    await late.started;
    await h.sync.signOut();
    if (route === "A to B to A") {
      await h.signIn(B);
      await h.sync.signOut();
    }
    // Another device changed A after the first request committed; the new session adopts it.
    h.rows.set(
      A,
      row(
        { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 400 },
        2,
        "a-new-device",
      ),
    );
    await h.signIn(A);
    expect(h.cache.current().globalOn).toBe(false);
    late.resolve();
    await first;
    expect(h.cache.current().globalOn).toBe(false);
    expect(h.cache.currentSyncMetadata()?.version).toBe(2);
    await h.cache.setService("instagram", false);
    await drain();
    expect(h.writes.at(-1)).toMatchObject({
      owner: A,
      settings: { globalOn: false },
    });
  },
);

it("a seed response after sign-out cannot reopen a realtime subscription", async () => {
  const h = harness();
  await h.cache.hydrate();
  h.rows.delete(A);
  const late = h.holdWrite();
  const signingIn = h.signIn(A);
  await late.started;
  await h.sync.signOut();
  late.resolve();
  await signingIn;
  expect(h.sync.getState()).toMatchObject({ userId: null, syncing: false });
  expect(h.channels).toHaveLength(0);
});

it("a rejected sign-in read cannot mark a later same-account session offline", async () => {
  const h = harness();
  await h.cache.hydrate();
  const late = h.holdRead();
  const signingIn = h.signIn(A);
  await late.started;
  await h.sync.signOut();
  await h.signIn(A);
  late.reject();
  await signingIn;
  expect(h.sync.getState()).toMatchObject({
    userId: A,
    syncing: true,
    cloudReachable: true,
  });
});

it("an old empty-account read cannot seed a later same-account session", async () => {
  const h = harness();
  await h.cache.hydrate();
  h.rows.delete(A);
  const late = h.holdRead();
  const first = h.signIn(A);
  await late.started;
  await h.sync.signOut();
  h.rows.set(
    A,
    row(
      { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 400 },
      2,
      "a-new-device",
    ),
  );
  await h.signIn(A);
  late.resolve();
  await first;
  expect(h.writes).toHaveLength(0);
  expect(h.cache.current()).toMatchObject({ globalOn: false });
});

it.each(["resume", "confirm"] as const)(
  "%s replaces the previous account's active lifecycle",
  async (entry) => {
    const h = harness();
    await h.cache.hydrate();
    await h.signIn(A);
    const late = h.holdWrite();
    await h.cache.setGlobalOn(false);
    await late.started;
    await h[entry](B);
    expect(h.cache.current().globalOn).toBe(true);
    late.resolve();
    await drain();
    expect(h.cache.current().globalOn).toBe(true);
    expect(h.channels[0]?.closed).toBe(true);
    await h.cache.setService("instagram", false);
    await drain();
    expect(h.writes.at(-1)).toMatchObject({
      owner: B,
      settings: { globalOn: true },
    });
  },
);

it.each([
  { teardown: "signOut", outcome: "success" },
  { teardown: "signOut", outcome: "rejection" },
  { teardown: "deleteAccount", outcome: "success" },
  { teardown: "deleteAccount", outcome: "rejection" },
] as const)(
  "$teardown discards a pending write's late $outcome",
  async ({ teardown, outcome }) => {
    const h = harness();
    await h.cache.hydrate();
    await h.signIn(A);
    const late = h.holdWrite();
    await h.cache.setGlobalOn(false);
    await late.started;
    await h.session[teardown]();
    const signedOut = h.sync.getState();
    await h.cache.setGlobalOn(true);
    const record = h.cache.currentRecord();
    if (outcome === "success") late.resolve();
    else late.reject();
    await drain();
    expect(h.sync.getState()).toEqual(signedOut);
    expect(h.cache.currentRecord()).toEqual(record);
    expect(h.writes).toHaveLength(1);
  },
);

it("a rejected old resume cannot schedule a reconnect read in B's session", async () => {
  const h = harness();
  await h.cache.hydrate();
  const late = h.holdRead();
  const oldResume = h.resume(A);
  await late.started;
  await h.sync.signOut();
  await h.signIn(B);
  late.reject();
  await oldResume;
  const readsBefore = h.reads.length;
  h.channels.at(-1)!.status("SUBSCRIBED");
  await drain();
  expect(h.reads).toHaveLength(readsBefore);
});

it("a delayed entitlement answer cannot replace a later same-account confirmation", async () => {
  const h = harness();
  await h.cache.hydrate();
  h.setEntitled(true);
  const late = h.holdEntitlement();
  const first = h.signIn(A);
  await late.started;
  await h.sync.signOut();
  h.setEntitled(false);
  await h.signIn(A);
  late.resolve();
  await first;
  expect(h.sync.getState()).toMatchObject({
    userId: A,
    entitled: false,
    confirmed: true,
    syncing: true,
  });
});

it.each(["signOut", "deleteAccount", "deleteAccount sign-out"] as const)(
  "a delayed %s completion cannot stop a later session",
  async (operation) => {
    const h = harness();
    await h.cache.hydrate();
    await h.signIn(A);
    const late =
      operation === "deleteAccount" ? h.holdDelete() : h.holdSignOut();
    const leaving =
      operation === "signOut" ? h.sync.signOut() : h.sync.deleteAccount();
    await late.started;
    await h.signIn(B);
    late.resolve();
    await leaving;
    expect(h.sync.getState()).toMatchObject({
      userId: B,
      syncing: true,
      cloudReachable: true,
    });
    await h.cache.setService("instagram", false);
    await drain();
    expect(h.writes.at(-1)).toMatchObject({
      owner: B,
      settings: { globalOn: true },
    });
  },
);
