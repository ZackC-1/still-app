// Writes two Safari bookmarklets built from annotate.js, for captures on the iOS Simulator, the iPad
// Simulator and Safari on the Mac, where Playwright can't load the Safari extension:
//   "Still before": close any "open the app" nag and draw red marker marks on what Still removes
//   "Still after":  close any "open the app" nag
// Output: bookmarklets.html (open it in Safari and bookmark each link) and bookmarklets.txt.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { annotateScript } from "./annotate-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (js) => js.replace(/^\s*\/\/.*$/gm, "").replace(/\n\s+/g, "\n");
const toUrl = (js) => "javascript:" + encodeURIComponent(`(()=>{${strip(js)}})();void 0`);

const marks = { before: annotateScript({ mark: true }), after: annotateScript({ mark: false }) };
const links = Object.entries(marks).map(([name, js]) => ({ name: `Still ${name}`, url: toUrl(js) }));
writeFileSync(resolve(HERE, "bookmarklets.txt"), links.map((l) => `${l.name}\n${l.url}\n`).join("\n"));
writeFileSync(resolve(HERE, "bookmarklets.html"), `<!doctype html><meta charset="utf-8"><title>Still capture bookmarklets</title>
<meta name="viewport" content="width=device-width">
<style>body{font:17px -apple-system,system-ui;margin:24px;line-height:1.5}a{display:block;margin:12px 0;font-size:22px}textarea{width:100%;height:90px}</style>
<p>Bookmark each link (Share → Add Bookmark), then edit the bookmark and paste the matching address below.</p>
${links.map((l) => `<a href="${l.url}">${l.name}</a><textarea readonly>${l.url}</textarea>`).join("\n")}`);
for (const l of links) console.log(l.name, l.url.length, "chars");
