import {describe,it,expect,vi} from "vitest";
import {createAppleSession} from "../apple-session.js";
import {SettingsCache} from "../../storage/cache.js";
import {InMemoryStorageAdapter} from "../../storage/adapter.js";
import {UiController} from "../../ui/controller.svelte.js";
import {makeBridge} from "./support/apple-session-harness.js";

const account = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function compose() {
  const controller = new UiController({cache:new SettingsCache(new InMemoryStorageAdapter(null)),host:{canPurchase:true}});
  let finishStatus!: () => void;
  const bridge=makeBridge({setAccountSyncStatus:vi.fn(() => new Promise<void>(resolve => {finishStatus=resolve;}))});
  const onNativeAccountStatusPublished=vi.fn();
  const refreshAccountAccess=vi.fn(async () => {});
  const sync={onSignedIn:vi.fn(async () => {}),signOut:vi.fn(async () => {}),deleteAccount:vi.fn(async () => {})};
  const session=createAppleSession({controller,bridge,sync,purchaseLinkMode:"explicit",refreshAccountAccess,onNativeAccountStatusPublished,exchangeAppleCredential:async()=>({userId:account})});
  return {session,controller,bridge,sync,refreshAccountAccess,onNativeAccountStatusPublished,finishStatus:()=>finishStatus()};
}
describe("modern Apple account entry",()=>{
  it("a rejected native lineage write keeps purchase reconciliation held while free sync completes",async()=>{
    const h=compose();
    vi.mocked(h.bridge.setAccountSyncStatus!).mockRejectedValueOnce(new Error("Native identity write unavailable"));
    await h.session.enterSession(account);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.sync.onSignedIn).toHaveBeenCalledExactlyOnceWith(account);
    expect(h.onNativeAccountStatusPublished).not.toHaveBeenCalled();
    expect(h.refreshAccountAccess).not.toHaveBeenCalled();
  });
  it("publishes account lineage before purchase reconciliation without delaying free sync or code completion",async()=>{
    const h=compose();
    await h.session.onCodeVerified(account,"account@still.test");
    expect(h.sync.onSignedIn).toHaveBeenCalledExactlyOnceWith(account);
    expect(h.bridge.setAccountSyncStatus).toHaveBeenCalledWith(expect.objectContaining({accountId:account}));
    expect(h.refreshAccountAccess).not.toHaveBeenCalled();
    h.finishStatus();
    await vi.waitFor(()=>expect(h.refreshAccountAccess).toHaveBeenCalledOnce());
    expect(h.onNativeAccountStatusPublished).toHaveBeenCalledOnce();
    expect(h.bridge.configurePurchases).not.toHaveBeenCalled();
    expect(h.bridge.attachPurchases).not.toHaveBeenCalled();
  });
  it("superseded entry never reconciles after its delayed status write",async()=>{
    const h=compose();
    await h.session.enterSession(account);
    h.session.onSyncState({userId:null,entitled:false,syncing:false,cloudReachable:true,confirmed:true});
    h.finishStatus();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.refreshAccountAccess).not.toHaveBeenCalled();
    expect(h.onNativeAccountStatusPublished).not.toHaveBeenCalled();
  });
  it("sign-out notifies after native account lineage clears and never waits for purchase verification",async()=>{
    const h=compose();
    await h.session.enterSession(account);
    h.finishStatus();
    await vi.waitFor(()=>expect(h.onNativeAccountStatusPublished).toHaveBeenCalledOnce());
    const leaving=h.session.signOutEverywhere();
    await vi.waitFor(()=>expect(h.bridge.setAccountSyncStatus).toHaveBeenCalledWith(null));
    expect(h.onNativeAccountStatusPublished).toHaveBeenCalledOnce();
    h.finishStatus();
    await leaving;
    expect(h.onNativeAccountStatusPublished).toHaveBeenCalledTimes(2);
    expect(h.sync.signOut).toHaveBeenCalledOnce();
  });
  it("an old native status completion cannot notify or reconcile the replacement account",async()=>{
    const h=compose();
    await h.session.enterSession(account);
    await h.session.enterSession("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    h.finishStatus();
    await vi.waitFor(()=>expect(h.bridge.setAccountSyncStatus).toHaveBeenCalledTimes(2));
    expect(h.onNativeAccountStatusPublished).not.toHaveBeenCalled();
    expect(h.refreshAccountAccess).not.toHaveBeenCalled();
    h.finishStatus();
    await vi.waitFor(()=>expect(h.refreshAccountAccess).toHaveBeenCalledOnce());
    expect(h.onNativeAccountStatusPublished).toHaveBeenCalledOnce();
  });

});
