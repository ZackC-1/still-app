/**
 * The Still Pro lifetime offer (D18/D19). Prices come only from verified localized offer data; with no verified offer or channel there is no Buy action.
 * Safari popup: "Included in Still Pro" + host-app link, never a price or Buy. Apple host's Buy opens native StoreKit.
 */
export interface ProOfferProps {
  host?: 'browser' | 'safari' | 'apple';
  /** Verified localized strings from the channel. Omit when unverified. */
  offer?: { price: string; priceNote?: string; refundNote?: string };
  /** Channel capability. Anything but ready hides Buy. */
  channel?: 'ready' | 'unverified' | 'unavailable';
  /** Browser purchases need a confirmed Still account first: signed out, "Get Still Pro" calls onSignIn, then checkout continues */
  signedIn?: boolean;
  /** Existing rights win: owned or checking never shows a sale */
  ownership?: 'none' | 'owned' | 'checking';
  state?: 'idle' | 'pending' | 'failed' | 'success';
  /** From real capability data, e.g. SiteInventory Pro controls available on this host */
  controls?: { site: string; label: string }[];
  showList?: boolean;
  /** false = keep the price for the next step (Apple's purchase sheet or web checkout always shows it before payment) */
  showPrice?: boolean;
  onBuy?: () => void;
  onSignIn?: () => void;
  onRestore?: () => void;
  onOpenHost?: () => void;
  onRetry?: () => void;
}
export declare function ProOffer(props: ProOfferProps): JSX.Element;
