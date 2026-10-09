import type { NavigationIntent } from "./redirect.js";

// YouTube Autoplay prevention (Still Pro `youtube.autoplay`, CP-086 / D263), a packaged content
// handler in the isolated world. It never touches YouTube's own autoplay toggle, cookies, storage,
// account, network, player payloads or the main world, never pauses or starts a video, and never
// navigates (no location.replace / history.back bounce).
//
// Mechanism (plan candidate (a)): while the main player's current video is in its ENDED state,
// cancel that one up-next countdown through the countdown's own Cancel control, so the next
// recommended video never loads. The ended state starts on the player video's `ended` event and
// lasts until that video plays again (Replay, a new video), the page moves, or the control turns
// Off. There is no time window: a countdown that appears late in the same ended state is
// cancelled too. Cancel is pressed at most MAX_CANCELS_PER_END times per ended state, so a page
// that keeps re-showing its countdown can never make Still click in a loop; after that the
// countdown is left to YouTube.
//
// Deliberate playlists continue (D263): a playlist the person started on purpose (a full page
// load, a link they activated, or Back/forward, landing on a `list=` URL) advances to its next
// item. Back/forward reaches the guard either as a cancelable traversal through the navigation
// hooks or, when the browser reports it only after committing (Firefox ESR, Chromium's
// non-cancelable traversals), as popstate (content/index.ts). A recommendation taking over after the playlist ends is cancelled, and a playlist id the
// page added on its own (for example an automatic Mix) is never treated as chosen: a `list=`
// value alone is not intent. Only the current chosen playlist id is held, in memory, for this
// document; nothing is stored or sent.
//
// Two countdown layouts, one mechanism. The desktop layout (www.youtube.com, and an iPad that
// requests the desktop site) draws its countdown inside the main player. The phone layout
// (m.youtube.com, iPhone Safari and Firefox for Android) draws it in the player controls beside
// the main player, inside the same player container; there the playlist the person chose advances
// with no countdown at all, so it is never stopped.
//
// SELECTOR STATUS: the desktop countdown and Cancel class names are UNVERIFIED candidates
// modelled on tests/fixtures/extras/yt-autoplay.html. The phone countdown, its timer attribute and
// its single Cancel <button> beside a Play now link were observed on public m.youtube.com on
// 2026-10-09 in phone emulation (WebKit/iPhone, Gecko/Firefox for Android and Chromium/Android
// user agents, signed out): pressing that Cancel kept the page, left Replay and YouTube's own
// autoplay toggle unchanged (tests/fixtures/extras/yt-m-autoplay.html). Emulation is not device
// acceptance: the release gate still needs the owner's H-017/H-075 checks on physical devices,
// including background tabs.

/** The main watch-page player. Inline previews and other embedded players are never touched. */
export const AUTOPLAY_PLAYER = "#movie_player";
/** The up-next countdown shown when the current video ends with YouTube's autoplay on. */
export const AUTOPLAY_COUNTDOWN = ".ytp-autonav-endscreen-countdown-overlay";
/** That countdown's own Cancel control: cancels this one up-next, never the autoplay setting. */
export const AUTOPLAY_CANCEL = ".ytp-autonav-endscreen-upnext-cancel-button";
/** The countdown's Play-now control, which must never be pressed in place of Cancel. */
const AUTOPLAY_PLAY = "ytp-autonav-endscreen-upnext-play-button";
/** Phone layout: the player container that holds the main player AND its controls. */
export const MOBILE_AUTOPLAY_CONTAINER = "#player-container-id";
/** Phone layout: the up-next card only while it counts down (a timer is what autoplays). */
export const MOBILE_AUTOPLAY_COUNTDOWN = 'player-endscreen #player-endscreen[data-has-timer-countdown="true"]';
/** Phone layout: the card's action row (one Cancel button, one Play now link). */
const MOBILE_AUTOPLAY_ACTIONS = ".ytwPlayerEndscreenButtonContainer";

/**
 * True only for a real Cancel button: a <button>, not the Play control, and with no link between
 * it and the countdown (a click inside a link could navigate to the up-next video).
 */
const isCancelButton = (cancel: Element, countdown: Element): cancel is HTMLButtonElement => {
  if (!(cancel instanceof HTMLButtonElement) || cancel.classList.contains(AUTOPLAY_PLAY)) return false;
  for (let at: Element | null = cancel; at && at !== countdown; at = at.parentElement) {
    if (at.matches("a[href]")) return false;
  }
  return true;
};

/** One countdown layout: where its countdown lives relative to the main player, and its Cancel. */
interface CountdownLayout {
  readonly scope: (player: Element) => Element | null;
  readonly countdown: string;
  readonly cancel: (countdown: Element) => HTMLButtonElement | null;
}

const LAYOUTS: readonly CountdownLayout[] = [
  {
    scope: (player) => player,
    countdown: AUTOPLAY_COUNTDOWN,
    cancel: (countdown) => {
      const cancel = countdown.querySelector(AUTOPLAY_CANCEL);
      return cancel && isCancelButton(cancel, countdown) ? cancel : null;
    },
  },
  {
    // The container must hold this exact player: a countdown of another player is never this one.
    scope: (player) => player.closest(MOBILE_AUTOPLAY_CONTAINER),
    countdown: MOBILE_AUTOPLAY_COUNTDOWN,
    cancel: (countdown) => {
      // The row's only button is Cancel; Play now is a link. Any other shape (no button, or a
      // second button that could be Play now redrawn) is ambiguous and is left to YouTube.
      const rows = countdown.querySelectorAll(MOBILE_AUTOPLAY_ACTIONS);
      if (rows.length !== 1) return null;
      const buttons = rows[0]!.querySelectorAll("button");
      if (buttons.length !== 1) return null;
      return isCancelButton(buttons[0]!, countdown) ? buttons[0]! : null;
    },
  },
];

/** Cancel presses allowed in one ended state (one countdown plus one re-shown countdown). */
export const MAX_CANCELS_PER_END = 2;

export interface YouTubeAutoplayGuard {
  /** Records who started a navigation the content script saw; "deliberate" sets the chosen playlist. */
  navigated(target: URL, intent: NavigationIntent): void;
  /** Attaches while `active` (the feature is effective on this YouTube page), detaches otherwise. */
  reconcile(active: boolean, url: URL): void;
  /** Teardown: removes every listener and observer. Never clicks, plays or pauses anything. */
  stop(): void;
}

const listOf = (url: URL): string | null => {
  const list = url.searchParams.get("list");
  return list ? list : null;
};

const shown = (element: Element): boolean => {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView;
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (at.hasAttribute("hidden") || view?.getComputedStyle(at).display === "none") return false;
  }
  return true;
};

export function createYouTubeAutoplayGuard(doc: Document, initialUrl: URL): YouTubeAutoplayGuard {
  // A full page load is the person's own navigation.
  let chosenList: string | null = listOf(initialUrl);
  let active = false;
  let stopped = false;
  let currentHref = initialUrl.href;
  let currentList: string | null = listOf(initialUrl);
  /** The ended state: the player video that ended, and the countdown already cancelled in it. */
  let ended: { readonly video: HTMLMediaElement; readonly player: Element; cancelled: Element | null; presses: number } | null = null;
  let observers: MutationObserver[] = [];

  const leaveEnded = (): void => {
    for (const observer of observers) observer.disconnect();
    observers = [];
    ended = null;
  };

  /** This player's countdown: a shown one in either layout first, otherwise a hidden one. */
  const locate = (player: Element): { readonly countdown: Element; readonly layout: CountdownLayout | null } | null => {
    let hidden: Element | null = null;
    for (const layout of LAYOUTS) {
      const countdown = layout.scope(player)?.querySelector(layout.countdown);
      if (!countdown) continue;
      if (shown(countdown)) return { countdown, layout };
      hidden ??= countdown;
    }
    return hidden ? { countdown: hidden, layout: null } : null;
  };

  /** True when the up-next is the next item of the playlist the person chose. */
  const continuesChosenPlaylist = (countdown: Element): boolean => {
    if (chosenList === null || currentList !== chosenList) return false;
    const link = countdown.querySelector<HTMLAnchorElement>('a[href*="/watch"]');
    if (!link) return false;
    try {
      return listOf(new URL(link.href, doc.baseURI)) === chosenList;
    } catch {
      return false;
    }
  };

  const cancelCountdown = (): void => {
    if (!ended || !active || stopped) return;
    const found = locate(ended.player);
    if (!found?.layout) {
      // Hidden again (YouTube dismissed it): a later countdown in this ended state is new.
      if (ended.cancelled && (!found || found.countdown === ended.cancelled)) ended.cancelled = null;
      return;
    }
    const { countdown, layout } = found;
    if (ended.cancelled === countdown || ended.presses >= MAX_CANCELS_PER_END || continuesChosenPlaylist(countdown)) return;
    const cancel = layout.cancel(countdown);
    if (!cancel) return;
    ended.cancelled = countdown;
    ended.presses++;
    cancel.click();
  };

  const onEnded = (event: Event): void => {
    const video = event.target;
    if (!active || stopped || !(video instanceof HTMLMediaElement) || !video.isConnected) return;
    const player = video.closest(AUTOPLAY_PLAYER);
    if (!player) return;
    // A repeated end of the same video, with no playback between, is the same ended state.
    if (ended?.video === video) return cancelCountdown();
    leaveEnded();
    ended = { video, player, cancelled: null, presses: 0 };
    // YouTube shows its countdown from its own `ended` handler, after this capture listener, or
    // later still: watch only where this player's countdown can appear, only while it stays ended.
    const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
    const scopes = LAYOUTS.map((layout) => layout.scope(player)).filter((scope): scope is Element => scope !== null);
    // One observer per outermost scope (the phone container already holds the player).
    for (const scope of scopes.filter((scope, at) => !scopes.some((other, i) => i !== at && other !== scope && other.contains(scope)) && scopes.indexOf(scope) === at)) {
      const observer = new Observer(cancelCountdown);
      observer.observe(scope, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["class", "style", "hidden", "data-has-timer-countdown"] });
      observers.push(observer);
    }
    queueMicrotask(cancelCountdown);
    cancelCountdown();
  };

  /** Replay or any new playback of the ended video ends the ended state; stale events are ignored. */
  const onPlay = (event: Event): void => {
    if (ended && event.target === ended.video) leaveEnded();
  };

  const attach = (): void => {
    doc.addEventListener("ended", onEnded, true);
    doc.addEventListener("play", onPlay, true);
  };
  const detach = (): void => {
    doc.removeEventListener("ended", onEnded, true);
    doc.removeEventListener("play", onPlay, true);
    leaveEnded();
  };

  return {
    navigated(target, intent) {
      if (stopped || intent !== "deliberate") return;
      // A click that stays on the current video (a timestamp or chapter link: same /watch and
      // same v, no list=) only seeks; it is not a new choice and keeps the chosen playlist.
      const current = new URL(currentHref);
      if (target.pathname === "/watch" && current.pathname === "/watch" && listOf(target) === null
        && target.origin === current.origin && target.searchParams.get("v") === current.searchParams.get("v")) return;
      chosenList = target.pathname === "/watch" ? listOf(target) : null;
    },
    reconcile(next, url) {
      if (stopped) return;
      if (url.href !== currentHref) {
        // A new page: the old ended state is over (stale countdowns are never acted on).
        currentHref = url.href;
        currentList = listOf(url);
        leaveEnded();
      }
      if (next === active) return;
      active = next;
      if (active) attach();
      else detach(); // Off: only Still's own listeners go; nothing is played, paused or clicked.
    },
    stop() {
      stopped = true;
      active = false;
      detach();
    },
  };
}
