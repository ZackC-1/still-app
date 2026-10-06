import type { TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_ROOT, redact } from "../qa/shared/evidence.js";
import type { Tab } from "./_session.js";
import { FirefoxChrome } from "./_qa-capture.js";
import type { StillFirefox } from "./_session.js";
import { storeDump } from "./_qa-session.js";

// Evidence a Firefox journey leaves behind, in the same tree and with the same redaction as the
// Chrome lane (tests/qa/.output/evidence/<cell>/, gitignored). Screenshots are Firefox's own 2x
// window snapshot of the real page, because BiDi refuses screenshots on extension pages.
export class FirefoxEvidence {
  private count = 0;
  readonly dir: string;

  constructor(
    readonly cell: string,
    testInfo: TestInfo,
    private readonly firefox: StillFirefox,
  ) {
    const slug = testInfo.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    this.dir = join(EVIDENCE_ROOT, cell, slug);
    mkdirSync(this.dir, { recursive: true });
  }

  private next(step: string): string {
    this.count += 1;
    return join(
      this.dir,
      `${String(this.count).padStart(2, "0")}-${step.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    );
  }

  /** A 2x snapshot of the tab showing `urlPart`, at `size` CSS px (the tab is framed to that size). */
  async shot(
    urlPart: string,
    step: string,
    size = { width: 600, height: 900 },
  ): Promise<void> {
    const chrome = await FirefoxChrome.attach(this.firefox.bidi);
    await chrome.frameTab(urlPart, size);
    writeFileSync(
      `${this.next(step)}.png`,
      await chrome.snapshotTab(urlPart, size),
    );
    await chrome.unframeTab(urlPart);
  }

  /** The real toolbar popup, at its own size. */
  async popupShot(step: string): Promise<void> {
    const chrome = await FirefoxChrome.attach(this.firefox.bidi);
    await chrome.openPopup();
    writeFileSync(`${this.next(step)}.png`, (await chrome.snapshotPopup()).png);
    await chrome.closePopup();
  }

  /** Every still:* key in extension storage, with sensitive values redacted. */
  async storage(step: string): Promise<Record<string, unknown>> {
    const dump = await storeDump(this.firefox);
    writeFileSync(
      `${this.next(step)}.storage.json`,
      `${JSON.stringify(dump, null, 2)}\n`,
    );
    return dump;
  }

  log(step: string, entries: unknown): void {
    writeFileSync(
      `${this.next(step)}.json`,
      `${JSON.stringify(redact(entries), null, 2)}\n`,
    );
  }
}

export type { Tab };
