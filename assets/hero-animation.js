(async () => {
  const canvas = document.querySelector('.hero-animation');
  const frame = canvas?.closest('.hero-media');
  const context = canvas?.getContext('2d');
  if (!context || !frame) return;

  const button = frame.querySelector('.hero-animation-toggle');
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const cycleLength = 11;
  const stopTime = 4.2;
  const blue = '#2141ed';
  const assetBase = new URL('./platforms/', document.currentScript.src);
  const platformLogos = await Promise.all(
    ['youtube-shorts.svg', 'instagram-reels.svg', 'tiktok.svg'].map(async filename => {
      const image = new Image();
      image.src = new URL(filename, assetBase).href;
      await image.decode();
      return image;
    }),
  ).catch(() => null);
  // Keep the poster if an asset fails, rather than starting with missing brand marks.
  if (!platformLogos) return;
  let elapsed = 0;
  let previousTime = 0;
  let request = 0;
  let visible = false;
  let paused = false;
  let width = 0;
  let height = 0;

  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

  function roundedRect(ctx, x, y, w, h, radius) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
  }

  function drawPlatformLogo(ctx, index, x, y, size) {
    const image = platformLogos[index % platformLogos.length];
    const ratio = image.naturalWidth / image.naturalHeight;
    const w = ratio > 1 ? size : size * ratio;
    const h = ratio > 1 ? size / ratio : size;
    ctx.drawImage(image, x + (size - w) / 2, y + (size - h) / 2, w, h);
  }

  // Draw each illustrative video once. Animation frames only composite these cached cards.
  function makeCard(index) {
    const art = document.createElement('canvas');
    art.width = 240;
    art.height = 400;
    const ctx = art.getContext('2d');
    const platforms = ['YouTube Shorts', 'Instagram Reels', 'TikTok'];
    const palettes = [
      ['#ff9a62', '#592463', '#ffc982'],
      ['#70dcce', '#075887', '#b3f4da'],
      ['#cb7dff', '#402f9b', '#f0b3fb'],
      ['#ffe293', '#db5064', '#fff0b3'],
      ['#87bdff', '#224cac', '#c3e8ff'],
      ['#fa86b4', '#733061', '#ffcfda'],
    ];
    const [light, dark, accent] = palettes[index % palettes.length];
    roundedRect(ctx, 0, 0, 240, 400, 20);
    ctx.clip();
    const background = ctx.createLinearGradient(0, 0, 180, 400);
    background.addColorStop(0, light);
    background.addColorStop(1, dark);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 240, 400);

    // Abstract sun, landscape, and layered waves suggest video thumbnails without real feeds.
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(70 + (index % 3) * 40, 140, 37, 0, Math.PI * 2);
    ctx.fill();
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = [dark, light, dark][layer];
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(0, 220 + layer * 40);
      ctx.bezierCurveTo(80, 120 + layer * 45, 150, 310 - layer * 30, 240, 210 + layer * 35);
      ctx.lineTo(240, 400);
      ctx.lineTo(0, 400);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const shade = ctx.createLinearGradient(0, 220, 0, 400);
    shade.addColorStop(0, 'transparent');
    shade.addColorStop(1, '#111526');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 220, 240, 180);
    ctx.fillStyle = 'rgba(10,14,30,.72)';
    ctx.fillRect(0, 0, 240, 56);
    drawPlatformLogo(ctx, index, 12, 10, 36);
    ctx.fillStyle = 'white';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText(platforms[index % 3], 58, 34);
    // A larger mark remains identifiable when card headers fly beyond the frame.
    ctx.fillStyle = 'rgba(10,14,30,.72)';
    roundedRect(ctx, 72, 138, 96, 96, 22);
    ctx.fill();
    drawPlatformLogo(ctx, index, 84, 150, 72);
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText(['Just one more', 'For you', 'Up next'][index % 3], 18, 327);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    roundedRect(ctx, 18, 343, 122, 5, 3);
    ctx.fill();
    roundedRect(ctx, 18, 357, 88, 5, 3);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText('♥', 201, 277);
    ctx.beginPath();
    ctx.arc(210, 308, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(205, 310, 3, 9);
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.fillRect(18, 381, 204, 3);
    ctx.fillStyle = 'white';
    ctx.fillRect(18, 381, 75 + index * 8, 3);
    return art;
  }

  const artwork = Array.from({ length: 6 }, (_, index) => makeCard(index));
  const cards = Array.from({ length: 30 }, (_, index) => ({
    art: artwork[index % artwork.length],
    angle: index * 2.39996,
    offset: index / 30,
    speed: 0.86 + (index % 5) * 0.075,
    tilt: Math.sin(index * 4.7) * 0.4,
    spread: 0.38 + (index % 5) * 0.14,
  }));

  function drawLogo(time) {
    const reveal = clamp((time - stopTime) / 0.4);
    if (!reveal) return;
    // A quick, single overshoot gives the mark a physical stop without flashing the frame.
    const scale = 1 + 2.7 * Math.pow(reveal - 1, 3) + 1.7 * Math.pow(reveal - 1, 2);
    const size = height * 0.32;
    context.save();
    context.translate(width / 2, height / 2 - height * 0.025);
    context.scale(scale, scale);
    context.globalAlpha = reveal;
    context.shadowColor = 'rgba(3,9,45,.3)';
    context.shadowBlur = size * 0.4;
    context.fillStyle = blue;
    roundedRect(context, -size / 2, -size / 2, size, size, size * 0.23);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = 'white';
    context.lineWidth = size * 0.045;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(-size * 0.3, size * 0.07);
    context.lineTo(size * 0.3, size * 0.07);
    context.stroke();
    context.fillStyle = 'white';
    context.beginPath();
    context.arc(0, -size * 0.055, size * 0.105, 0, Math.PI * 2);
    context.fill();
    context.font = `650 ${height * 0.072}px InterVariable, system-ui, sans-serif`;
    context.textAlign = 'center';
    context.fillText('st·ll', 0, size * 0.91);
    context.restore();
  }

  function draw() {
    if (!width || !height) return;
    const time = motionPreference.matches ? 8 : elapsed % cycleLength;
    const rushTime = Math.min(time, stopTime);
    const clearing = smooth((time - 5.1) / 1.2);
    const backdrop = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width * 0.75);
    backdrop.addColorStop(0, '#283887');
    backdrop.addColorStop(1, '#0b112d');
    context.fillStyle = backdrop;
    context.fillRect(0, 0, width, height);

    if (clearing < 1) {
      const centerX = width / 2 + Math.sin(rushTime * 2.4) * width * 0.035;
      const centerY = height / 2 + Math.cos(rushTime * 3.1) * height * 0.035;
      // Subtle speed trails reinforce depth; they freeze on the same clock as the cards.
      context.save();
      context.globalAlpha = (1 - clearing) * 0.18;
      context.strokeStyle = '#9faeff';
      context.lineWidth = 1;
      for (let i = 0; i < 20; i++) {
        const angle = i * 2.39996;
        const distance = (i / 20 + rushTime * 0.8) % 1;
        context.beginPath();
        context.moveTo(centerX + Math.cos(angle) * width * distance, centerY + Math.sin(angle) * height * distance);
        context.lineTo(centerX + Math.cos(angle) * width * (distance + 0.22), centerY + Math.sin(angle) * height * (distance + 0.22));
        context.stroke();
      }
      context.restore();
      const positions = cards.map(card => ({ ...card, depth: (card.offset + rushTime * card.speed) % 1 }));
      positions.sort((a, b) => a.depth - b.depth);
      for (const card of positions) {
        const zoom = 0.12 + Math.pow(card.depth, 2.3) * 3.2;
        const distance = Math.pow(card.depth, 1.75) * card.spread;
        const x = centerX + Math.cos(card.angle) * width * distance;
        const y = centerY + Math.sin(card.angle) * height * distance;
        const cardHeight = height * 0.62 * zoom;
        const cardWidth = cardHeight * 0.6;
        context.save();
        context.globalAlpha = Math.min(1, card.depth * 6, (1 - card.depth) * 8) * (1 - clearing);
        context.translate(x, y);
        context.rotate(card.tilt + Math.sin(rushTime * 2 + card.angle) * 0.1);
        context.drawImage(card.art, -cardWidth / 2, -cardHeight / 2, cardWidth, cardHeight);
        context.restore();
      }
    }
    context.fillStyle = blue;
    context.globalAlpha = clearing;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;
    drawLogo(time);
  }

  function tick(now) {
    if (previousTime) elapsed += Math.min(now - previousTime, 64) / 1000;
    previousTime = now;
    draw();
    request = window.requestAnimationFrame(tick);
  }

  function syncPlayback() {
    window.cancelAnimationFrame(request);
    request = 0;
    previousTime = 0;
    button.hidden = motionPreference.matches;
    if (visible && !document.hidden && !paused && !motionPreference.matches) {
      request = window.requestAnimationFrame(tick);
    }
    draw();
  }

  new ResizeObserver(() => {
    const bounds = frame.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    const resolution = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * resolution);
    canvas.height = Math.round(height * resolution);
    context.setTransform(resolution, 0, 0, resolution, 0, 0);
    draw();
  }).observe(frame);

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncPlayback();
  }, { threshold: 0.1 }).observe(frame);

  button.addEventListener('click', () => {
    paused = !paused;
    button.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
    syncPlayback();
  });
  document.addEventListener('visibilitychange', syncPlayback);
  motionPreference.addEventListener('change', syncPlayback);
  frame.querySelector('.hero-video').hidden = true;
  canvas.hidden = false;
  syncPlayback();
})();
