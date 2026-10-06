import type { BrowserContext, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Recorded HTML only: no QA journey visits a real site. A fixture answers the request that would
// have gone to the service, so the extension sees the real host name and the real page markup.

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

export const fixture = (name: string): string => readFileSync(resolve(FIXTURE_DIR, name), "utf8");

export async function serveFixture(target: BrowserContext | Page, glob: string, name: string): Promise<void> {
  const body = fixture(name);
  await target.route(glob, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body }));
}

export const FIRST_RUN = /^chrome-extension:\/\/[a-p]{32}\/first-run\.html$/;
