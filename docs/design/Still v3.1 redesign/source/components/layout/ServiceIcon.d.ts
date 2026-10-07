/**
 * A supported service's own mark (48px rounded square; Facebook is a disc). Keeps its own brand colors.
 */
export interface ServiceIconProps {
  service: 'youtube' | 'instagram' | 'tiktok' | 'facebook';
  /** px; omit to fill the parent (.icon slot, 42px / 32px compact) */
  size?: number;
}
export declare function ServiceIcon(props: ServiceIconProps): JSX.Element;
