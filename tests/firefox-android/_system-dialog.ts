// Android's own "<app> isn't responding" dialog, read from a uiautomator dump. Pure, so it is unit
// tested outside the emulator (packages/ext-chromium/lib/__tests__/android-system-dialog.test.ts).
//
// A busy emulator sometimes shows this dialog for an unrelated app (seen once with the Pixel
// Launcher); the spike answers "Wait" and carries on. When the dialog names Firefox itself, Firefox
// has hung, which is exactly what the spike must report, so it is never dismissed.

export interface DialogNode {
  readonly text: string;
  readonly packageName: string;
  readonly center: { readonly x: number; readonly y: number };
}

export interface NotRespondingDialog<N extends DialogNode = DialogNode> {
  /** The app the dialog names, e.g. "Pixel Launcher". */
  readonly app: string;
  /** True when the named app is Firefox (release, beta, Nightly or Fenix). */
  readonly firefox: boolean;
  /** The dialog's "Wait" button, when present. */
  readonly wait: N | undefined;
}

const TITLE = /^(.+?)\s+isn.t responding$/;
const FIREFOX_APP = /firefox|fenix|nightly|mozilla/i;

/** The "isn't responding" dialog on screen, or null when there is none. */
export function notRespondingDialog<N extends DialogNode>(nodes: readonly N[]): NotRespondingDialog<N> | null {
  for (const node of nodes) {
    if (node.packageName !== "android") continue;
    const title = TITLE.exec(node.text.trim());
    if (!title) continue;
    const app = title[1]!;
    return {
      app,
      firefox: FIREFOX_APP.test(app),
      wait: nodes.find((n) => n.packageName === "android" && n.text.trim() === "Wait"),
    };
  }
  return null;
}
