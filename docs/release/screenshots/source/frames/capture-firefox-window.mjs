// The Still popup open in a real Firefox window, for the AMO listing's "one switch per site" image.
// Launches the installed Firefox.app with a fresh profile, installs the Firefox build of Still as a
// temporary add-on, opens YouTube, and waits for someone to click Still's toolbar icon. When the popup
// appears it captures the whole window (macOS screencapture) and quits Firefox.
//   node docs/release/screenshots/source/frames/capture-firefox-window.mjs
// Needs Screen Recording permission for the terminal. Writes captures/firefox/window-popup.png.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installStill } from "./firefox-rdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "../../../../../packages/ext-chromium/dist/firefox-mv3");
const OUT = resolve(HERE, "captures/firefox/window-popup.png");
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const PORT = 12347;
const URL = "https://www.youtube.com/results?search_query=pasta+recipe";
const PROFILE = resolve(tmpdir(), "still-firefox-capture-profile");
const WINLIST = resolve(tmpdir(), "still-winlist");

// A quiet first run: no welcome tabs, no default-browser prompt, no bookmarks bar.
const PREFS = {
  "devtools.debugger.remote-enabled": true,
  "devtools.debugger.prompt-connection": false,
  "devtools.chrome.enabled": true,
  "browser.aboutwelcome.enabled": false,
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "startup.homepage_welcome_url": "",
  "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "browser.toolbars.bookmarks.visibility": "never",
  "browser.tabs.warnOnClose": false,
  "sidebar.revamp": false,
  "sidebar.verticalTabs": false,
  "browser.translations.automaticallyPopup": false,
};

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
writeFileSync(resolve(PROFILE, "user.js"), Object.entries(PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));
execFileSync("swiftc", ["-O", resolve(HERE, "tools/winlist.swift"), "-o", WINLIST]);

const windows = () => execFileSync(WINLIST, ["Firefox"]).toString().trim().split("\n").filter(Boolean)
  .map((l) => { const [id, layer, x, y, w, h] = l.split(" ").map(Number); return { id, layer, x, y, w, h }; });

// A separate instance (-no-remote), so any Firefox you already have open is left alone. Firefox injects
// an add-on's content scripts into tabs that are already open, so YouTube is cleared once Still loads.
const ff = spawn(FIREFOX, ["-profile", PROFILE, "-no-remote", "-new-instance", "-start-debugger-server", String(PORT), URL], { stdio: "ignore" });
await installStill(PORT, EXT);
try {
  execFileSync("osascript", ["-e", 'tell application "Firefox" to set bounds of front window to {60, 60, 1500, 960}']);
} catch { console.log("(could not resize the window; capturing it at its own size)"); }
console.log("Firefox is open with Still installed. Click the Still icon in Firefox's toolbar to open its popup.");

// Wait for the popup: a small Firefox window above the main one.
let popup;
for (let i = 0; i < 2400 && !popup; i++) {
  await new Promise((r) => setTimeout(r, 500));
  popup = windows().find((w) => w.w < 520 && w.h > 250);
}
if (!popup) { console.log("No popup seen in 20 minutes; giving up."); ff.kill(); process.exit(1); }
await new Promise((r) => setTimeout(r, 1200));
const main = windows().sort((a, b) => b.w * b.h - a.w * a.h)[0];
mkdirSync(dirname(OUT), { recursive: true });
execFileSync("screencapture", ["-x", `-R${main.x},${main.y},${main.w},${main.h}`, OUT]);
console.log("captured", OUT, JSON.stringify({ main, popup }));
ff.kill();
