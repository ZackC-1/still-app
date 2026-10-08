// Compatibility entry: Chromium and Firefox keep their existing API and callers.
export {
  createBrowserTiktokTabAuthority as createChromeTiktokTabAuthority,
  isTiktokRouteMessage,
  type BrowserTiktokTabAuthorityDeps as ChromeTiktokTabAuthorityDeps,
  type TiktokBrowserSender,
  type TiktokTabBrowser,
} from "@still/core/content/browser-tiktok-tab-authority";
