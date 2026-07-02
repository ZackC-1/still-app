import type { StillSettings } from "@still/shared-types";
import type { SettingsCache } from "../storage/cache.js";
import type { AuthPort, BackendPort, EntitlementRead } from "./ports.js";

// Coordinates auth + entitlement + settings sync (R6/R7/R8). The hard rules:
//   - On EVERY sign-in (all hosts, incl. desktop): reconcile entitlement BEFORE reading it, so a
//     dropped webhook self-heals without Apple involvement (U14).
//   - Sync is gated on entitlement: only an entitled, signed-in user mirrors settings to the cloud.
//     A free / signed-out user stays entirely local (the cache never touches the network).
//   - Cloud is source of truth when entitled; local edits write through; conflicts resolve by LWW.
//   - Across identities, cloud wins: when the signing-in user differs from the last user we synced
//     for, sign-in never pushes the local blob to the cloud (no seed, no LWW push-up) — the local
//     settings may belong to the previous account on this browser (AE5).

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
}

const SIGNED_OUT: SyncState = { userId: null, entitled: false, syncing: false, cloudReachable: true };

export class SyncService {
  private state: SyncState = SIGNED_OUT;
  private unsubCache: (() => void) | null = null;
  // Write coalescing: at most one in-flight writeProfile; a newer edit during a write replaces the
  // single pending value (latest-wins, matching updatedAt-LWW) and flushes when the in-flight settles.
  private writing = false;
  private pendingWrite: StillSettings | null = null;

  constructor(
    private readonly cache: SettingsCache,
    private readonly auth: AuthPort,
    private readonly backend: BackendPort,
    private readonly onState?: (state: SyncState) => void,
    private readonly identity?: LastSyncedIdentityStore,
  ) {}

  getState(): SyncState {
    return this.state;
  }

  signIn(email: string): Promise<{ error?: string }> {
    return this.auth.signInWithMagicLink(email);
  }

  /**
   * Run after a session is established (magic-link redirect, app launch, or restore). Reconciles
   * the entitlement first, then reads it, then mirrors the cloud profile and starts write-through
   * — but only when entitled.
   */
  async onSignedIn(userId: string): Promise<void> {
    const previousEntitled = this.state.userId === userId ? this.state.entitled : false;
    this.stopWriteThrough();
    this.setState({ userId, entitled: previousEntitled, syncing: false, cloudReachable: true });

    // Reconcile BEFORE reading — the desktop self-heal path the bridge targets (U13/U14).
    try {
      await this.backend.reconcileEntitlement();
    } catch {
      this.setState({ ...this.state, cloudReachable: false });
      return;
    }
    const entitlement = await this.backend.readEntitlement();
    if (entitlement === "unknown") {
      this.setState({ ...this.state, cloudReachable: false });
      return;
    }

    const entitled = entitlementToBool(entitlement);
    this.setState({ ...this.state, entitled, cloudReachable: true });
    if (!entitled) return; // un-entitled signed-in user does NOT sync (R7 gating)

    // Identity-switch guard (R8/AE5): when this sign-in is for a different user than the last one
    // we synced for — or no prior identity was ever recorded, so the seam can't vouch that the
    // local blob is theirs — never push local settings to the cloud during sign-in (no empty-cloud
    // seed, no LWW push-up). Cloud wins; a fresh account starts from local defaults only after an
    // explicit reset. Without the seam (existing hosts) behavior is unchanged.
    const crossIdentity = this.identity !== undefined && (await this.identity.get()) !== userId;

    const cloud = await this.backend.readProfile();
    if (cloud) {
      // LWW: a newer cloud wins (cloud is source of truth); a newer local is pushed up to converge.
      const applied = this.cache.applyRemote(cloud);
      if (!applied && !crossIdentity) await this.backend.writeProfile(this.cache.current());
    } else if (!crossIdentity) {
      await this.backend.writeProfile(this.cache.current()); // seed an empty cloud from local
    }
    this.startWriteThrough();
    // Recorded only when a sync actually starts: a free user's sign-in must NOT claim the local
    // blob for their identity, or their later Pro sign-in would seed the cloud from settings that
    // may still belong to the previous account.
    await this.identity?.set(userId);
  }

  /**
   * Restart write-through from CACHED state after a background wake (plan U5): an MV3 worker that
   * wakes on a settings edit must not drop paid sync (the write-through subscription is in-memory
   * and died with the worker) and must not burn a live RevenueCat query per wake — so no network
   * here. Mirror-down and seeding stay sign-in concerns (`onSignedIn`); resume trusts the caller's
   * cached entitlement and only restarts (entitled) or stops (cached false) the write-through.
   */
  resume(userId: string, entitled: boolean): void {
    if (!entitled) {
      this.stopWriteThrough();
      this.setState({ userId, entitled: false, syncing: false, cloudReachable: this.state.cloudReachable });
      return;
    }
    this.setState({ userId, entitled: true, syncing: false, cloudReachable: this.state.cloudReachable });
    this.startWriteThrough();
  }

  async signOut(): Promise<void> {
    this.stopWriteThrough();
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
    try {
      await this.auth.signOut();
    } catch {
      /* ignore: the account no longer exists; the signed-out state is forced below */
    }
    this.setState(SIGNED_OUT);
  }

  /** After this, every local settings edit is mirrored to the cloud (coalesced) while entitled. */
  private startWriteThrough(): void {
    this.setState({ ...this.state, syncing: true });
    this.unsubCache ??= this.cache.subscribe((settings: StillSettings) => {
      if (this.state.entitled && this.state.userId) this.enqueueWrite(settings);
    });
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
      await this.backend.writeProfile(settings);
      if (!this.state.cloudReachable) this.setState({ ...this.state, cloudReachable: true });
    } catch {
      this.pendingWrite = null;
      if (this.state.cloudReachable) this.setState({ ...this.state, cloudReachable: false });
    } finally {
      const next = this.pendingWrite;
      this.pendingWrite = null;
      if (next && this.state.entitled && this.state.userId) {
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
  }

  private setState(next: SyncState): void {
    this.state = next;
    this.onState?.(next);
  }
}

function entitlementToBool(read: Exclude<EntitlementRead, "unknown">): boolean {
  return read === "entitled";
}
