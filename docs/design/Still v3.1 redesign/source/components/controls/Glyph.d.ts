/** Still's UI glyphs: 1.8px round-capped strokes in currentColor on a 20px grid. Decorative unless title is set. */
export interface GlyphProps {
  name: 'lock' | 'chevron' | 'check' | 'alert' | 'clock' | 'spinner' | 'external';
  size?: number;
  className?: string;
  /** Accessible name. Omit for decorative glyphs next to text. */
  title?: string;
}
export declare function Glyph(props: GlyphProps): JSX.Element;
