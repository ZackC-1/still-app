/**
 * One expandable site section (D06). Header: service mark, site name only, the service switch. Rows: the free core control first (Shorts / Reels), then the site's Pro controls.
 * At most one section open; fresh installs collapsed; the parent remembers the last open one locally. Service or global Off greys rows without rewriting them.
 * @startingPoint section="Sites" subtitle="Site sections with access states" viewport="700x420"
 */
export interface SiteSectionProps {
  service: 'youtube' | 'instagram' | 'facebook' | 'tiktok';
  /** The service switch ("Still on YouTube"; TikTok: the whole-site TikTok website switch). Off greys the rows and keeps them. */
  serviceOn?: boolean;
  onServiceChange?: (next: boolean) => void;
  /** @deprecated alias of serviceOn */
  coreOn?: boolean;
  /** @deprecated alias of onServiceChange */
  onCoreChange?: (next: boolean) => void;
  /** Saved choices keyed by control id (yt_shorts, ig_reels, fb_reels, yt_comments…). Missing free rows fall back to their default On. */
  values?: Record<string, boolean>;
  /** Access per control id. Missing = checking (never a confident lock). */
  access?: Record<string, 'free' | 'protected' | 'purchased' | 'checking' | 'verify' | 'locked' | 'unsupported'>;
  onControlChange?: (id: string, next: boolean) => void;
  open?: boolean;
  onToggleOpen?: () => void;
  /** Global Off */
  paused?: boolean;
  host?: 'browser' | 'safari' | 'apple';
  /** Boundary lines under each row (settings: on; popup: off) */
  showSubs?: boolean;
  onAccessAction?: (id: string) => void;
  /** Override the inventory (host-filtered) */
  controls?: { id: string; label: string; sub?: string }[];
}
export declare function SiteSection(props: SiteSectionProps): JSX.Element;
export interface SiteListProps {
  children?: any;
  paused?: boolean;
  /** Bounded internal scroll in the compact popup */
  scroll?: boolean;
}
export declare function SiteList(props: SiteListProps): JSX.Element;
