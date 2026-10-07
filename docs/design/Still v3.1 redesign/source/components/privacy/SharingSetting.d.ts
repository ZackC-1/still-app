/** The continuing per-device sharing switch (D36) with truthful withdrawal/deletion progress. A request accepted is not a deletion completed. */
export interface SharingSettingProps {
  checked?: boolean;
  onChange?: (next: boolean) => void;
  withdrawal?: 'none' | 'requested' | 'verifying' | 'deleted' | 'failed';
  onRequestDeletion?: () => void;
  onRetry?: () => void;
  title?: string;
  sub?: string;
  announce?: boolean;
}
export declare function SharingSetting(props: SharingSettingProps): JSX.Element;
