/**
 * Private owner rating view: global + per-surface rating-prompt allowances, current vs draft, preview, Apply with readback, stale and failure recovery. Not a customer surface.
 */
export interface OwnerAllowancesProps {
  surfaces?: { id: string; name: string; deferred?: boolean }[];
  /** Server state, keyed by surface id plus 'global' */
  current?: Record<string, boolean>;
  draft?: Record<string, boolean>;
  onDraftChange?: (draft: Record<string, boolean>) => void;
  state?: 'idle' | 'applying' | 'readback' | 'applied' | 'stale' | 'failed';
  onApply?: () => void;
  onDiscard?: () => void;
  /** Reload (stale) or retry (failed) */
  onStatusAction?: () => void;
  announce?: boolean;
}
export declare function OwnerAllowances(props: OwnerAllowancesProps): JSX.Element;
