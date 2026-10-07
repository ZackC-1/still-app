/**
 * The one in-page screen (D29): extension-owned top-level TikTok page. "Open TikTok this time" needs explicit confirmation and allows only the current tab. No permanent switch-off here.
 */
export interface TikTokBlockedProps {
  /** ios = Safari on iPhone/iPad: manual instructions replace the settings link */
  host?: 'browser' | 'ios';
  /** reload = the allowance was granted but the page must be reloaded to show TikTok */
  state?: 'blocked' | 'reload';
  /** Control the confirmation dialog (defaults to internal state) */
  confirmOpen?: boolean;
  onOpenOnce?: () => void;
  onOpenSettings?: () => void;
  onReload?: () => void;
  /** Keep dialog/scrim inside the parent (specimens) */
  contained?: boolean;
  style?: any;
}
export declare function TikTokBlocked(props: TikTokBlockedProps): JSX.Element;
