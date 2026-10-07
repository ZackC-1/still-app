/** Restore purchase outcome (D25). "nothing" only after a conclusive answer; network/provider uncertainty is "failed" or "checking". */
export interface RestoreStatusProps {
  state?: 'checking' | 'restored' | 'nothing' | 'failed' | 'verify';
  /** Retry (failed) or verify (verify) */
  onAction?: () => void;
  announce?: boolean;
}
export declare function RestoreStatus(props: RestoreStatusProps): JSX.Element;
