import { createHash } from "node:crypto";
import http from "node:http";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_INPUTS = [
  [
    "https://unpkg.com/react@18.3.1/umd/react.development.js",
    "sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L",
  ],
  [
    "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js",
    "sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm",
  ],
  [
    "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js",
    "sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y",
  ],
];
const BROKEN_WORDMARK =
  "e5db1c83cfe4f18d8c77c3bccf3e402b7637036b5a4d994ed3459c41d067e796";
const SHARED_WORDMARK =
  "bc0e9c6c271d7cc632505126c74bfb75024ab15d4ab3b55d5c727bb52318d45b";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELECTOR = ".r-device, .p-frame, .g-frame, [data-asset]";
const EXPECTED_COUNTS = [33, 11, 12, 14, 10, 10, 7, 24, 9, 14];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) =>
  path === root ||
  (!relative(root, path).startsWith("..") && !isAbsolute(relative(root, path)));
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--icons" && args.icons === undefined) {
      args.icons = true;
      continue;
    }
    const name = {
      "--package": "package",
      "--cache": "cache",
      "--output": "output",
    }[flag];
    if (
      !name ||
      args[name] !== undefined ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw new Error(
        "Supply --package, --cache and --output once each; only optional --icons is accepted",
      );
    args[name] = resolve(argv[++i]);
  }
  if (![args.package, args.cache, args.output].every(Boolean))
    throw new Error("Explicit --package, --cache and --output are required");
  return args;
}

export function validateVersions(tokens, spacing, screens) {
  const css = spacing.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = [
    ...css.matchAll(/--ds-version\s*:\s*(['"])([^'"]+)\1\s*;/g),
  ];
  if (
    tokens?.version !== "3.0.1" ||
    screens?.version !== "3.0.1" ||
    [...css.matchAll(/--ds-version\s*:/g)].length !== 1 ||
    declarations.length !== 1 ||
    declarations[0][2] !== "3.0.1"
  )
    throw new Error(
      "Source tokens, screens and exactly one CSS version must identify latest design 3.0.1",
    );
}

export function verifyIntegrity(bytes, integrity) {
  if (
    integrity !==
    `sha384-${createHash("sha384").update(bytes).digest("base64")}`
  )
    throw new Error("Pinned cached input integrity mismatch");
}

/** Record all source bytes, including supplied references; dependencies are independently resolved. */
export async function snapshot(root) {
  root = await realpath(root);
  const files = [];
  async function visit(directory) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      const actual = await realpath(path);
      if (!inside(root, actual))
        throw new Error(
          `Source symlink escapes package: ${relative(root, path)}`,
        );
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() ||
        (entry.isSymbolicLink() && (await lstat(actual)).isFile())
      )
        files.push({
          path: relative(root, path),
          sha256: digest(await readFile(path)),
        });
      else throw new Error(`Unsupported source entry: ${relative(root, path)}`);
    }
  }
  await visit(root);
  return files;
}

export async function reserveOutput(pkg, cache, requested) {
  [pkg, cache] = await Promise.all([realpath(pkg), realpath(cache)]);
  const output = join(
    await realpath(dirname(requested)),
    requested.slice(dirname(requested).length + 1),
  );
  if (inside(pkg, output) || inside(cache, output))
    throw new Error("Output must be outside the source package and cache");
  // Nonrecursive mkdir is exclusive: existing directories/files/symlinks are never reused.
  await mkdir(output);
  return output;
}

export async function staticBytes(pkg, pathname, inputs) {
  pkg = await realpath(pkg);
  const decoded = decodeURIComponent(pathname);
  if (
    !decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").includes("..")
  )
    throw new Error("Invalid source request path");
  const path = resolve(pkg, `.${decoded}`);
  const actual = await realpath(path);
  if (!inside(pkg, actual)) throw new Error("Source request escapes package");
  const recorded = inputs.find((file) => file.path === relative(pkg, path));
  const bytes = await readFile(path);
  if (!recorded || digest(bytes) !== recorded.sha256)
    throw new Error("Source request not in unchanged input snapshot");
  return bytes;
}

export function assertFontEvidence(faces, rendered) {
  if (
    !faces.some(
      (face) =>
        face.family.replace(/["']/g, "") === "InterVariable" &&
        face.status === "loaded",
    ) ||
    !rendered.some(
      (font) =>
        font.isCustomFont === true &&
        /^Inter(?:\s?Variable)?$/i.test(font.familyName) &&
        font.glyphCount > 0,
    )
  )
    throw new Error(
      "InterVariable did not load and render actual glyphs; fallback fonts are not a PASS",
    );
}

export function assertPngDimensions(image, box) {
  if (
    ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.width <= 0 ||
    box.height <= 0
  )
    throw new Error("Invalid screenshot bounding box");
  const width = (Math.ceil(box.x + box.width) - Math.floor(box.x)) * 2;
  const height = (Math.ceil(box.y + box.height) - Math.floor(box.y)) * 2;
  if (image.width !== width || image.height !== height)
    throw new Error(
      `Decoded PNG ${image.width}x${image.height} must be ${width}x${height} at DSF2`,
    );
}

export async function prepareInputs(args) {
  const pkg = await realpath(args.package),
    cache = await realpath(args.cache);
  const source = await snapshot(pkg);
  const screens = JSON.parse(
    await readFile(join(pkg, "handoff/screens.json"), "utf8"),
  );
  validateVersions(
    JSON.parse(await readFile(join(pkg, "tokens/tokens.json"), "utf8")),
    await readFile(join(pkg, "tokens/spacing.css"), "utf8"),
    screens,
  );
  if (
    !Array.isArray(screens.pages) ||
    screens.pages.length !== EXPECTED_COUNTS.length ||
    new Set(screens.pages.map((page) => page.page)).size !==
      screens.pages.length
  )
    throw new Error("Latest capture requires ten distinct declared pages");
  for (const page of screens.pages) {
    if (
      typeof page.name !== "string" ||
      !Array.isArray(page.frames) ||
      typeof page.page !== "string" ||
      !page.page.endsWith(".html")
    )
      throw new Error("Invalid source screen declaration");
    await staticBytes(pkg, `/${page.page}`, source);
  }
  const libraries = await Promise.all(
    PINNED_INPUTS.map(async ([url, integrity], index) => {
      const path = join(cache, `${index}.js`);
      if (!inside(cache, await realpath(path)))
        throw new Error("Cached input symlink escapes cache");
      const bytes = await readFile(path);
      verifyIntegrity(bytes, integrity);
      return { url, integrity, path, sha256: digest(bytes), bytes };
    }),
  );
  const wordmarkPath = join(REPO, "packages/core/src/ui/assets/wordmark.ts");
  const urls = (text) =>
    [...text.matchAll(/["'](data:image\/png;base64,[^"']+)["']/g)].map(
      (match) => match[1],
    );
  const broken = urls(
    await readFile(join(pkg, "components/brand/wordmarkData.js"), "utf8"),
  );
  const replacementBytes = await readFile(wordmarkPath),
    replacement = urls(replacementBytes.toString("utf8"));
  if (
    broken.length !== 1 ||
    replacement.length !== 1 ||
    digest(broken[0]) !== BROKEN_WORDMARK ||
    digest(replacement[0]) !== SHARED_WORDMARK
  )
    throw new Error(
      "Wordmark substitution is limited to the exact known broken URL and verified existing shared asset",
    );
  return {
    pkg,
    cache,
    source,
    screens,
    libraries,
    wordmarkPath,
    replacementBytes,
    broken: broken[0],
    replacement: replacement[0],
    tool: {
      path: fileURLToPath(import.meta.url),
      sha256: digest(await readFile(fileURLToPath(import.meta.url))),
    },
  };
}

export async function assertInputsStable(inputs) {
  if (
    inputs.tool &&
    digest(await readFile(inputs.tool.path)) !== inputs.tool.sha256
  )
    throw new Error("Capture tool changed during capture");
  if (
    JSON.stringify(await snapshot(inputs.pkg)) !== JSON.stringify(inputs.source)
  )
    throw new Error("Source inputs changed during capture");
  for (const library of inputs.libraries) {
    if (
      !inside(await realpath(inputs.cache), await realpath(library.path)) ||
      digest(await readFile(library.path)) !== library.sha256
    )
      throw new Error("Cached inputs changed during capture");
  }
  if (
    digest(await readFile(inputs.wordmarkPath)) !==
    digest(inputs.replacementBytes)
  )
    throw new Error("Shared wordmark changed during capture");
}

export async function startServer(server) {
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
}

export async function closeResources(browser, server) {
  let failure;
  try {
    await browser?.close();
  } catch (error) {
    failure = error;
  }
  try {
    if (server.listening)
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

export async function capture(args) {
  const inputs = await prepareInputs(args);
  const require = createRequire(import.meta.url);
  const { chromium } = require("@playwright/test");
  const tooling = createRequire(join(inputs.pkg, "handoff/package.json"));
  const { PNG } = tooling("pngjs");
  const output = await reserveOutput(inputs.pkg, inputs.cache, args.output);
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".babel": "text/plain",
    ".jsx": "text/plain",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET") throw new Error("Read-only capture server");
      const path = new URL(req.url, "http://localhost").pathname;
      const body = await staticBytes(inputs.pkg, path, inputs.source);
      res.writeHead(200, {
        "content-type": types[extname(path)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  let browser, failure;
  const receipt = {
    tool: {
      ...inputs.tool,
      playwrightVersion: require("@playwright/test/package.json").version,
      pngjsVersion: tooling("pngjs/package.json").version,
    },
    designVersion: "3.0.1",
    deviceScaleFactor: 2,
    viewport: { width: 1440, height: 1000 },
    platform: process.platform,
    source: {
      package: inputs.pkg,
      files: inputs.source,
      sha256: digest(JSON.stringify(inputs.source)),
    },
    libraries: inputs.libraries.map(({ url, integrity, path, sha256 }) => ({
      url,
      integrity,
      path,
      sha256,
    })),
    wordmark: {
      brokenDataUrlSha256: BROKEN_WORDMARK,
      replacementDataUrlSha256: SHARED_WORDMARK,
      sharedSource: inputs.wordmarkPath,
      sharedSourceSha256: digest(inputs.replacementBytes),
      scope: "Exact matching image src only; source package unchanged",
    },
    declaredTemplateCount: inputs.screens.pages.reduce(
      (n, page) => n + page.frames.length,
      0,
    ),
    pages: [],
    frames: [],
    supplements: [],
  };
  try {
    await startServer(server);
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    receipt.engine = "Chromium";
    receipt.engineVersion = browser.version();
    const context = await browser.newContext({
      viewport: receipt.viewport,
      deviceScaleFactor: 2,
      serviceWorkers: "block",
    });
    const blocked = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url(),
        library = inputs.libraries.find((item) => item.url === url);
      if (library)
        return route.fulfill({
          body: library.bytes,
          contentType: "text/javascript",
          headers: { "access-control-allow-origin": "*" },
        });
      if (new URL(url).origin === origin) return route.continue();
      blocked.push(url);
      await route.abort();
    });
    await context.routeWebSocket("**", (socket) => {
      blocked.push(socket.url());
      socket.close();
    });
    const inventory = [],
      contextInventory = [];
    for (const [pageIndex, item] of inputs.screens.pages.entries()) {
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/${item.page}`, { waitUntil: "networkidle" });
      const faces = await page.evaluate(async () => {
        await document.fonts.load('14px "InterVariable"', "Still settings");
        await document.fonts.ready;
        return [...document.fonts].map((font) => ({
          family: font.family,
          status: font.status,
        }));
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const document = await cdp.send("DOM.getDocument");
      const textIndex = await page.evaluate(() =>
        [...document.querySelectorAll("body *")].findIndex(
          (element) =>
            getComputedStyle(element).fontFamily.includes("InterVariable") &&
            [...element.childNodes].some(
              (node) =>
                node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
            ),
        ),
      );
      const nodes = await cdp.send("DOM.querySelectorAll", {
        nodeId: document.root.nodeId,
        selector: "body *",
      });
      const rendered =
        textIndex >= 0
          ? (
              await cdp.send("CSS.getPlatformFontsForNode", {
                nodeId: nodes.nodeIds[textIndex],
              })
            ).fonts
          : [];
      (receipt.fontObservations ??= []).push({
        page: item.page,
        faces,
        rendered,
        textElementIndex: textIndex,
      });
      assertFontEvidence(faces, rendered);
      const substitutions = await page.evaluate(
        ({ broken, replacement }) => {
          let count = 0;
          for (const image of document.images)
            if (image.getAttribute("src") === broken) {
              image.src = replacement;
              count++;
            }
          return count;
        },
        { broken: inputs.broken, replacement: inputs.replacement },
      );
      await page.evaluate(async () => {
        await Promise.all([...document.images].map((image) => image.decode()));
        // The supplied handoff capture normalizes store-asset preview transforms to native size.
        document.querySelectorAll("[data-asset]").forEach((element) => {
          element.style.transform = "none";
          const wrapper = element.parentElement;
          wrapper.style.width = element.style.width;
          wrapper.style.height = element.style.height;
          wrapper.parentElement.style.width = "auto";
        });
      });
      const frames = await page.$$(SELECTOR);
      if (
        frames.length !== EXPECTED_COUNTS[pageIndex] ||
        errors.length ||
        blocked.length
      )
        throw new Error(
          `Reference page ${item.name}: ${frames.length} frames, ${errors.length} script errors, ${blocked.length} blocked outbound requests`,
        );
      const folder = join(output, "references", slug(item.name));
      await mkdir(folder, { recursive: true });
      const pageFrames = [],
        pageContexts = [];
      async function save(frame, index, supplement = false) {
        await frame.scrollIntoViewIfNeeded();
        const info = await frame.evaluate((element) => {
          const pane = element.closest(".r-pane, .p-pane, .g-pane"),
            style = getComputedStyle(element),
            box = element.getBoundingClientRect();
          return {
            caption: (
              pane?.querySelector(".cap")?.textContent ||
              element.id ||
              "frame"
            ).trim(),
            bounding_box: {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            },
            fontFamily: style.fontFamily,
            render: {
              theme:
                element.closest("[data-theme]")?.getAttribute("data-theme") ??
                "light",
              text_scale: style.getPropertyValue("--text-scale").trim(),
            },
            ui: [
              ...element.querySelectorAll(
                '[style*="--text-scale"], .popup, .settings, .first-run',
              ),
            ].map((node) => ({
              textScale: getComputedStyle(node)
                .getPropertyValue("--text-scale")
                .trim(),
            })),
          };
        });
        const name = supplement
          ? "15-d45-app-extension-favicon-icons.png"
          : `${String(index).padStart(2, "0")}-${slug(info.caption)}.png`;
        const bytes = await frame.screenshot({ animations: "disabled" });
        const png = PNG.sync.read(bytes);
        assertPngDimensions(png, info.bounding_box);
        await writeFile(join(folder, name), bytes, { flag: "wx" });
        const entry = {
          page: item.page,
          index,
          output: name,
          ...info,
          path: `references/${slug(item.name)}/${name}`,
          sha256: digest(bytes),
          pixelWidth: png.width,
          pixelHeight: png.height,
        };
        if (supplement)
          receipt.supplements.push({
            ...entry,
            kind: "D45 icon-page supplement; outside the 144 primary DOM frames",
          });
        else {
          receipt.frames.push(entry);
          pageFrames.push(entry);
          pageContexts.push({ output: name, section: { ui: info.ui } });
        }
      }
      for (const [index, frame] of frames.entries())
        await save(frame, index + 1);
      if (args.icons && item.page.endsWith("/store-assets.html")) {
        const icons = await page
          .locator("section.r-sec")
          .filter({ has: page.locator(".r-meta p", { hasText: "D45" }) })
          .elementHandles();
        if (icons.length !== 1)
          throw new Error(
            "Expected one separately labeled D45 icon-page supplement",
          );
        await save(icons[0], 15, true);
      }
      receipt.pages.push({
        name: item.name,
        page: item.page,
        count: frames.length,
        fontFaces: faces,
        renderedFonts: rendered,
        wordmarkSubstitutions: substitutions,
        errors,
      });
      inventory.push({ name: item.name, page: item.page, frames: pageFrames });
      contextInventory.push({
        name: item.name,
        page: item.page,
        frames: pageContexts,
      });
      console.log(`${item.name}: ${frames.length} primary frames`);
      await page.close();
    }
    if (
      receipt.frames.length !== 144 ||
      (args.icons && receipt.supplements.length !== 1)
    )
      throw new Error("Reference inventory count mismatch");
    await assertInputsStable(inputs);
    receipt.sourceAfterSha256 = receipt.source.sha256;
    receipt.inputsUnchanged = true;
    receipt.blockedOutbound = blocked;
    await writeFile(
      join(output, "references/render-inventory.json"),
      JSON.stringify(
        { design_version: "3.0.1", device_scale_factor: 2, inventory },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    await writeFile(
      join(output, "references/frame-context-inventory.json"),
      JSON.stringify({ inventory: contextInventory }, null, 2) + "\n",
      { flag: "wx" },
    );
  } catch (error) {
    failure = error;
  }
  try {
    await closeResources(browser, server);
  } catch (error) {
    if (failure) receipt.cleanupError = error.message;
    else failure = error;
  }
  if (!failure) {
    try {
      await writeFile(
        join(output, "capture-receipt.json"),
        JSON.stringify(receipt, null, 2) + "\n",
        { flag: "wx" },
      );
    } catch (error) {
      failure = error;
    }
  }
  if (failure) {
    await writeFile(
      join(output, "capture-failure.json"),
      JSON.stringify(
        { status: "FAILED", error: failure.message, receipt },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    throw failure;
  }
  console.log(
    `PASS 144 primary frames; ${receipt.supplements.length} separately labeled supplements; inputs unchanged`,
  );
  return receipt;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await capture(argumentsFor(process.argv.slice(2)));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
