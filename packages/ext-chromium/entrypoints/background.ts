import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { browser } from "wxt/browser";
import { SettingsCache, ChromeStorageAdapter, createSettingsIntentRouter, SettingsStorageRecovery } from "@still/core/storage";
import { ChromeEntitlementAdapter, createEntitlementMessageRouter, packagedAccessContext, type TrustedAccessContext } from "@still/core/entitlement";
import {
  isServiceEnabledGlobally,
  createRuleSetRefresher,
} from "@still/core/rules";
import {
  SupabaseAuthPort,
  SupabaseBackendPort,
  SyncService,
  createExtensionSession,
  type ExtensionSession,
} from "@still/core/sync";
import { AUTH_STORAGE_KEY, clearExtensionAuthStorage, createAuthStorage } from "../lib/auth-storage.js";
import { createOriginalInstallStore, ensureOriginalInstall, parseOriginalInstall } from "../lib/original-install.js";
import { createIdentityStore, createSessionStores } from "../lib/session-stores.js";
import {
  createSessionMessageRouter,
} from "../lib/session-messages.js";
import { createIndexedDbKeyValue, QUIET_FLUSH_ALARM, requestQuietFlush } from "@still/core/analytics";
import { createBackgroundAnalytics, storageKeyValue } from "../lib/analytics.js";
import { modernSettingsRuntime } from "../lib/modern-settings-runtime.js";
import { FIRST_RUN_PAGE, shouldOpenFirstRun } from "../../core/src/ui/v3/first-run-host.js";
import {
  chromeInvitationLedgerPort,
  createInvitationHost,
  declaredHostsGranted,
  readAccountState,
} from "../lib/invitation-background.js";
import seed from "@still/core/seed";
import { PAID_TIER_ENABLED, type SignedRuleSet, type SignedRuleSetV2 } from "@still/shared-types";
import {
  createTiktokBlockedRoute,
  withTimeout,
  TIKTOK_WAIT_MS,
} from "../../core/src/content/tiktok-blocked-route.js";
import { createChromeTiktokTabAuthority, type TiktokTabBrowser } from "../lib/tiktok-tab-authority.js";
import { tiktokBlockedPageEnabled } from "./tiktok-blocked/gate.js";

// Chromium/Firefox background (Chrome MV3 service worker / Firefox MV3 event page). Three
// independent jobs:
//   • Signed rule-set refresh (parity with the Safari background): fetch → verify against this
//     build's trusted keys → cache for the NEXT page load, so a selector hotfix reaches
//     Chrome/Firefox over the air instead of waiting on a store re-review (KTD13). Skipped (no-op)
//     when no endpoint is configured, or on a production build before production keys are
//     published — in both cases the bundled seed keeps applying.
//   • The auth/purchase session spine (plan U5/U6, R2): this context is the ONE owner of the
//     Supabase session — popup/options are thin mirrors over the runtime-message router below.
//     The whole spine is gated by build-mode env (extensionSupabaseConfig, fail-safe): an
//     unconfigured build has no client and answers every session message with its structured
//     unavailable-style outcome — never a dev fallback.
//   • DNR gating (Chromium only): the static Shorts-redirect ruleset (KTD1) is enabled exactly
//     when the engine considers YouTube on globally — isServiceEnabledGlobally, the same predicate
//     isServiceActive composes (R2), so this gate can't drift from the content script's. The
//     Firefox build ships no DNR ruleset (it redirects via the content script), so that wiring
//     bails cleanly when the API is absent.
//
// Product analytics (lib/analytics.ts) also lives here: this context owns the one PostHog client,
// pages report to it by message, and content scripts may only name a service they blocked on.
//
// Plus one write that happens once in the life of an install: the record of when this browser
// first ran Still and on which version (lib/original-install.ts). It is local, never transmitted,
// and it is how the people who installed while everything was included can be recognised later.
const RULESET_ID = "youtube-shorts-redirect";
// The unlisted page built from entrypoints/tiktok-blocked/ (no manifest entry, no new permission).
const TIKTOK_BLOCKED_PAGE = "tiktok-blocked.html";

export default defineBackground(() => {
  const settingsRuntime = modernSettingsRuntime(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED as string | undefined,
  );
  const settingsAuthority = new ChromeStorageAdapter({ authority: true });
  const order: import("../lib/auth-storage.js").AuthMutationOrder = mutation => settingsAuthority.serializeLocalMutation(mutation);
  // Only durable mutation methods enter the shared queue. Wrapping a whole auth/session/read
  // operation could deadlock when it in turn writes settings or refreshes persisted SDK auth.
  class OrderedEntitlements extends ChromeEntitlementAdapter {
    override setRecord(record: Parameters<ChromeEntitlementAdapter["setRecord"]>[0]) {
      return order(() => super.setRecord(record));
    }
    override mutateAccess(mutation: Parameters<ChromeEntitlementAdapter["mutateAccess"]>[0]) {
      return order(() => super.mutateAccess(mutation));
    }
    override mutateLocalProtection(mutation: Parameters<ChromeEntitlementAdapter["mutateLocalProtection"]>[0]) {
      return order(() => super.mutateLocalProtection(mutation));
    }
  }
  let verifiedAccessSession: (() => Promise<TrustedAccessContext["session"]>) | null = null;
  const entitlements = new OrderedEntitlements(Date.now, { authority: true, context: async () => {
    const context = packagedAccessContext();
    if (!context.paidMode) return context;
    // Existing SDK verified-claims grammar; requester body, raw cached user and purchase Boolean
    // cannot select a scope. Unavailable verification remains unknown, not signed-out/absent.
    return { ...context, session: verifiedAccessSession ? await verifiedAccessSession().catch(() => undefined) : undefined };
  } });
  chrome.runtime.onMessage.addListener(createEntitlementMessageRouter(entitlements, chrome.runtime.id, chrome.runtime.getURL("")));
  const refreshRuleSet = createRuleSetRefresher({
    prod: import.meta.env.PROD,
    url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    area: chrome.storage.local,
  });

  // Refresh on cold start / service-worker wake.
  void refreshRuleSet();

  // Record when this browser first ran Still, once, locally. Fire and forget on purpose: it is a
  // single storage read that usually finds an existing record, nothing waits on it, and a failure
  // costs one cohort signal rather than a working extension.
  void ensureOriginalInstall({
    store: createOriginalInstallStore(),
    now: Date.now,
    appVersion: browser.runtime.getManifest().version,
  });

  // ── Auth/purchase session spine (plan U6/R2) ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(createSettingsIntentRouter(
    intent => settingsAuthority.commitIntent(intent), chrome.runtime.id, chrome.runtime.getURL(""), record => settingsAuthority.set(record),
  ));
  const cache = new SettingsCache(settingsAuthority);
  cache.watch();
  const heldInitialization = (error: unknown) => {
    // A hold is not a successful default read. No stored settings/account payload is logged.
    console.warn("Still settings initialization held", error instanceof SettingsStorageRecovery ? error.reason : "storage-unavailable");
  };
  // Configured default builds preserve the maintained legacy free-sync document. Atomic local
  // builds migrate readable choices without a claim about account history; wakes never seed.
  const hydrated = settingsRuntime.atomicLocal
    ? settingsAuthority.initializeAtomic("unknown").catch(heldInitialization).then(() => cache.hydrate())
    : cache.hydrate();
  const spine = createSessionSpine(cache, entitlements, order, settingsRuntime);
  const session = spine?.session ?? null;
  // Sync invitation ledger (U13-P2): every ledger transaction runs in this worker's serialized
  // queue; popup and options only send messages. The inline build-time check can only narrow to
  // legacy, so a configured store-style build drops this whole block and stays byte-identical.
  if (
    !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
    import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"
  ) {
    const client = spine?.client;
    let ratingAllowance: Promise<() => Promise<{ allowed: boolean; reason: string }>> | undefined;
    const invitations = createInvitationHost({
      port: chromeInvitationLedgerPort(order, chrome.storage.local),
      setupFinished: () => declaredHostsGranted(chrome.permissions, chrome.runtime.getManifest()),
      account: async () => (client ? readAccountState(client.auth) : "signed-out"),
      signInAvailable: spine !== null,
      now: Date.now,
      newInstallationId: () => crypto.randomUUID(),
      // Read only: the startup call above is the one writer of the original-install record.
      firstRunAt: async () => parseOriginalInstall(await createOriginalInstallStore().get())?.firstRecordedAt ?? null,
      // The rating card (U13-P3), in builds that show the V3 popup. Its allowance module, the one
      // user of the policy client, loads on first use; the remote rating policy is Off, so no card
      // shows until the owner allows it after the V3 store release.
      rating: settingsRuntime.atomicLocal
        ? {
            surface: import.meta.env.FIREFOX ? "firefox" : "chrome",
            freshCheck: () => {
              ratingAllowance ??= import("../lib/rating-invitation.js").then((rating) =>
                rating.browserRatingAllowance({
                  isFirefox: Boolean(import.meta.env.FIREFOX),
                  supabaseUrl: settingsRuntime.supabase?.url,
                  production: import.meta.env.PROD,
                  build: browser.runtime.getManifest().version,
                  runtime: chrome.runtime,
                }),
              );
              return ratingAllowance.then((check) => check());
            },
          }
        : undefined,
    });
    chrome.runtime.onMessage.addListener(invitations.listener(chrome.runtime.id, chrome.runtime.getURL("")));
  }
  if (spine) {
    const accessAuth = new SupabaseAuthPort(spine.client);
    verifiedAccessSession = async () => (await accessAuth.currentSettingsSession()) ?? undefined;
    spine.client.auth.onAuthStateChange(() => entitlements.invalidateAccessContext());
  }

  // Registered in the background's first synchronous pass: onInstalled fires once, early, on a
  // fresh install or update, and a listener added after an await would miss it.
  const analytics = createBackgroundAnalytics(
    {
      isFirefox: Boolean(import.meta.env.FIREFOX),
      config: {
        key: import.meta.env.VITE_POSTHOG_KEY as string | undefined,
        host: import.meta.env.VITE_POSTHOG_HOST as string | undefined,
      },
      appVersion: browser.runtime.getManifest().version,
      local: storageKeyValue(chrome.storage.local),
      queue: createIndexedDbKeyValue(),
      shared: chrome.storage.sync ? storageKeyValue(chrome.storage.sync) : null,
      requestQuietFlush: () => requestQuietFlush(chrome.alarms),
      identifyOnServer: spine
        ? async () => {
            const { error } = await spine.client.functions.invoke("analytics-identify", { body: {} });
            if (error) throw error;
          }
        : undefined,
    },
    chrome.runtime.id,
    chrome.runtime.getURL(""),
  );
  // Admission belongs only to this process's actual install or update event. A duplicate callback
  // cannot replenish an exhausted budget, and a wake never inherits a persisted retry grant.
  let installAdmissionConsumed = false;
  const initializeInstalledSettings = async (
    initialize: () => Promise<unknown>,
  ): Promise<void> => {
    const rereadInstalledSettings = async (): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await cache.rereadAuthority();
        if (outcome.status !== "unavailable") return; // a newer authority owns superseded reads
        if (outcome.reason !== "read-failed")
          throw new SettingsStorageRecovery(outcome.reason);
      }
      throw new SettingsStorageRecovery("read-failed");
    };
    let readbacks = 0;
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await initialize();
      } catch (error) {
        if (error instanceof SettingsStorageRecovery) throw error;
        failure = error;
        // A rejected write may already have persisted. Only a successful read can resolve that
        // ambiguity; any retained current record stops seeding without attributing it to us.
        let absent = false;
        while (readbacks < 3) {
          readbacks += 1;
          let current: Awaited<ReturnType<typeof settingsAuthority.get>>;
          try {
            current = await settingsAuthority.get();
          } catch (readError) {
            if (readError instanceof SettingsStorageRecovery) throw readError;
            failure = readError;
            continue;
          }
          if (current !== null) {
            await rereadInstalledSettings();
            return;
          }
          absent = true;
          break;
        }
        if (!absent) throw failure;
        // Parsed absence is not admission: the next same-writer initializer re-checks absence
        // (and, for an install, all raw keys and observed history) inside the writer queue. No
        // new write is attempted while readback is ambiguous.
        continue;
      }
      // hydrate() is memoized. A failed readiness read must never repeat fresh persistence.
      await rereadInstalledSettings();
      return;
    }
    throw failure;
  };
  chrome.runtime.onInstalled.addListener((details) => {
    // Owner decision 28: when nothing is saved yet, the first launch saves defaults. A new install
    // saves the fresh defaults; an update from a 2.x that never saved a setting saves the defaults
    // it was already using (unknown ownership, so an account still wins on sign-in). Neither ever
    // replaces a retained record, and configured legacy builds keep today's behaviour.
    if ((details.reason === "install" || details.reason === "update") && settingsRuntime.atomicLocal && !installAdmissionConsumed) {
      installAdmissionConsumed = true;
      void initializeInstalledSettings(
        details.reason === "install"
          ? () => settingsAuthority.initializeFreshAtomic()
          : () => settingsAuthority.initializeUntouchedUpgradeAtomic(),
      ).catch(heldInitialization);
    }
    analytics.onInstalled(details);
    // D14: a brand-new install opens the first-run page, after (never instead of) install-time
    // settings and analytics. Nothing waits on it, and blocking never depends on it; an update
    // never opens it (Settings → Setup guide reopens it on request). Like the other V3 screens it
    // appears only in builds that show them; configured 2.x builds keep today's install behaviour.
    if (settingsRuntime.atomicLocal && shouldOpenFirstRun(details)) {
      void Promise.resolve()
        .then(() => chrome.tabs.create({ url: chrome.runtime.getURL(FIRST_RUN_PAGE) }))
        .catch(() => {
          /* a tab that cannot open changes nothing about blocking */
        });
    }
  });
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === QUIET_FLUSH_ALARM) void analytics.flushWhenReady();
  });
  chrome.runtime.onMessage.addListener(analytics.listener);

  // Content-script nudge — the ONLY handler a content-script sender may reach (plan KTD sender
  // rule; these scripts run inside instagram/tiktok/facebook/youtube pages). Fired at
  // document_start, which also wakes this worker: refresh the rule-set cache, and let the session
  // decide whether a reconcile is due (session + pending checkout or stale cache, R4/AE3 — the
  // staleness/throttle logic lives in core's onNudge).
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === "object" && (message as { kind?: string }).kind === "reconcile") {
      void refreshRuleSet();
      void session?.onNudge();
      // The nudge is real use (a supported site was opened); analytics records only its day.
      analytics.onActivity();
    }
    return false;
  });

  // Privileged session router (plan KTD sender validation): getState/requestCode/verifyCode/
  // signOut/deleteAccount/reconcile/restore/createCheckout + the persistence setters dispatch ONLY
  // for extension-page senders — same extension id AND an extension-origin URL. The origin check is
  // strictly stronger than a `sender.tab === undefined` test: content scripts carry the page's URL
  // (never the extension origin) so they're still walled off to the nudge, while the EMBEDDED
  // options page (options_ui.open_in_tab:false) — which carries a sender.tab and would be wrongly
  // rejected by a tab check — is correctly allowed (F9). Anything else falls through unanswered (the
  // sender's closures settle to their structured fail-safe). Async responses use the sendResponse +
  // `return true` shape — the one contract both Chrome MV3 and Firefox's chrome-namespace listeners
  // honor; a promise-returning listener would break on Chrome, where the return value is only the
  // keep-alive flag.
  const extensionOrigin = chrome.runtime.getURL("");
  chrome.runtime.onMessage.addListener(createSessionMessageRouter(session, chrome.runtime.id, extensionOrigin));

  // ── TikTok blocked page (D29) ───────────────────────────────────────────────────────────────────
  // Same release gate as the other V3 screens: builds that show the V3 popup/settings send blocked
  // TikTok tabs to the extension's own page; configured 2.x builds keep the in-page block. The
  // content script reads this same gate (tiktok-blocked/gate.ts), pinned to `atomicLocal` by test.
  // Constructed in this first synchronous pass so the tab owner's onRemoved/onReplaced listeners
  // are top-level.
  const tiktokEnabled = tiktokBlockedPageEnabled({
    // Name each input (never import.meta.env whole, which inlines every VITE_* value), reduced
    // exactly as the content script reduces them so the two entrypoints cannot decide differently.
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL?.trim() ? "set" : "",
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ? "set" : "",
    VITE_MODERN_SETTINGS_SYNC_ENABLED: import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED,
  });
  if (tiktokEnabled) wireTiktokBlockedPage(settingsAuthority, entitlements);

  // Resume on EVERY background start (R2 hard rule): restart the sync write-through from the
  // CACHED entitlement, with no purchase-service query. A worker that wakes on a settings edit
  // must not drop paid sync, and must not burn a live RevenueCat query per wake; live reconcile
  // stays on the R4 triggers (popup open, qualifying nudge). It does make one settings read, so a
  // browser that was closed while another device changed something learns about it here rather
  // than publishing over it on its next edit.
  void hydrated.then(() => session?.resume()).catch(heldInitialization);
  // No session spine (an unconfigured build) reads as signed out; a failed or stalled read is
  // "unknown", which changes nothing about the account and confirms nothing, so nothing is sent.
  const ACCOUNT_LOOKUP_LIMIT_MS = 8_000;
  void Promise.race([
    hydrated.then(() => session?.getState()).then((state) => (state ? state.userId : null)),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), ACCOUNT_LOOKUP_LIMIT_MS)),
  ]).then((userId) => analytics.onStart(userId), () => analytics.onStart(undefined));

  // ── DNR gating — Chromium only from here down. ───────────────────────────────────────────────
  if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return;

  const syncRuleset = async (): Promise<void> => {
    // The engine's own URL-free gate (R2) — no re-derived inline predicate. Per-URL pauses don't
    // apply to a global DNR ruleset (and parseSettings normalizes stored pauses to [] anyway).
    const enabled = isServiceEnabledGlobally(cache.current(), "youtube");
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled ? { enableRulesetIds: [RULESET_ID] } : { disableRulesetIds: [RULESET_ID] },
    );
  };

  cache.subscribe(() => void syncRuleset().catch(heldInitialization));
  void hydrated.then(syncRuleset).catch(heldInitialization);
});

/**
 * The one-tab TikTok allowance owner plus its message route. Every browser wait handed to the
 * owner is bounded here, so a stalled storage, tab or settings answer ends as "not allowed" and
 * can never hold a tab's queue or stop(). Saved/synced settings are only ever read.
 */
function wireTiktokBlockedPage(
  settingsAuthority: ChromeStorageAdapter,
  entitlements: ChromeEntitlementAdapter,
): void {
  // The packaged seed is the rule set every Chromium/Firefox content script evaluates for TikTok
  // today (TikTok is held on the legacy lane), so the background decides "blocked" with the same
  // rules. The owner's type names the format-2 set it is planned to receive; its engine session
  // already dispatches on the set's own format. Follow-up: once format-2 ships for TikTok with
  // schema-2 settings, switch this "is this blocked" check to the packaged format-2 set
  // (PACKAGED_RULE_SET_V2) and drop the cast below.
  const ruleSet = seed as unknown as SignedRuleSet;
  const bound = <T>(operation: () => Promise<T>): Promise<T> =>
    withTimeout(Promise.resolve().then(operation), TIKTOK_WAIT_MS);
  const getContexts = chrome.runtime.getContexts?.bind(chrome.runtime);
  // A host without tab or session APIs gets an unwired route: TikTok keeps the in-page block.
  const api = chrome.tabs;
  const tabs = api && {
    get: (id: number) => bound(() => api.get(id)),
    onRemoved: api.onRemoved,
    onReplaced: api.onReplaced,
  };
  const route = createTiktokBlockedRoute({
    runtimeId: chrome.runtime.id,
    extensionOrigin: chrome.runtime.getURL(""),
    pageUrl: chrome.runtime.getURL(TIKTOK_BLOCKED_PAGE),
    // The route bounds every session call and the settings read it hands to the owner below.
    session: chrome.storage?.session,
    tabs: tabs && {
      ...tabs,
      // Firefox can replace the blocked TikTok entry so Back leaves TikTok; Chromium cannot.
      update: (id, properties) =>
        bound(() => api.update(id, properties as chrome.tabs.UpdateProperties)),
    },
    ruleSet,
    readCommitted: async () => {
      const record = await settingsAuthority.get();
      if (!record) return null;
      // Same tier gate as the content script's legacy lane (dormant while paid flags are off).
      const pro = !PAID_TIER_ENABLED || (await entitlements.get()) === true;
      return { settings: record.settings, options: { pro } };
    },
    canVerifyDocuments: typeof getContexts === "function",
    replaceHistory: Boolean(import.meta.env.FIREFOX),
    createAuthority: (hooks) =>
      createChromeTiktokTabAuthority({
        browser: {
          runtime: {
            id: chrome.runtime.id,
            getURL: (path) => chrome.runtime.getURL(path),
            ...(getContexts
              ? {
                  getContexts: (filter) =>
                    bound(() => getContexts(filter as chrome.runtime.ContextFilter)).then((contexts) =>
                      contexts.map((context) => ({ ...context, contextType: String(context.contextType) }))),
                }
              : {}),
          },
          storage: { session: hooks.session },
          tabs,
        } satisfies TiktokTabBrowser,
        ruleSet: ruleSet as unknown as SignedRuleSetV2,
        readCommitted: hooks.readCommitted,
        blockedPagePath: TIKTOK_BLOCKED_PAGE,
        resolveOriginalTarget: hooks.resolveOriginalTarget,
        confirm: hooks.confirm,
      }),
    randomId: () => crypto.randomUUID(),
  });
  chrome.runtime.onMessage.addListener(route.listener);
}

/**
 * Build the background-owned session (plan U5 deps ← U6 wiring), or null when the build carries no
 * Supabase config (the fail-safe: the routers above then answer with structured unavailable-style
 * outcomes). Client config per the extension-session contract: ONE client, `persistSession: true`,
 * `detectSessionInUrl: false`, `autoRefreshToken: false` (refresh is lazy — getSession() on wake),
 * over the chrome.storage.local auth adapter under its distinct storageKey.
 */
function createSessionSpine(
  cache: SettingsCache,
  entitlements: ChromeEntitlementAdapter,
  order: import("../lib/auth-storage.js").AuthMutationOrder,
  settingsRuntime: ReturnType<typeof modernSettingsRuntime>,
): { session: ExtensionSession; client: SupabaseClient } | null {
  const config = settingsRuntime.supabase;
  if (config === null) return null;

  const client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: createAuthStorage(order),
      storageKey: AUTH_STORAGE_KEY,
    },
  });

  const port = new SupabaseAuthPort(client);
  const auth = {
    signInWithMagicLink: (email: string) => port.signInWithMagicLink(email),
    requestCode: (email: string) => port.requestCode(email),
    verifyCode: (email: string, token: string) => port.verifyCode(email, token),
    signOut: () => port.signOut(),
    // Local session read with lazy refresh (the R2 contract): getSession() reads the persisted
    // session and refreshes an expired token. The port's own getUser() is a network round-trip
    // that reads signed-out when offline — it would drop paid sync on every offline wake and
    // break AE6's cached-entitlement guarantee, so it is deliberately not used here.
    currentUserId: async (): Promise<string | null> => {
      const { data } = await client.auth.getSession();
      return data.session?.user.id ?? null;
    },
    currentSettingsSession: () => port.currentSettingsSession(),
    // Display identity comes from the authenticated session, never the popup's pending OTP draft.
    currentAccount: () => port.currentAccount(),
  };
  const backend = new SupabaseBackendPort(client, { modernSettings: settingsRuntime.modernCloud });
  const identityStore = createIdentityStore();
  const identity = { get: () => identityStore.get(), set: (userId: string) => order(() => identityStore.set(userId)) };
  const sessionStores = createSessionStores();
  function orderedSlot<T>(slot: import("@still/core/sync").PersistedSlot<T>): import("@still/core/sync").PersistedSlot<T> {
    return { get: () => slot.get(), set: value => order(() => slot.set(value)) };
  }

  const session = createExtensionSession({
    auth,
    backend,
    records: entitlements,
    sync: new SyncService(cache, auth, backend, undefined, identity),
    identity,
    stores: {
      pendingOtp: orderedSlot(sessionStores.pendingOtp),
      checkoutPending: orderedSlot(sessionStores.checkoutPending),
      nudgeStamp: orderedSlot(sessionStores.nudgeStamp),
    },
    // Best-effort teardown of a recorded checkout tab (it still carries the old identity); the
    // session already guards the call, so a missing tab just rejects quietly.
    closeTab: async (tabId: number) => {
      await browser.tabs.remove(tabId);
    },
    // Offline-proof sign-out (F1): drop the persisted session so a failed remote revoke can't leave
    // it on disk for the next wake to resurrect.
    clearAuthStorage: () => clearExtensionAuthStorage(order),
  });
  return { session, client };
}
