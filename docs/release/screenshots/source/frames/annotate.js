// Prepares a live page for a store capture. Runs in the page: Playwright injects it on desktop, and a
// bookmarklet built from it (build-bookmarklet.mjs) runs it in Safari on the Simulator and the Mac.
//
//   blur: off by default (the owner chose real, unblurred pages, 2026-09-24). When asked for, blurs
//         other people's pictures, faces, names and captions, keeping navigation and Still's UI sharp.
//   mark: on a "before" shot (Still off), draws a hand-drawn red marker over each element Still
//         would remove. The selectors come from the shipped rule set (packages/core/rules/seed.json),
//         so a mark can only land on something Still actually takes away: rules that hide an entry
//         point (a tab, a chip, a nav link) get a circle, rules that remove a block (a shelf, a Reel
//         in the feed) get an X.
//
// Uses no innerHTML (Facebook and Instagram enforce Trusted Types) and no network requests.
(function () {
  "use strict";
  const RED = "#f5222d";
  const SVGNS = "http://www.w3.org/2000/svg";

  const BLUR = {
    youtube: `
      ytd-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelImage, yt-image, img.yt-core-image,
      #avatar, yt-img-shadow, yt-avatar-shape, ytm-profile-icon, .media-item-thumbnail-container img,
      ytm-shorts-lockup-view-model img, video, .ytp-cued-thumbnail-overlay-image,
      .html5-video-container { filter: blur(9px) !important; }
      ytd-video-renderer .text-wrapper, ytd-video-renderer #meta, ytd-video-renderer #dismissible > div:not(ytd-thumbnail),
      ytm-shorts-lockup-view-model h3, .shortsLockupViewModelHostOutsideMetadata, .shortsLockupViewModelHostMetadata,
      yt-lockup-metadata-view-model, ytd-channel-renderer, ytd-universal-watch-card-renderer,
      ytd-horizontal-card-list-renderer #items, ytd-rich-grid-media #details, .media-item-metadata,
      ytm-video-with-context-renderer .details, ytm-rich-item-renderer .details, #owner, #description,
      ytd-watch-metadata h1, #comments { filter: blur(5px) !important; }`,
    instagram: `
      main img, main video, article img, article video, header img, section img, div[role="dialog"] img,
      canvas { filter: blur(10px) !important; }
      article span[dir="auto"], article h1, article h2, article time, article a[role="link"] > span,
      article ul span, main header section span, main header section h2, main header section h1,
      section ul li span[dir="auto"], [role="dialog"] span[dir="auto"] { filter: blur(5px) !important; }`,
    facebook: `
      [role="main"] img, [role="main"] image, [role="main"] video, [role="complementary"] img,
      [role="complementary"] image, [role="navigation"] img, [role="navigation"] image, svg image,
      [role="article"] img, [role="article"] video { filter: blur(10px) !important; }
      [role="article"] span[dir="auto"], [role="article"] strong, [role="article"] h2, [role="article"] h3,
      [role="article"] h4, [role="article"] a[role="link"] span, [role="complementary"] span[dir="auto"],
      [data-pagelet*="Stories"] span, [role="navigation"] ul li a[href*="/profile.php"] span,
      [role="main"] [aria-label*="Stories" i] span { filter: blur(5px) !important; }`,
    tiktok: `
      video, img, canvas, [class*="DivVideoPlayerContainer"], [class*="Poster"] { filter: blur(12px) !important; }
      [data-e2e*="video-desc"], [data-e2e*="author"], [data-e2e*="video-music"], [data-e2e*="browse-username"],
      [data-e2e*="comment"], [class*="DivAuthor"], [class*="Description"], article h1, article h2,
      article h3, [data-e2e="recommend-list-item-container"] a[href*="/@"], main a[href*="/@"],
      [class*="author" i], [class*="nickname" i], [class*="username" i], [class*="desc" i], [class*="caption" i],
      [class*="music" i] { filter: blur(5px) !important; }`,
  };

  // Blocks that fill a whole region are crossed out even when their rule "hides" rather than "removes".
  // Entry points (a tab, a chip, a menu row) get a loop; anything bigger is crossed out picture by picture.
  const isSmall = (r) => (r.width < 260 && r.height < 140) || (r.height < 70 && r.width < 420);

  // Deterministic noise so the same page renders the same marks every time.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function serviceFor(host) {
    if (/(^|\.)youtube\.com$/.test(host)) return "youtube";
    if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
    if (/(^|\.)facebook\.com$/.test(host)) return "facebook";
    if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
    return null;
  }

  function query(sel) {
    try { return [...document.querySelectorAll(sel)]; } catch { return []; } // :has() on old engines
  }

  // Elements Still would take away, outermost first, visible in the viewport, one entry per element.
  function targets(rules, extra) {
    const found = [];
    for (const rule of rules) {
      for (const sel of rule.selectors) {
        for (const el of query(sel)) found.push({ el, kind: rule.action === "hide" ? "circle" : "x" });
      }
    }
    for (const t of extra) found.push(t);
    const vw = innerWidth, vh = innerHeight;
    const seen = new Set();
    const out = [];
    for (const t of found) {
      if (seen.has(t.el)) continue;
      seen.add(t.el);
      const r = t.el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      out.push({ ...t, r, kind: isSmall(r) ? "circle" : "x" }); // entry points get a loop, blocks get crossed out
    }
    // Drop anything inside another target, then split each block into the things a viewer sees:
    // its section header and each of its pictures get their own X (owner decision: one X per image or
    // header, never one X across several pictures). Small entry points keep their loop.
    const outer = out.filter((t) => !out.some((o) => o !== t && o.el.contains(t.el)));
    return outer.flatMap((t) => (t.kind === "x" ? parts(t) : [t]));
  }

  // False when something else is on top of the element's centre, or a clipping ancestor (a carousel)
  // hides it: only pictures a viewer can actually see get an X.
  function visible(el, r) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const tile = el.parentElement?.parentElement?.parentElement || el;
    if (!hit || !(hit === el || el.contains(hit) || tile.contains(hit))) return false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const st = getComputedStyle(a);
      if (st.overflowX === "visible" && st.overflowY === "visible") continue;
      const ar = a.getBoundingClientRect();
      if (cx < ar.left || cx > ar.right || cy < ar.top || cy > ar.bottom) return false;
    }
    return true;
  }

  const inView = (r) => r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const overlaps = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);

  // The tight box around an element's text and icon, so a header's X covers the words, not the row.
  function tight(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return r.width && r.height ? r : el.getBoundingClientRect();
  }

  function parts(block) {
    const b = block.r, found = [];
    // Section header: a short heading in the top part of the block, such as "Shorts".
    const heads = [...block.el.querySelectorAll('h2, h3, [role="heading"], #title, yt-shelf-header-layout h2, .reel-shelf-title, .shelf-title')]
      .filter((h) => { const t = h.textContent.trim(); const r = tight(h); return /shorts|reels/i.test(t) && t.length < 40 && inView(r) && r.top < b.top + Math.max(80, b.height * 0.25); });
    const named = [...block.el.querySelectorAll("span, div")].find((n) => n.children.length === 0 && /^(Shorts|Reels)$/.test(n.textContent.trim()) && inView(tight(n)) && tight(n).top < b.top + Math.max(80, b.height * 0.25));
    const head = heads[0] || named;
    if (head) found.push({ el: head, r: tight(head), kind: "x", header: true });
    // Pictures: each visible thumbnail or video in the block, one X each, without doubles.
    const media = [];
    for (const m of block.el.querySelectorAll("img, video")) {
      const r = m.getBoundingClientRect();
      if (!inView(r) || r.width * r.height < 4000 || !visible(m, r)) continue;
      if (media.some((x) => overlaps(x.r, r))) continue;
      media.push({ el: m, r, kind: "x" });
    }
    found.push(...media);
    return found.length ? found : visible(block.el, b) ? [block] : [];
  }

  // Extra "before" targets that the rule set identifies only once Still is running.
  function extraTargets(service) {
    const out = [];
    if (service === "youtube") {
      // The Shorts filter chip: the content script tags it at run time, so find it by its text here.
      for (const chip of query("yt-chip-cloud-chip-renderer, chip-view-model, ytm-chip-cloud-chip-renderer")) {
        if (chip.textContent.trim() === "Shorts") out.push({ el: chip, kind: "circle" });
      }
    }
    if (service === "tiktok") {
      // Still blocks the whole TikTok website: cross out each video in a grid, or the one video playing.
      let tiles = query('[data-e2e="challenge-item"], [data-e2e="search_top-item"], [data-e2e="user-post-item"], [data-e2e="explore-item"]');
      if (!tiles.length) tiles = query('a[href*="/video/"]').filter((a) => a.querySelector("img, video")); // mobile web
      if (tiles.length) for (const t of tiles) out.push({ el: t.querySelector("img, video") || t, kind: "x" });
      else {
        const video = [...document.querySelectorAll("video")].find((v) => v.getBoundingClientRect().height > 300);
        let box = video;
        while (box && box.parentElement && box.parentElement.getBoundingClientRect().width < innerWidth * 0.45) box = box.parentElement;
        if (box) out.push({ el: box, kind: "x" });
      }
    }
    return out;
  }

  function largestMedia() {
    let best = null, area = 0;
    for (const m of document.querySelectorAll("video, main img")) {
      const r = m.getBoundingClientRect();
      if (r.width * r.height > area && r.top < innerHeight && r.bottom > 0) { best = m; area = r.width * r.height; }
    }
    return best ? [{ el: best, kind: "x" }] : [];
  }

  function path(points) {
    return points.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  }

  // A marker loop: slightly more than one turn, wobbly, not quite closed, like a quick hand circle.
  function loop(r, rand, width) {
    const pad = Math.max(6, Math.min(r.width, r.height) * 0.12);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // Keep the loop inside the viewport so it never runs off the capture's edge.
    const edge = 5 + width;
    const rx = Math.max(r.width / 2, Math.min(r.width / 2 + pad, cx - edge, innerWidth - edge - cx) / 1.1);
    const ry = Math.max(r.height / 2, Math.min(r.height / 2 + pad, cy - edge, innerHeight - edge - cy) / 1.1);
    const start = -Math.PI * (0.55 + rand() * 0.2);
    const turns = 1.08 + rand() * 0.06;
    const p1 = rand() * 6.28, p2 = rand() * 6.28;
    const pts = [];
    const n = 90;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const a = start + f * turns * Math.PI * 2;
      const wob = 1 + 0.035 * Math.sin(a * 2 + p1) + 0.02 * Math.sin(a * 3 + p2) + f * 0.05;
      pts.push([cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob]);
    }
    return [{ d: path(pts), width }];
  }

  // A marker X: two slightly curved strokes corner to corner, inset from the block's edges.
  function cross(r, rand, width, header) {
    const ix = header ? -6 : Math.min(r.width * 0.12, 60), iy = header ? -4 : Math.min(r.height * 0.12, 60);
    const x0 = r.left + ix, x1 = r.right - ix, y0 = r.top + iy, y1 = r.bottom - iy;
    const stroke = (ax, ay, bx, by) => {
      const pts = [];
      const bend = (rand() - 0.5) * 0.08 * Math.hypot(bx - ax, by - ay);
      const nx = -(by - ay), ny = bx - ax, len = Math.hypot(nx, ny) || 1;
      for (let i = 0; i <= 40; i++) {
        const f = i / 40, arc = Math.sin(f * Math.PI) * bend;
        pts.push([ax + (bx - ax) * f + (nx / len) * arc, ay + (by - ay) * f + (ny / len) * arc]);
      }
      return { d: path(pts), width };
    };
    return [
      stroke(x0 + (rand() - 0.5) * 10, y0 + (rand() - 0.5) * 10, x1 + (rand() - 0.5) * 10, y1),
      stroke(x1 + (rand() - 0.5) * 10, y0, x0, y1 + (rand() - 0.5) * 10),
    ];
  }

  function draw(marks, opts) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("data-still-annotate", "");
    svg.setAttribute("width", String(innerWidth));
    svg.setAttribute("height", String(innerHeight));
    Object.assign(svg.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none", overflow: "visible" });
    const rand = rng(opts.seed || 7);
    marks.forEach((m, i) => {
      const small = isSmall(m.r);
      const kind = m.kind;
      const width = opts.stroke || (m.header ? 4 : Math.max(4, Math.min(8, Math.min(m.r.width, m.r.height) * 0.04)));
      const strokes = kind === "circle" ? loop(m.r, rand, width) : cross(m.r, rand, width * 1.35, m.header);
      for (const s of strokes) {
        const p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", s.d);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", RED);
        p.setAttribute("stroke-width", String(s.width));
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        p.setAttribute("opacity", "0.93");
        svg.appendChild(p);
      }
      const label = opts.labels && opts.labels[i];
      if (label) {
        const t = document.createElementNS(SVGNS, "text");
        const size = opts.labelSize || 22;
        const x = Math.max(8, m.r.left), y = Math.max(size + 4, m.r.top - (small ? 14 : 8));
        t.setAttribute("x", String(x));
        t.setAttribute("y", String(y));
        t.setAttribute("transform", `rotate(-3 ${x} ${y})`);
        t.textContent = label;
        Object.assign(t.style, { font: `700 ${size}px "Marker Felt", "Chalkboard SE", "Comic Sans MS", cursive`,
          fill: RED, stroke: "white", strokeWidth: "5px", paintOrder: "stroke", strokeLinejoin: "round" });
        svg.appendChild(t);
      }
    });
    document.documentElement.appendChild(svg);
    return svg;
  }

  // Each site's "open the app" nag covers the page; closing it changes nothing Still does.
  function dismissNags(service) {
    const labels = /^(not now|close|dismiss)$/i;
    for (const b of document.querySelectorAll('button, [role="button"], a')) {
      if (labels.test((b.textContent || b.getAttribute("aria-label") || "").trim())) b.click();
    }
  }

  function run(config) {
    const service = config.service || serviceFor(location.hostname);
    if (!service) return { service: null, marks: 0 };
    for (const old of document.querySelectorAll("[data-still-annotate]")) old.remove();
    if (config.dismiss !== false) dismissNags(service);
    if (config.blur === true) {
      const style = document.createElement("style");
      style.setAttribute("data-still-annotate", "");
      style.textContent = (BLUR[service] || "") + (config.extraCss || "");
      document.documentElement.appendChild(style);
    }
    let marks = [];
    if (config.mark) {
      // A page Still replaces outright (a Reels page) takes explicit marks: its nav entry and the one
      // video, instead of every link the rule set would also hide on it.
      const rules = config.mark.circle
        ? [{ action: "hide", selectors: config.mark.circle }, { action: "remove", selectors: config.mark.x || [] }]
        : (config.rules && config.rules[service]) || [];
      const extra = config.mark.largestMedia ? largestMedia() : extraTargets(service);
      marks = targets(rules, extra).slice(0, config.maxMarks || 24);
      draw(marks, config);
    }
    return { service, marks: marks.length, rects: marks.map((m) => [m.kind, Math.round(m.r.left), Math.round(m.r.top), Math.round(m.r.width), Math.round(m.r.height)]) };
  }

  globalThis.StillAnnotate = { run, serviceFor };
})();
