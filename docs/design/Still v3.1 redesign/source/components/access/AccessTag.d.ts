/** Names a control's access state in words (+ lock/clock/alert glyph). Free renders nothing. Never colored: access is not a status. */
export interface AccessTagProps {
  state: 'free' | 'protected' | 'purchased' | 'checking' | 'verify' | 'locked' | 'unsupported';
  /** Override the default words */
  label?: string;
  boxed?: boolean;
}
export declare function AccessTag(props: AccessTagProps): JSX.Element | null;
