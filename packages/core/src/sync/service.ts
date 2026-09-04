import type { StillSettings } from "@still/shared-types";
import { PAID_TIER_ENABLED } from "@still/shared-types";
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
//   - First sign-in merges rather than overwrites: whichever side changed more recently wins, with
//     the account winning every tie. See mirrorAndStartWriteThrough and localSettingsAreNewer.
//   - Across identities the account wins: when the signing-in user differs from the last user this
//     device synced for, sign-in never pushes the local settings up (no seed, no LWW push-up),
//     because they may belong to the previous account on this machine (AE5).
//   - Steady state: the cloud is the source of truth, local edits write through, and conflicts
//     resolve by server version and then by last-write-wins.

/**
 * Persists the last userId a settings sync ran for, so `onSignedIn` can tell a same-user
 * re-sign-in (seed-from-local allowed) from an identity switch (cloud wins). Storage-backed in
 * real wiring, in-memory in tests. Optional: without it the service behaves exactly as before —
 * existing hosts keep today's same-user seed semantics.
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

  constructor(
    private readonly cache: SettingsCache,
    private readonly auth: AuthPort,
    private readonly backend: BackendPort,
    private readonly onState?: (state: SyncState) => void,
    private readonly identity?: LastSyncedIdentityStore,
    /** Injectable clock, used only to judge whether a stored local timestamp is believable during
     * the first-sign-in merge below. Date.now in real wiring, a counter in tests. */
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
      this.resume(userId, false);
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
   * and `onEntitlementConfirmed`. Two product rules meet here.
   *
   * The merge rule, for an account that already has settings: the side that changed more recently
   * wins, and the account wins every tie (see `localSettingsAreNewer`). The user is not asked,
   * because there is nothing useful to ask. Both sides are the same handful of toggles, and a
   * dialog at the exact moment someone first signs in is the wall this product does not have.
   *
   * The shared-machine rule (R8/AE5), for the upload half: when a DIFFERENT identity was last
   * synced on this device, the local settings may be that person's, so they are never pushed up
   * (no empty-account seed, no push-up over the new account). A device that has never recorded an
   * identity is treated as this user's own, which is what makes a first-ever sign-in carry the
   * settings someone has been using into their new account instead of silently replacing them
   * with an empty account's defaults.
   *
   * The identity is recorded only once a sync actually starts, so a sign-in that never got that
   * far cannot claim this device's settings for that account.
   */
  private async mirrorAndStartWriteThrough(userId: string): Promise<void> {
    const lastSynced = this.identity === undefined ? null : await this.identity.get();
    const otherIdentity = lastSynced !== null && lastSynced !== userId;
    const cloud = await this.backend.readProfile();
    if (cloud) {
      const localBefore = this.cache.current();
      if (!otherIdentity && this.localSettingsAreNewer(localBefore, cloud)) {
        // This device changed more recently, so publish it rather than adopt the account's older
        // settings. The write returns the new envelope, which is how the cache learns the server
        // version every later edit has to build on.
        await this.writeAndApply(localBefore);
      } else {
        const applied = this.cache.applySyncedEnvelope(cloud);
        if (!applied && !otherIdentity && !sameSettings(localBefore, cloud.settings)) {
          await this.writeAndApply(this.cache.current());
        }
      }
    } else if (!otherIdentity) {
      await this.writeAndApply(this.cache.current()); // an empty account starts from this device
    }
    this.startWriteThrough();
    this.startRealtime(userId);
    await this.identity?.set(userId);
  }

  /**
   * Whether the local settings are the more recently changed side of a first sign-in.
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
   * edits look newer and win. The cost is bounded, since the account then adopts that device's
   * toggles and any device can change them back, and preferring the account everywhere the skew
   * IS detectable is the safe half of an ambiguity that has no clean answer.
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
   * Restart write-through from CACHED state after a background wake (plan U5): an MV3 worker that
   * wakes on a settings edit must not drop paid sync (the write-through subscription is in-memory
   * and died with the worker) and must not burn a live RevenueCat query per wake — so no network
   * here. Mirror-down and seeding stay sign-in concerns (`onSignedIn`); resume trusts the caller's
   * cached entitlement and only restarts (entitled) or stops (cached false) the write-through.
   */
  resume(userId: string, entitled: boolean): void {
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
      return;
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
