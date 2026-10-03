import type {
  SettingsV2,
  SignedRuleSetV2,
  StillSettings,
} from "@still/shared-types";
import {
  createEnginePageSession,
  type EngineOptions,
} from "../rules/engine.js";

/** Internal host input, never a page-owned runtime message or a saved setting. */
export interface TiktokTabContext {
  readonly tabId: number;
  readonly frameId: number;
  readonly target: string;
}

export interface TiktokTabSessionStore {
  get(tabId: number): Promise<unknown>;
  set(tabId: number, value: true): Promise<void>;
  remove(tabId: number): Promise<void>;
  /** Session-only unfinished intent; unknown values hold, absence means completed/empty. */
  getPending(tabId: number): Promise<unknown>;
  setPending(tabId: number): Promise<void>;
  removePending(tabId: number): Promise<void>;
}

export interface TiktokTabAuthorityDeps {
  readonly ruleSet: SignedRuleSetV2;
  readonly store: TiktokTabSessionStore;
  readonly isLivingTab: (tabId: number) => Promise<boolean>;
  /** Existing committed settings/access authority; null or failed reads hold the action. */
  readonly readCommitted: () => Promise<{
    readonly settings: StillSettings | SettingsV2;
    readonly options: EngineOptions;
  } | null>;
  /** Trusted host confirmation only. Current shipping builds supply no producer. */
  readonly confirm?: (context: Readonly<TiktokTabContext>) => Promise<boolean>;
}

/**
 * One background owner, using the existing compiled effective predicate. Session storage must
 * remain extension-only. The owner stores tab IDs/booleans, never destinations or saved choices.
 * Await stop before constructing a replacement owner in the same running worker.
 */
export function createTiktokTabAuthority(deps: TiktokTabAuthorityDeps) {
  const engine = createEnginePageSession(deps.ruleSet);
  const flights = new Map<number, Promise<boolean>>();
  const closed = new Set<number>();
  const unfinished = new Set<number>();
  let stopped = false;

  const live = (context: TiktokTabContext) =>
    !stopped &&
    !closed.has(context.tabId) &&
    Number.isSafeInteger(context.tabId) &&
    context.tabId >= 0 &&
    context.frameId === 0;

  async function eligible(context: TiktokTabContext): Promise<boolean> {
    if (
      !live(context) ||
      !(await deps.isLivingTab(context.tabId)) ||
      !live(context)
    )
      return false;
    let target: URL;
    try {
      target = new URL(context.target);
    } catch {
      return false;
    }
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      return false;
    const snapshot = await deps.readCommitted();
    if (!snapshot || !live(context)) return false;
    const decision = engine.evaluate(
      snapshot.settings,
      target,
      snapshot.options,
    );
    return (
      engine.activeServiceId() === "tiktok" &&
      decision.kind === "placeholder" &&
      decision.blocked === true
    );
  }

  function serial(
    tabId: number,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    const previous = flights.get(tabId) ?? Promise.resolve(false);
    const next = previous.then(operation, operation).catch(() => false);
    flights.set(tabId, next);
    void next.then(() => {
      if (flights.get(tabId) === next) flights.delete(tabId);
    });
    return next;
  }

  // Snapshot primitives before the first await; caller mutation cannot change an admitted action.
  const snapshot = (context: TiktokTabContext): TiktokTabContext =>
    Object.freeze({
      tabId: context.tabId,
      frameId: context.frameId,
      target: context.target,
    });

  async function completed(tabId: number): Promise<boolean> {
    return !unfinished.has(tabId) && (await deps.store.getPending(tabId)) === undefined &&
      (await deps.store.get(tabId)) === true && (await deps.store.getPending(tabId)) === undefined;
  }

  async function cleanup(tabId: number, finalizing = false): Promise<boolean> {
    unfinished.add(tabId);
    if (finalizing) {
      // Each cleanup action remains independent: failed intent restoration must not skip
      // removal of the grant. If both fail after actual finalization, reopen is uncertain.
      try { await deps.store.setPending(tabId); } catch { /* Still attempt grant removal. */ }
    }
    try {
      await deps.store.remove(tabId);
      if ((await deps.store.get(tabId)) !== undefined) return false;
      // Never clear the unfinished fence while a provisional grant might remain.
      await deps.store.removePending(tabId);
      if ((await deps.store.getPending(tabId)) !== undefined) return false;
      unfinished.delete(tabId);
      return true;
    } catch { return false; }
  }

  return {
    async allow(
      input: TiktokTabContext,
      confirm = deps.confirm,
      /** Per-operation trusted host proof, transient and never a request body or stored ID. */
      verify: () => Promise<boolean> = async () => true,
    ): Promise<boolean> {
      const context = snapshot(input);
      if (!live(context)) return false;
      return serial(context.tabId, async () => {
        let wrote = false;
        let finalizing = false;
        try {
          if (!(await eligible(context))) return false;
          // A prior genuinely confirmed grant is already valid, including after worker reopen.
          const pending = await deps.store.getPending(context.tabId);
          if (unfinished.has(context.tabId) || pending !== undefined) {
            if (pending === true || unfinished.has(context.tabId)) await cleanup(context.tabId);
            return false;
          }
          if (await completed(context.tabId))
            return (await eligible(context)) && (await verify()) && live(context);
          if (
            !confirm ||
            (await confirm(context)) !== true ||
            !(await eligible(context))
          )
            return false;
          wrote = true;
          unfinished.add(context.tabId);
          await deps.store.setPending(context.tabId);
          if ((await deps.store.getPending(context.tabId)) !== true || !live(context)) throw new Error("Unverified tab intent");
          await deps.store.set(context.tabId, true);
          if (
            (await deps.store.get(context.tabId)) === true &&
            (await eligible(context)) && (await verify()) && live(context)
          ) {
            // Finalization is the session commit boundary, not atomic browser/document CAS.
            finalizing = true;
            await deps.store.removePending(context.tabId);
            if ((await deps.store.getPending(context.tabId)) !== undefined ||
                (await deps.store.get(context.tabId)) !== true || !(await eligible(context)) ||
                !(await verify()) || !live(context)) throw new Error("Unverified tab completion");
            unfinished.delete(context.tabId);
            return true;
          }
        } catch {
          // Failed reads, confirmation and persistence never publish an optimistic grant.
        }
        if (wrote) await cleanup(context.tabId, finalizing);
        return false;
      });
    },
    async isAllowed(input: TiktokTabContext): Promise<boolean> {
      const context = snapshot(input);
      if (!live(context)) return false;
      return serial(context.tabId, async () => {
        if (!(await eligible(context))) return false;
        return (
          (await completed(context.tabId)) &&
          (await eligible(context))
        );
      });
    },
    closeTab(tabId: number): Promise<boolean> {
      // Fence synchronously, before any delayed write/read/confirmation can settle.
      closed.add(tabId);
      return serial(tabId, async () => {
        return cleanup(tabId, true);
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      await Promise.all(flights.values());
      engine.stop?.();
      // Existing completed grants remain in browser-session storage across worker suspension.
    },
  };
}
