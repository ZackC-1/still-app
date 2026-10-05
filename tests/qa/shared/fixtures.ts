import { test as base, expect } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { Evidence, recordNetwork, type NetworkEntry } from "./evidence.js";
import { extensionIdOf, launchExtension } from "./launch.mjs";

// The qa project's test object: a fresh Chromium profile with the built extension, at 2x, plus
// evidence capture and a network log. Everything a journey does goes through real pages, real
// storage and real extension messages.

type QaFixtures = {
  colorScheme: "light" | "dark";
  context: BrowserContext;
  extensionId: string;
  network: { entries: NetworkEntry[]; external(): NetworkEntry[] };
  evidence: (cell: string) => Evidence;
};

// The recorder is attached inside the context fixture, immediately after launch and before the
// service worker is awaited, so requests made during startup are in the log.
const recorders = new WeakMap<BrowserContext, ReturnType<typeof recordNetwork>>();

export const test = base.extend<QaFixtures>({
  colorScheme: ["light", { option: true }],
  context: async ({ colorScheme }, use) => {
    const context = await launchExtension({ colorScheme });
    recorders.set(context, recordNetwork(context));
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    await use(await extensionIdOf(context));
  },
  network: async ({ context }, use) => {
    await use(recorders.get(context)!);
  },
  evidence: async ({}, use, testInfo) => { // eslint-disable-line no-empty-pattern
    await use((cell: string) => new Evidence(cell, testInfo));
  },
});

export { expect };
