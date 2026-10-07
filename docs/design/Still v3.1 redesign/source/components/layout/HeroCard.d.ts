/**
 * The global on/off card: the only large blue area in the app. One per page.
 * @startingPoint section="Layout" subtitle="Global on/off card, on and off" viewport="700x260"
 */
export interface HeroCardProps {
  on?: boolean;
  onChange?: (next: boolean) => void;
  /** Popup: one line at 18px, no supporting sentence */
  compact?: boolean;
  /** Defaults to "Still is active" / "Still is off" */
  title?: string;
  /** Defaults to the shipped supporting line for each state */
  body?: string;
}
export declare function HeroCard(props: HeroCardProps): JSX.Element;
