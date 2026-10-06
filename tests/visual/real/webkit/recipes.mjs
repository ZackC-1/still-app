// How each T2 frame's state is reached on the BUILT page. The recorded native state (the case's
// `state`) is already behind the page; a recipe only waits for the page's own first render and
// then uses real input (clicks, key presses) inside the page. Nothing here writes product state
// or calls product functions.

/** The page has rendered settings (not the "Checking…" hold) and its fonts are in. */
async function settled(frame, ms = 700) {
  await frame.evaluate(() => document.fonts.ready);
  await frame.page().waitForTimeout(ms);
}

async function settingsReady(frame) {
  await frame.getByRole("switch", { name: "Still", exact: true }).waitFor({ timeout: 15_000 });
  await settled(frame);
}

async function park(page) {
  // No lingering :hover in the capture.
  await page.mouse.move(1, 1);
}

async function expand(frame, page, service) {
  await settingsReady(frame);
  await frame.getByRole("button", { name: `${service} Blocker`, exact: true }).click();
  await park(page);
  await settled(frame);
}

async function restore(frame, page) {
  await settingsReady(frame);
  await frame.getByRole("button", { name: "Restore purchase", exact: true }).click();
  await park(page);
  await settled(frame, 1200);
}

async function onboardingTo(frame, page, step) {
  await frame.getByRole("heading", { name: "Welcome to Still" }).waitFor({ timeout: 15_000 });
  const forward = [
    () => frame.getByRole("button", { name: "Continue", exact: true }).click(),
    () => frame.getByRole("button", { name: "I've turned it on", exact: true }).click(),
  ];
  for (let i = 1; i < step; i++) {
    await forward[i - 1]();
    await frame.page().waitForTimeout(400);
  }
  await park(page);
  await settled(frame);
}

export const recipes = {
  ready: async ({ frame }) => settingsReady(frame),
  "expand-youtube": async ({ frame, page }) => expand(frame, page, "YouTube"),
  "expand-facebook": async ({ frame, page }) => expand(frame, page, "Facebook"),
  restore: async ({ frame, page }) => restore(frame, page),
  "restore-then-expand-instagram": async ({ frame, page }) => {
    await restore(frame, page);
    await expand(frame, page, "Instagram");
  },
  // Real keyboard focus: Tab from the framing page into the web view until the Still switch has it.
  // WebKit follows the macOS rule that plain Tab skips buttons (Safari's default); Option-Tab
  // ("highlight each item", what a keyboard user on the Mac uses) moves through every control.
  "focus-still-switch": async ({ frame, page }) => {
    await settingsReady(frame);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Alt+Tab");
      const reached = await frame.evaluate(
        () => document.activeElement?.getAttribute("role") === "switch" && document.activeElement?.getAttribute("aria-label") === "Still",
      );
      if (reached) {
        await settled(frame, 300);
        return;
      }
    }
    throw new Error("Tab never reached the Still switch");
  },
  "onboarding-step-1": async ({ frame, page }) => onboardingTo(frame, page, 1),
  "onboarding-step-2": async ({ frame, page }) => onboardingTo(frame, page, 2),
  // The build's last step ("You're set"), which the reference numbers as step 4 of 4.
  "onboarding-last-step": async ({ frame, page }) => onboardingTo(frame, page, 3),
};
