/**
 * The Still lockup: balance mark + st·ll wordmark. Once per surface, in the app bar. Not in the compact popup.
 * @startingPoint section="Brand" subtitle="Balance mark and st·ll wordmark" viewport="700x140"
 */
export interface LogoProps {
  /** Balance mark alone, no wordmark (TikTok blocked page) */
  markOnly?: boolean;
  /** Mark size in px (default 28 via --logo-mark-size); wordmark scales with it */
  size?: number;
  /** 24px mark / 18px word */
  compact?: boolean;
}
export declare function Logo(props: LogoProps): JSX.Element;
