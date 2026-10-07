/** The Still switch. 52×31 (small 40×24) drawn, 44px minimum hit area. Disabled stays focusable (aria-disabled) so screen readers can find it and hear why. */
export interface ToggleProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  /** Accessible name when there is no visible label to point at */
  label?: string;
  /** id of the visible label (preferred) */
  labelledBy?: string;
  /** id of the supporting line (state, reason it's disabled) */
  describedBy?: string;
  /** Shows the saved state but ignores input. Keeps focus. */
  disabled?: boolean;
  /** on-blue = inside the blue hero card */
  variant?: 'default' | 'on-blue';
  size?: 'default' | 'small';
}
export declare function Toggle(props: ToggleProps): JSX.Element;
