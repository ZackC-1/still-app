/**
 * One control inside a site section (D07). Saved intention (checked), access rights (access) and host capability (unsupported) stay separate.
 * Inactive (global or service Off) shows the saved choice greyed and never rewrites it.
 */
export interface SwitchRowProps {
  id?: string;
  label: string;
  /** What stays: the boundary line from the inventory */
  sub?: string;
  /** The saved choice. New optional controls start false. */
  checked?: boolean;
  onChange?: (next: boolean) => void;
  access?: 'free' | 'protected' | 'purchased' | 'checking' | 'verify' | 'locked' | 'unsupported';
  /** Global or service Off: shows saved state, ignores input */
  inactive?: boolean;
  inactiveNote?: string;
  host?: 'browser' | 'safari' | 'apple';
  /** Reviewed affected-browser unavailability text */
  unavailableNote?: string;
  /** Locked: the right-aligned lock + "Still Pro" button (browser/Apple: open the offer; Safari: open the Still app). Verify: the Verify link. */
  onAccessAction?: () => void;
}
export declare function SwitchRow(props: SwitchRowProps): JSX.Element;
