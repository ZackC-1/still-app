import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import type { SettingsCache, SettingsChangeSource } from "../storage/cache.js";
import type { SyncedSettingsEnvelope } from "../storage/adapter.js";
import type { AuthPort, BackendPort, EntitlementRead } from "./ports.js";

// Coordinates auth + entitlement + settings sync (R6/R7/R8). The hard rules:
//   - Having an account is the only thing settings sync requires. While the paid tier is dormant
//     behind PAID_TIER_ENABLED the entitlement decides nothing here; turn that switch on and the
//     old gate returns in one place, `settingsSyncAllowed` at the foot of this file.
//   - Sync never waits on the entitlement round trip. Reconciling is a live purchase-service query
//     on the server, so the cloud mirror starts first and the reconcile runs beside it. The
//     reconcile itself stays: it is what makes a returning purchaser's entitlement reappear
//     without anyone contacting support (U13/U14), and reconcile-before-read is still its order.
//   - A signed-out user stays entirely local; the cache never touches the network.
//   - Reconciling a device with its account is one decision made in one place, `decideReconcile`,
//     and honoured whichever way it goes. The guarantee it makes: this device publishes its
//     settings only when they are the newest thing that exists, otherwise it adopts the account's,
//     and where the account has nothing saved and what is here belongs to somebody else it starts
//     the account from Still's defaults instead. No path downstream re-publishes what that
//     decision rejected.
//   - Steady state: the cloud is the source of truth, local edits write through, and conflicts
//     resolve by server version and then by last-write-wins.

/**
 * Persists the last userId a settings sync ran for, so `onSignedIn` can tell a same-user
 * re-sign-in (seed-from-local allowed) from an identity switch (cloud wins). Storage-backed in
 * real wiring, in-memory in tests. There is deliberately no way to erase it: the shared-browser
 * rule exists for the moment after someone signs out, so the record has to outlast them.
 *
 * Optional only so a host can be wired up without it. A host that omits it gives up the direct
 * half of the shared-browser rule, because the identity test in `decideReconcile` can never fire.
 * What still protects such a host is the version metadata: settings anchored to a profile row are
 * not published into an account that has no row. Everything else falls through to the clock or the
 * version counter.
 */
export interface LastSyncedIdentityStore {
  /** The last userId a sync started for, or null when none was ever recorded. */
  get(): Promise<string | null>;
  set(userId: string): Promise<void>;
}

export interface SyncState {
  readonly userId: string | null;
  readonly entitled: boolean;
  readonly syncing: boolean;
  /** False after a cloud write fails (offline/error); the UI shows the cached-settings note (U9). */
  readonly cloudReachable: boolean;
  /**
   * True only once `entitled` reflects a settled server answer for this session (reconcile + read
   * completed, an already-reconciled confirmation, or a deliberate sign-out). `onSignedIn` first
   * emits a PROVISIONAL state (previous/cold `entitled` with `cloudReachable: true`) before the
   * reconcile round-trip — hosts that stamp entitlement into native stores (the App-Group record
   * the Safari extension trusts for 30 days) must gate on this, not on `cloudReachable`, or a cold
   * resume can overwrite a valid cached Pro record with `false` before the server answers.
   */
  readonly confirmed: boolean;
}

const SIGNED_OUT: SyncState = {
  userId: null,
  entitled: false,
  syncing: false,
  cloudReachable: true,
  confirmed: true, // a deliberate sign-out is definitive — hosts may clear native stamps on it
};

/**
 * Which side of a reconcile won, or that it gave up because the session ended under it.
 *
 * "freshStart" is the third answer: neither side had a claim, so the account was started from
 * Still's own defaults. See `startAccountFromDefaults`.
 */
type ReconcileOutcome = "device" | "account" | "freshStart" | "abandoned";

/** The three answers the decision itself can give; abandoning is decided around it, not by it. */
type ReconcileVerdict = Exclude<ReconcileOutcome, "abandoned">;

export class SyncService {
  private state: SyncState = SIGNED_OUT;
  private unsubCache: (() => void) | null = null;
  private unsubRealtime: (() => void) | null = null;
  private realtimeStale = false;
  // Write coalescing: at most one in-flight writeProfile; a newer edit during a write replaces the
  // single pending value (latest-wins, matching updatedAt-LWW) and flushes when the in-flight settles.
  private writing = false;
  private pendingWrite: StillSettings | null = null;
  private retryLatestOnReconnect = false;
  // The start-up catch-up read, and the one edit held behind it. Publishing during that read would
  // overwrite whatever it is about to bring down, so the edit waits for the reconcile to decide.
  private catchingUp: Promise<ReconcileOutcome> | null = null;
  private heldWrite: StillSettings | null = null;

  constructor(
    private readonly cache: SettingsCache,
    private readonly auth: AuthPort,
    private readonly backend: BackendPort,
    private readonly onState?: (state: SyncState) => void,
    private readonly identity?: LastSyncedIdentityStore,
    /** Injectable clock. It judges whether a stored local timestamp is believable during the
     * first-sign-in merge below, and stamps the defaults a brand new account is started from.
     * Date.now in real wiring, a counter in tests. */
    private readonly now: () => number = Date.now,
  ) {}

  getState(): SyncState {
    return this.state;
  }

  signIn(email: string): Promise<{ error?: string }> {
    return this.auth.signInWithMagicLink(email);
  }

  /**
   * Run after a session is established (code verified, app launch, or restore).
   *
   * The order of the two halves differs by tier, and that is the point. While the paid tier is
   * dormant, settings sync is the one thing signing in buys, so the cloud mirror starts
   * immediately and the entitlement reconcile runs alongside it: a slow or failing purchase
   * service must never delay or abort sync. With the paid tier switched back on the entitlement
   * decides again, so it settles first and an account without it never mirrors.
   */
  async onSignedIn(userId: string): Promise<void> {
    const previousEntitled = this.state.userId === userId ? this.state.entitled : false;
    this.stopWriteThrough();
    this.stopRealtime();
    // PROVISIONAL: entitled is a carry-over guess until the reconcile below settles — confirmed
    // stays false so no host mirrors it into a native stamp yet.
    this.setState({
      userId,
      entitled: previousEntitled,
      syncing: false,
      cloudReachable: true,
      confirmed: false,
    });

    if (PAID_TIER_ENABLED) {
      const entitled = await this.reconcileAndReadEntitlement();
      // A sign-out that landed while the purchase service was answering makes this answer about a
      // session that no longer exists. Both writes below would put it back over the signed-out
      // state, and a confirmed entitlement is what the Apple host stamps into the App Group.
      if (this.state.userId !== userId) return;
      if (entitled === null) {
        this.setState({ ...this.state, cloudReachable: false });
        return;
      }
      this.setState({ ...this.state, entitled, cloudReachable: true, confirmed: true });
      if (!entitled) return; // un-entitled signed-in user does NOT sync (R7 gating)
      await this.mirrorAndStartWriteThrough(userId);
      return;
    }

    // Both halves start now and neither waits for the other. A rejected mirror is the only thing
    // that means "the cloud is out of reach": the entitlement half decides nothing a user can see
    // here, so its failure must not tell them their settings have stopped syncing.
    const mirrored = this.mirrorAndStartWriteThrough(userId).catch(() => {
      this.setState({ ...this.state, cloudReachable: false });
    });
    const settled = this.reconcileAndReadEntitlement().then((entitled) => {
      // An entitlement that could not be checked leaves the previous value in place and leaves
      // `confirmed` false, which is what stops a host writing an unknown answer into the native
      // record the Safari extension trusts for 30 days.
      if (entitled === null) return;
      // And a sign-out that landed while this was in flight has already published the signed-out
      // state, so this answer is about a session that no longer exists. Writing it would leave a
      // signed-out state carrying a CONFIRMED entitlement, which is exactly what the Apple host
      // stamps into the App Group for the Safari extension to trust.
      if (this.state.userId !== userId) return;
      this.setState({ ...this.state, entitled, confirmed: true });
    });
    await mirrored;
    await settled;
  }

  /**
   * Reconcile the entitlement with the server and then read it, returning the settled answer or
   * null when it could not be checked. Reconcile BEFORE read is the self-heal order (U13/U14): a
   * dropped purchase webhook repairs itself on the next sign-in with nobody involved.
   *
   * Never throws. Sync no longer depends on this answer, so a purchase service that is slow, down,
   * or unreachable must not be able to take the caller down with it.
   */
  private async reconcileAndReadEntitlement(): Promise<boolean | null> {
    try {
      await this.backend.reconcileEntitlement();
      const read = await this.backend.readEntitlement();
      return read === "unknown" ? null : entitlementToBool(read);
    } catch {
      return null;
    }
  }

  /**
   * Entitlement just confirmed for a signed-in user by an ALREADY-COMPLETED reconcile (the
   * extension web-checkout / restore / popup-open path drives this after runReconcile) — so unlike
   * `onSignedIn` this does NOT reconcile again (no second RevenueCat query). A not-entitled →
   * entitled transition (e.g. a web purchase after signing in free) runs the initial cloud mirror
   * that `resume()` alone skips, so the buyer's settings sync immediately instead of waiting for
   * their next edit. When already syncing for this same user it just re-arms write-through
   * (cheap, no network); a false answer stops sync only while the paid tier gates it.
   */
  async onEntitlementConfirmed(userId: string, entitled: boolean): Promise<void> {
    if (!settingsSyncAllowed(entitled)) {
      await this.resume(userId, false);
      this.setState({ ...this.state, confirmed: true }); // the caller's reconcile settled it
      return;
    }
    // A live write-through subscription is the proof that sync is already running for this user,
    // and it is a stronger test than the entitlement: with the paid tier dormant a user syncs
    // whether or not they own anything, so reading `entitled` here would re-mirror on every
    // reconcile.
    const alreadySyncing = this.state.userId === userId && this.unsubCache !== null;
    this.setState({
      userId,
      entitled,
      syncing: this.state.syncing,
      cloudReachable: this.state.cloudReachable,
      confirmed: true,
    });
    if (alreadySyncing) {
      this.startWriteThrough(); // steady state: no redundant mirror-down (matches resume semantics)
      this.startRealtime(userId);
      return;
    }
    try {
      await this.mirrorAndStartWriteThrough(userId);
    } catch {
      this.setState({ ...this.state, cloudReachable: false });
    }
  }

  /**
   * The initial cloud mirror plus write-through for a newly signed-in user, shared by `onSignedIn`
   * and `onEntitlementConfirmed`.
   *
   * A reconcile that gave up because the session ended arms nothing. Signing out while a sign-in is
   * still in flight would otherwise leave a realtime subscription open for a signed-out user, after
   * the sign-out's own teardown has already run, so nothing would ever close it and the next person
   * to sign in would get no subscription at all.
   */
  private async mirrorAndStartWriteThrough(userId: string): Promise<void> {
    if ((await this.reconcileWithAccount(userId)) === "abandoned") return;
    this.startWriteThrough();
    this.startRealtime(userId);
  }

  /**
   * Reconcile this device with its account: decide ONCE which side is the newer, then act on that
   * one decision and nothing else. Both moments where the two can be out of step come through
   * here, the mirror a sign-in runs and the catch-up a background start runs, so there is one
   * answer rather than one per entry point. The answer is returned so that nothing downstream has
   * to guess which way it went.
   */
  private async reconcileWithAccount(userId: string): Promise<ReconcileOutcome> {
    // Never judge a device by a cache that has not finished loading. Until hydration lands,
    // `current()` is the bundled defaults and the sync metadata is null, so the device would read
    // as brand new and could publish defaults over settings someone has been using.
    await this.cache.whenHydrated();
    const lastSynced = this.identity === undefined ? null : await this.identity.get();
    const cloud = await this.backend.readProfile();
    // A sign-out or an account switch during any await here makes the answer below about a session
    // that no longer exists, and acting on it would move one account's settings under another. The
    // test is repeated after the identity write for that reason.
    if (this.state.userId !== userId) return "abandoned";
    // Reaching the account is the moment this browser could start carrying settings between two
    // accounts, so that is when it records whose settings it holds, before anything is published
    // or adopted. Recording it afterwards left a gap: a write that failed, or a worker that died
    // mid-reconcile, left a browser that HAD synced still claiming nobody had ever synced on it,
    // and the shared-browser rule cannot fire on a browser like that.
    await this.identity?.set(userId);
    if (this.state.userId !== userId) return "abandoned";
    const verdict = this.decideReconcile(cloud, lastSynced, userId);
    if (verdict === "device") {
      // The write returns the new envelope, which is how the cache learns the server version that
      // every later edit has to build on.
      await this.writeAndApply(this.cache.current());
      return "device";
    }
    if (verdict === "freshStart") {
      await this.startAccountFromDefaults();
      return "freshStart";
    }
    // The account is the newer side. Nothing goes up on this path, by any route. The null check
    // below is for the compiler alone: an account with nothing saved cannot reach here, because
    // the decision sends every empty account down one of the two branches above it.
    if (cloud !== null) {
      if (lastSynced === userId && this.cache.currentSyncMetadata() !== null) {
        // The two counters count the same profile row, so the steady-state rule is the right one:
        // it is what stops a realtime message that arrived while this read was in flight being
        // overwritten by the older snapshot the read is holding.
        this.cache.applySyncedEnvelope(cloud);
      } else {
        // The counters are not comparable at all: on a shared browser the version on this device
        // belongs to the previous person's profile row, and on a device that has never synced
        // there is no counter to compare. The account is taken whole, and every other context in
        // the browser is told the row changed.
        this.cache.adoptSyncedEnvelope(cloud);
      }
    }
    return "account";
  }

  /**
   * Which side of a reconcile is the newer one, and what to do when neither side is.
   *
   * An account with NOTHING saved is decided first, because it has no settings to adopt and no
   * version to compare, so neither of the rules below can speak to it. The whole question there is
   * whether the settings sitting on this device are this person's own. Two things say they are
   * not, and either is enough. Somebody else was the last to sync on this browser: that record
   * outlives them signing out, which is the only reason it can protect the next person. Or this
   * cache is still anchored to a profile row, since an account that has no row cannot be the
   * account that row belongs to; that one is what still holds on the NEXT browser start, once the
   * identity has been updated to the person now signed in. Either way the account is started from
   * Still's defaults rather than from settings the account's owner never chose.
   *
   * A device that last synced for somebody ELSE never publishes (R8/AE5). The local settings may
   * be that person's, and the record of who last synced here survives sign-out for exactly this
   * reason: on a shared browser the protection has to outlast the first person leaving.
   *
   * A device that has never synced with any account has no ordering to appeal to, so this is the
   * one place a clock decides: the side that changed more recently wins, and an account with
   * nothing saved is filled from this device. That is the first-sign-in rule, and
   * `localSettingsAreNewer` gives the account every tie and every stamp it cannot believe.
   *
   * A device that HAS synced before is compared by the account's own version counter instead,
   * which is one monotonic sequence rather than two unrelated clocks. It may publish only when the
   * account is exactly where this device left it, meaning nothing has been written from anywhere
   * else since; anything different here is then an edit made while signed out or offline, and it
   * is the newest thing that exists. The moment the account has moved on, the account wins. That
   * is what stops a device whose clock runs a few minutes fast republishing its own snapshot over
   * every other device, every single time it starts.
   */
  private decideReconcile(
    cloud: SyncedSettingsEnvelope | null,
    lastSynced: string | null,
    userId: string,
  ): ReconcileVerdict {
    const anotherPersonSyncedHere = lastSynced !== null && lastSynced !== userId;
    const metadata = this.cache.currentSyncMetadata();
    if (cloud === null) {
      if (anotherPersonSyncedHere || metadata !== null) return "freshStart";
      return "device";
    }
    if (anotherPersonSyncedHere) return "account";
    if (metadata === null) {
      return this.localSettingsAreNewer(this.cache.current(), cloud) ? "device" : "account";
    }
    if (cloud.version !== metadata.version) return "account";
    return sameSettings(this.cache.current(), cloud.settings) ? "account" : "device";
  }

  /**
   * Start an account that has nothing saved from Still's own defaults, and repoint this browser at
   * the row that creates.
   *
   * This is the shared computer where the second person signs up for a brand new account. The
   * account has never held anything, and the settings sitting in this browser were last reconciled
   * against a different account, so they are not this person's to publish. Sending them up would
   * put one person's choices into another person's account and from there onto every device that
   * account owns, because a settings write replaces the whole document. Leaving them alone is not
   * enough either: the new person would be looking at the previous person's toggles, and this
   * browser would still be counting the previous account's version, so nothing the new person
   * changes on any other device could ever land here. The defaults are the one settings set that
   * belongs to nobody but Still, and they have every blocking feature switched on, so starting
   * from them can only ever protect someone more, never less.
   *
   * The write goes first and the device adopts only what comes back, so a write that fails leaves
   * the browser exactly as it was and the next start tries again. Adopting is also what carries
   * the reset to every other context in this browser, the popup included.
   */
  private async startAccountFromDefaults(): Promise<void> {
    const fresh: StillSettings = { ...DEFAULT_SETTINGS, updatedAt: this.now() };
    const envelope = await this.backend.writeProfile(fresh, randomWriteId());
    this.cache.adoptSyncedEnvelope(envelope);
  }

  /**
   * Whether the local settings are the more recently changed side of a FIRST sign-in.
   *
   * Reached only from `decideReconcile`, and only on a device that has never synced. That scoping is
   * load-bearing rather than incidental: a clock comparison is the only tool available before this
   * device and the account share a version counter, and it is the wrong tool afterwards.
   *
   * The two timestamps come from different clocks. `settings.updatedAt` was stamped by whichever
   * device made the edit; `serverUpdatedAt` was stamped by the database. Nothing here can align
   * them, so the comparison is deliberately conservative and the account wins wherever the local
   * stamp is not believable on its own terms:
   *
   *   - an unreadable server stamp,
   *   - a local stamp that is not a finite number,
   *   - a local stamp this device's own clock places in the future, which means the stored value
   *     is corrupt or was written under a clock that has since been corrected,
   *   - an exact tie.
   *
   * The caveat worth knowing: a device whose clock is simply set well ahead cannot be caught from
   * the client, because every timestamp it produces, including "now", is consistently wrong. Its
   * edits look newer and win this comparison. What makes that survivable is that it can only
   * happen once per device: from the device's next start onward the account's version counter
   * decides, so a correction made on any other device sticks instead of being undone on every
   * launch.
   */
  private localSettingsAreNewer(local: StillSettings, cloud: SyncedSettingsEnvelope): boolean {
    const serverMs = Date.parse(cloud.serverUpdatedAt);
    if (!Number.isFinite(serverMs)) return false;
    const localMs = local.updatedAt;
    if (!Number.isFinite(localMs)) return false;
    if (localMs > this.now()) return false;
    return localMs > serverMs;
  }

  /**
   * Restart write-through after a background wake (plan U5), and pull the account down once.
   *
   * The entitlement half is unchanged and deliberately offline: an MV3 worker that wakes on a
   * settings edit must not drop paid sync (the write-through subscription is in-memory and died
   * with the worker) and must not burn a live purchase-service query per wake, so resume trusts
   * the caller's cached answer and never reconciles. Nothing below asks RevenueCat anything.
   *
   * The settings half has to make a network call, and it is a settings read rather than a purchase
   * query. This process starts from whatever was on disk when the last one died, and the realtime
   * subscription only ever delivers writes made while it is connected, so a browser that was
   * closed while another device changed something would never learn about it, and its first local
   * edit would publish the stale snapshot over the newer one. The catch-up closes that. It is on no
   * blocking path, and outgoing writes are held until it settles so that the reconcile, not the
   * accident of when someone clicked, decides which side is published.
   *
   * Everything that arms the session happens synchronously before the returned promise, so a
   * caller that does not await still gets write-through restarted immediately.
   */
  resume(userId: string, entitled: boolean): Promise<void> {
    // Resume trusts the caller's CACHED entitlement (no network) — never confirmed.
    if (!settingsSyncAllowed(entitled)) {
      this.stopWriteThrough();
      this.stopRealtime();
      this.setState({
        userId,
        entitled: false,
        syncing: false,
        cloudReachable: this.state.cloudReachable,
        confirmed: false,
      });
      return Promise.resolve();
    }
    // `entitled` stays the truthful record of what this account owns even where it no longer gates
    // anything, because a returning purchaser is still told their purchase is recognised.
    this.setState({
      userId,
      entitled,
      syncing: false,
      cloudReachable: this.state.cloudReachable,
      confirmed: false,
    });
    this.startWriteThrough();
    this.startRealtime(userId);
    return this.catchUpWithAccount(userId);
  }

  /**
   * The start-up settings read. It goes through the same reconcile a sign-in uses, so a device that
   * has been away adopts what happened while it was away and can still publish an edit it made
   * offline. Never rejects: being offline at start-up is ordinary, and the device simply stays on
   * its cached settings until the realtime reconnect refresh retries.
   */
  private catchUpWithAccount(userId: string): Promise<void> {
    const settled = this.reconcileWithAccount(userId).catch((): ReconcileOutcome => {
      this.realtimeStale = true; // the existing reconnect refresh is the retry
      return "abandoned";
    });
    this.catchingUp = settled;
    return settled.then((outcome) => {
      if (this.catchingUp !== settled) return; // superseded by a later session entry
      this.catchingUp = null;
      const held = this.heldWrite;
      this.heldWrite = null;
      if (held === null) return;
      // The one decision has to hold here too. When the account was the newer side, this edit was
      // made on top of what the device held BEFORE the account's settings arrived, so publishing
      // it would put that pre-download state back over everything just adopted, and the profile
      // write is a full overwrite: the other device's change would be gone everywhere. The edit is
      // dropped instead, which is exactly what happens to the same edit made a moment earlier,
      // before write-through arms.
      if (outcome !== "device") return;
      if (this.state.userId !== userId || !this.canSync) return;
      // Skip when the reconcile already published this exact edit, which is what happens when it
      // decided this device was the newer side after the edit had landed in the cache.
      if (sameSettings(held, this.cache.current())) return;
      this.enqueueWrite(held);
    });
  }

  async signOut(): Promise<void> {
    this.stopWriteThrough();
    this.stopRealtime();
    await this.auth.signOut();
    this.setState(SIGNED_OUT);
  }

  /**
   * Delete the signed-in user's account (App Store 5.1.1 / GDPR), then sign out locally. The delete
   * runs first: if it fails, the error propagates and the session is left intact (the UI surfaces it),
   * so we never appear signed-out while the account still exists.
   */
  async deleteAccount(): Promise<void> {
    // The delete is the critical step: if it fails, propagate so the UI surfaces it and the session
    // stays intact (we never appear signed-out while the account still exists).
    await this.backend.deleteAccount();
    // Account is gone server-side. Local sign-out is now best-effort — force SIGNED_OUT regardless, so
    // a failing auth.signOut() can't strand the UI signed-in against a deleted account.
    this.stopWriteThrough();
    this.stopRealtime();
    try {
      await this.auth.signOut();
    } catch {
      /* ignore: the account no longer exists; the signed-out state is forced below */
    }
    this.setState(SIGNED_OUT);
  }

  /** After this, every local settings edit is mirrored to the cloud (coalesced) while sync runs. */
  private startWriteThrough(): void {
    this.setState({ ...this.state, syncing: true });
    this.unsubCache ??= this.cache.subscribe((settings: StillSettings, source: SettingsChangeSource) => {
      if (source === "synced") return;
      if (this.canSync && this.state.userId) this.enqueueWrite(settings);
    });
  }

  /** The one client-side sync gate, read wherever a write is about to leave the device. */
  private get canSync(): boolean {
    return settingsSyncAllowed(this.state.entitled);
  }

  /**
   * Coalesce cloud writes: at most one in-flight; edits during a write keep only the latest as
   * pending (LWW). A rejected write flips `cloudReachable` false and drops the pending value — the
   * SettingsCache still holds the latest, so the next edit / sign-in reconcile re-pushes it (no
   * permanent loss). A later success flips `cloudReachable` back to true.
   */
  private enqueueWrite(settings: StillSettings): void {
    if (this.catchingUp !== null) {
      this.heldWrite = settings;
      return;
    }
    if (this.writing) {
      this.pendingWrite = settings;
      return;
    }
    this.writing = true;
    void this.flushWrite(settings);
  }

  private async flushWrite(settings: StillSettings): Promise<void> {
    try {
      await this.writeAndApply(settings);
      if (!this.state.cloudReachable) this.setState({ ...this.state, cloudReachable: true });
      this.retryLatestOnReconnect = false;
    } catch {
      this.pendingWrite = null;
      this.retryLatestOnReconnect = true;
      if (this.state.cloudReachable) this.setState({ ...this.state, cloudReachable: false });
    } finally {
      const next = this.pendingWrite;
      this.pendingWrite = null;
      if (next && this.canSync && this.state.userId) {
        void this.flushWrite(next);
      } else {
        this.writing = false;
      }
    }
  }

  private stopWriteThrough(): void {
    this.unsubCache?.();
    this.unsubCache = null;
    this.writing = false;
    this.pendingWrite = null;
    this.retryLatestOnReconnect = false;
    this.catchingUp = null;
    this.heldWrite = null;
  }

  private startRealtime(userId: string): void {
    if (this.unsubRealtime !== null) return;
    this.realtimeStale = false;
    this.unsubRealtime = this.backend.subscribeToProfile(
      userId,
      (envelope) => this.applyRemoteEnvelope(envelope),
      (status) => {
        if (status === "disconnected" || status === "error") {
          this.realtimeStale = true;
          return;
        }
        if (status === "subscribed" && this.realtimeStale) {
          this.realtimeStale = false;
          void this.refreshAfterRealtimeReconnect();
        }
      },
    );
  }

  private stopRealtime(): void {
    this.unsubRealtime?.();
    this.unsubRealtime = null;
    this.realtimeStale = false;
  }

  private async refreshAfterRealtimeReconnect(): Promise<void> {
    if (!this.canSync || !this.state.userId) return;
    try {
      const envelope = await this.backend.readProfile();
      if (envelope) this.applyRemoteEnvelope(envelope);
      if (this.retryLatestOnReconnect) this.enqueueWrite(this.cache.current());
      if (!this.state.cloudReachable) this.setState({ ...this.state, cloudReachable: true });
    } catch {
      if (this.state.cloudReachable) this.setState({ ...this.state, cloudReachable: false });
    }
  }

  private applyRemoteEnvelope(envelope: SyncedSettingsEnvelope): void {
    this.cache.applySyncedEnvelope(envelope);
  }

  private async writeAndApply(settings: StillSettings): Promise<void> {
    const envelope = await this.backend.writeProfile(settings, randomWriteId());
    this.cache.applySyncedEnvelope(envelope);
  }

  private setState(next: SyncState): void {
    this.state = next;
    this.onState?.(next);
  }
}

/**
 * Whether an account may sync its settings. This is the whole client-side sync gate, in one place.
 *
 * Having an account is the only requirement while the paid tier is dormant behind
 * PAID_TIER_ENABLED, and the server agrees: the settings write path stopped asking for an
 * entitlement in migration 0012. Turning the switch back on restores the gate here, and that
 * migration carries the matching server change as its recorded reverse.
 */
function settingsSyncAllowed(entitled: boolean): boolean {
  return !PAID_TIER_ENABLED || entitled;
}

function entitlementToBool(read: Exclude<EntitlementRead, "unknown">): boolean {
  return read === "entitled";
}

function randomWriteId(): string {
  return globalThis.crypto?.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function sameSettings(a: StillSettings, b: StillSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
