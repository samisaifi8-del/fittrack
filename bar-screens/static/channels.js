// Live channels for the bar's LED walls. Each one draws into a canvas at the wall's own pixel
// size and animates itself. The look is an art deco cocktail lounge: black ground (unlit LEDs),
// gold sunbursts and double rules, a jewel-tone accent per channel, and a touch of neon glow.
(() => {
  'use strict';

  const GOLD = '#d9b25b';
  const GOLD_LIGHT = '#f6dd94';
  const THEMES = {
    rotation: { n: 1, name: 'BAR', accent: '#e8b84a' },
    scores: { n: 2, name: 'SCORES', accent: '#22e08f' },   // emerald
    news: { n: 3, name: 'NEWS', accent: '#ff3d5a' },       // ruby
    weather: { n: 4, name: 'WEATHER', accent: '#3aa8ff' }, // sapphire
    visuals: { n: 5, name: 'VISUALS', accent: '#c77dff' }, // amethyst
  };

  let fontStr = (name, px) => `700 ${px}px sans-serif`;
  const font = (name, px) => fontStr(name, Math.max(1, Math.round(px)));

  // ------------------------------------------------------------ helpers

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function fitSize(ctx, text, fontName, maxW, maxH) {
    let size = Math.max(4, Math.floor(maxH));
    ctx.font = font(fontName, size);
    const w = ctx.measureText(text).width;
    if (w > maxW) size = Math.max(4, Math.floor(size * maxW / w));
    return size;
  }

  function wrap(ctx, text, maxW) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(next).width <= maxW) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  }

  function fitWrapped(ctx, text, fontName, maxW, maxH, maxLines, lh) {
    let lo = 4, hi = Math.max(4, Math.floor(maxH)), best = { size: 4, lines: [text] };
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      ctx.font = font(fontName, mid);
      const lines = wrap(ctx, text, maxW);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      if (lines.length <= maxLines && lines.length * mid * lh <= maxH && widest <= maxW) { best = { size: mid, lines }; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  function glow(ctx, color, blur, draw) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    draw();
    ctx.restore();
    draw();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const timeStr = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Gold rays fanning up from the bottom edge, like a deco sunburst.
  function sunburst(ctx, cx, cy, r, rays, color, alpha, turn) {
    ctx.save();
    ctx.fillStyle = rgba(color, alpha);
    for (let i = 0; i < rays; i += 2) {
      const a0 = Math.PI + (i / rays) * Math.PI + (turn || 0);
      const a1 = Math.PI + ((i + 1) / rays) * Math.PI + (turn || 0);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
      ctx.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // A thin gold border with stepped corners, set just inside the edge of the wall.
  function decoFrame(ctx, W, H, color) {
    const s = Math.min(W, H);
    const lw = Math.max(1, Math.round(s * 0.006));
    const inset = Math.max(1, Math.round(s * 0.012)) + lw / 2;
    const step = Math.max(2, Math.round(s * 0.03));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    const x0 = inset, y0 = inset, x1 = W - inset, y1 = H - inset;
    ctx.moveTo(x0 + step * 2, y0);
    ctx.lineTo(x1 - step * 2, y0); ctx.lineTo(x1 - step * 2, y0 + step); ctx.lineTo(x1 - step, y0 + step);
    ctx.lineTo(x1 - step, y0 + step * 2); ctx.lineTo(x1, y0 + step * 2);
    ctx.lineTo(x1, y1 - step * 2); ctx.lineTo(x1 - step, y1 - step * 2); ctx.lineTo(x1 - step, y1 - step);
    ctx.lineTo(x1 - step * 2, y1 - step); ctx.lineTo(x1 - step * 2, y1);
    ctx.lineTo(x0 + step * 2, y1); ctx.lineTo(x0 + step * 2, y1 - step); ctx.lineTo(x0 + step, y1 - step);
    ctx.lineTo(x0 + step, y1 - step * 2); ctx.lineTo(x0, y1 - step * 2);
    ctx.lineTo(x0, y0 + step * 2); ctx.lineTo(x0 + step, y0 + step * 2); ctx.lineTo(x0 + step, y0 + step);
    ctx.lineTo(x0 + step * 2, y0 + step); ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // Thin and thick gold lines with a diamond in the middle.
  function doubleRule(ctx, x, y, w, s, color) {
    const thin = Math.max(1, Math.round(s * 0.004));
    const thick = Math.max(1, Math.round(s * 0.009));
    const gap = Math.max(1, Math.round(s * 0.006));
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, thin);
    ctx.fillRect(x, y + thin + gap, w, thick);
    const d = Math.max(2, Math.round(s * 0.018));
    const cx = x + w / 2, cy = y + (thin + gap + thick) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - d * 1.6, y - 1, d * 3.2, thin + gap + thick + 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - d); ctx.lineTo(cx + d, cy); ctx.lineTo(cx, cy + d); ctx.lineTo(cx - d, cy);
    ctx.closePath();
    ctx.fill();
    return thin + gap + thick;
  }

  // Black ground, a faint gold sunburst, a pool of the channel's colour and the deco frame.
  // Drawn once per size and reused every frame.
  const backdrops = new Map();
  function backdrop(ctx, W, H, accent) {
    const key = `${W}x${H}${accent}`;
    let c = backdrops.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      sunburst(x, W / 2, H * 1.02, Math.hypot(W, H), 36, GOLD, 0.07);
      const g = x.createRadialGradient(W / 2, H, 0, W / 2, H, Math.max(W, H) * 0.8);
      g.addColorStop(0, rgba(accent, 0.18));
      g.addColorStop(1, rgba(accent, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      decoFrame(x, W, H, rgba(GOLD, 0.55));
      if (backdrops.size > 12) backdrops.clear();
      backdrops.set(key, c);
    }
    ctx.drawImage(c, 0, 0);
  }

  // Channel number in a cut-corner gold badge, the name in deco capitals, the clock, and a gold
  // double rule underneath. Returns its height.
  function header(ctx, W, H, theme, label) {
    const s = Math.min(W, H);
    const hh = Math.max(10, Math.round(s * 0.14));
    const pad = Math.max(3, Math.round(s * 0.035));
    const bs = Math.round(hh * 0.66);
    const by = Math.round((hh - bs) / 2);
    const cut = bs * 0.22;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, W, hh);
    ctx.lineWidth = Math.max(1, Math.round(s * 0.006));
    ctx.strokeStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(pad + cut, by); ctx.lineTo(pad + bs - cut, by); ctx.lineTo(pad + bs, by + cut);
    ctx.lineTo(pad + bs, by + bs - cut); ctx.lineTo(pad + bs - cut, by + bs); ctx.lineTo(pad + cut, by + bs);
    ctx.lineTo(pad, by + bs - cut); ctx.lineTo(pad, by + cut); ctx.closePath();
    ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.accent;
    ctx.font = font('Anton', fitSize(ctx, String(theme.n), 'Anton', bs * 0.7, bs * 0.7));
    glow(ctx, theme.accent, bs * 0.3, () => ctx.fillText(String(theme.n), pad + bs / 2, by + bs / 2 + 1));
    const clock = timeStr(new Date());
    ctx.font = font('Barlow Condensed', hh * 0.46);
    const cw = ctx.measureText(clock).width;
    ctx.textAlign = 'right';
    ctx.fillStyle = GOLD_LIGHT;
    ctx.fillText(clock, W - pad, hh / 2);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    const name = label ? `${theme.name} · ${label}` : theme.name;
    const nx = pad + bs + Math.round(pad * 0.8);
    ctx.font = font('Limelight', fitSize(ctx, name, 'Limelight', W - nx - cw - pad * 2, hh * 0.5));
    ctx.fillText(name, nx, hh / 2 + 1);
    doubleRule(ctx, 0, hh - Math.round(s * 0.02), W, s, GOLD);
    return hh;
  }

  function message(ctx, W, top, H, text, color) {
    const pad = Math.round(W * 0.08);
    const box = fitWrapped(ctx, text, 'Bebas Neue', W - pad * 2, (H - top) * 0.5, 3, 1.05);
    ctx.font = font('Bebas Neue', box.size);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const y0 = top + (H - top) / 2 - ((box.lines.length - 1) * box.size * 1.05) / 2;
    box.lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * box.size * 1.05));
  }

  // Polls the Pi for a channel's data; the Pi caches it, so this is cheap.
  function feed(name, onData) {
    let timer = 0, stopped = false;
    const load = async () => {
      try {
        const res = await fetch('/api/feed/' + name);
        const json = await res.json();
        if (!stopped) onData(json);
      } catch (e) {
        if (!stopped) onData(null);
      }
      if (!stopped) timer = setTimeout(load, 30000);
    };
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }

  function animate(draw, fps) {
    let raf = 0, last = 0, stopped = false;
    const step = (ms) => {
      if (stopped) return;
      raf = requestAnimationFrame(step);
      if (ms - last < 1000 / fps - 2) return;
      last = ms;
      draw(ms / 1000);
    };
    raf = requestAnimationFrame(step);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }

  // ------------------------------------------------------------ scores

  function kickoff(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return timeStr(d);
    return `${d.toLocaleDateString([], { weekday: 'short' }).toUpperCase()} ${timeStr(d)}`;
  }

  function orderMatches(matches) {
    const today = new Date().toDateString();
    const rank = (m) => {
      const isToday = new Date(m.date).toDateString() === today;
      if (m.state === 'in') return 0;
      if (m.state === 'pre' && isToday) return 1;
      if (m.state === 'post' && isToday) return 2;
      if (m.state === 'pre') return 3;
      return 4;
    };
    return matches.slice().sort((a, b) => rank(a) - rank(b) || new Date(a.date) - new Date(b.date)).slice(0, 30);
  }

  function scores(canvas, W, H, opts) {
    const theme = THEMES.scores;
    const ctx = canvas.getContext('2d');
    let payload = null, failed = false;
    const stopFeed = feed('scores', (j) => { if (j && j.data) payload = j.data; failed = !j || (!j.ok && !j.data); });
    let pages = [], pageIndex = 0, pageStart = 0, built = '';

    const stop = animate((t) => {
      backdrop(ctx, W, H, theme.accent);
      const hh = header(ctx, W, H, theme);
      if (!payload) { message(ctx, W, hh, H, failed ? "Can't reach the scores right now" : 'Loading scores…', '#8a93a3'); return; }
      const pad = Math.max(2, Math.round(Math.min(W, H) * 0.04));
      const titleH = Math.max(8, Math.round(hh * 0.75));
      const rowH = Math.max(8, Math.round(Math.min(W, H) * 0.12));
      const rows = Math.max(1, Math.floor((H - hh - titleH - pad * 2) / rowH));
      const key = JSON.stringify([payload, rows]);
      if (key !== built) {
        built = key;
        pages = [];
        for (const league of payload.leagues || []) {
          const list = orderMatches(league.matches || []);
          const count = Math.ceil(list.length / rows);
          for (let i = 0; i < count; i++) pages.push({ name: league.name, rows: list.slice(i * rows, (i + 1) * rows), part: i + 1, of: count });
        }
        pageIndex = 0;
        pageStart = t;
      }
      if (!pages.length) { message(ctx, W, hh, H, 'No games this week', '#8a93a3'); return; }
      if (t - pageStart > 9) { pageIndex = (pageIndex + 1) % pages.length; pageStart = t; }
      const page = pages[pageIndex];
      const since = t - pageStart;

      // league title
      let y = hh + pad;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = theme.accent;
      const partText = page.of > 1 ? `${page.part}/${page.of}` : '';
      ctx.font = font('Barlow Condensed', titleH * 0.6);
      const partW = partText ? ctx.measureText(partText).width + pad : 0;
      ctx.font = font('Bebas Neue', fitSize(ctx, page.name.toUpperCase(), 'Bebas Neue', W - pad * 2 - partW, titleH * 0.85));
      ctx.fillText(page.name.toUpperCase(), pad, y + titleH / 2);
      if (partText) {
        ctx.font = font('Barlow Condensed', titleH * 0.6);
        ctx.fillStyle = '#8a93a3';
        ctx.textAlign = 'right';
        ctx.fillText(partText, W - pad, y + titleH / 2);
      }
      y += titleH;

      const statusW = Math.round(W * 0.24);
      const teamsW = W - pad * 2 - statusW;
      const chipW = Math.max(2, Math.round(rowH * 0.1));
      const size = Math.round(rowH * 0.6);
      page.rows.forEach((m, i) => {
        const enter = Math.min(1, Math.max(0, (since - i * 0.06) / 0.35));
        if (enter <= 0) return;
        const ry = y + i * rowH;
        const dx = (1 - enter) * (1 - enter) * W * 0.4;
        ctx.save();
        ctx.globalAlpha = enter;
        ctx.translate(dx, 0);
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.07)';
        ctx.fillRect(pad, ry + 1, W - pad * 2, rowH - 2);
        ctx.fillStyle = m.home.color || '#555';
        ctx.fillRect(pad, ry + 1, chipW, rowH - 2);
        ctx.fillStyle = m.away.color || '#555';
        ctx.fillRect(pad + teamsW - chipW, ry + 1, chipW, rowH - 2);
        const cy = ry + rowH / 2 + 1;
        const live = m.state === 'in';
        ctx.font = font('Barlow Condensed', size);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(m.home.abbr, pad + chipW * 2, cy);
        ctx.textAlign = 'right';
        ctx.fillText(m.away.abbr, pad + teamsW - chipW * 2, cy);
        ctx.textAlign = 'center';
        const score = m.state === 'pre' ? 'v' : `${m.home.score}-${m.away.score}`;
        ctx.font = font('Anton', size * 0.95);
        ctx.fillStyle = live ? theme.accent : '#ffffff';
        if (live) glow(ctx, theme.accent, rowH * 0.25, () => ctx.fillText(score, pad + teamsW / 2, cy));
        else ctx.fillText(score, pad + teamsW / 2, cy);
        const status = m.state === 'pre' ? kickoff(m.date) : (m.detail || m.clock || '').toUpperCase();
        ctx.font = font('Barlow Condensed', fitSize(ctx, status, 'Barlow Condensed', statusW - pad * 1.5, size * 0.85));
        ctx.textAlign = 'right';
        ctx.fillStyle = live ? '#ff3b3b' : m.state === 'post' ? '#8a93a3' : '#d6dbe3';
        ctx.fillText(status, W - pad, cy);
        if (live && Math.floor(t * 2) % 2 === 0) {
          ctx.beginPath();
          ctx.arc(W - pad - ctx.measureText(status).width - rowH * 0.18, cy, Math.max(1, rowH * 0.08), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });
    }, 30);
    return { stop() { stop(); stopFeed(); } };
  }

  // ------------------------------------------------------------ news

  function news(canvas, W, H) {
    const theme = THEMES.news;
    const ctx = canvas.getContext('2d');
    let payload = null, failed = false, items = [], index = 0, shownAt = 0, strip = null, stripKey = '';
    const stopFeed = feed('news', (j) => { if (j && j.data) payload = j.data; failed = !j || (!j.ok && !j.data); });

    function buildStrip(h) {
      const text = `${(payload.source || '').toUpperCase()}  •  ` + items.map((i) => i.title).join('   •   ') + '   •   ';
      const c = document.createElement('canvas');
      const m = c.getContext('2d');
      m.font = font('Barlow Condensed', h * 0.62);
      c.width = Math.min(30000, Math.ceil(m.measureText(text).width));
      c.height = h;
      m.font = font('Barlow Condensed', h * 0.62);
      m.textBaseline = 'middle';
      m.fillStyle = '#ffffff';
      m.fillText(text, 0, h / 2 + 1);
      return c;
    }

    const stop = animate((t) => {
      backdrop(ctx, W, H, theme.accent);
      const hh = header(ctx, W, H, theme, payload ? payload.section.toUpperCase() : '');
      if (!payload) { message(ctx, W, hh, H, failed ? "Can't reach the news right now" : 'Loading headlines…', '#8a93a3'); return; }
      if (items !== payload.items) { items = payload.items; index = 0; shownAt = t; }
      const tickH = Math.max(9, Math.round(hh * 0.85));
      const pad = Math.max(3, Math.round(Math.min(W, H) * 0.06));
      if (t - shownAt > 10) { index = (index + 1) % items.length; shownAt = t; }
      const since = t - shownAt;

      // headline
      const bodyTop = hh + pad;
      const bodyH = H - hh - tickH - pad * 2.5;
      const headline = items[index].title;
      const box = fitWrapped(ctx, headline, 'Barlow Condensed', W - pad * 2, bodyH * 0.86, 5, 1.08);
      ctx.font = font('Barlow Condensed', box.size);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const blockH = box.lines.length * box.size * 1.08;
      const y0 = bodyTop + (bodyH - blockH) / 2;
      const reveal = Math.min(1, since / 0.45);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pad + (W - pad) * reveal, H);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      box.lines.forEach((l, i) => ctx.fillText(l, pad, y0 + i * box.size * 1.08));
      ctx.restore();
      if (reveal < 1) {
        ctx.fillStyle = theme.accent;
        glow(ctx, theme.accent, pad, () => ctx.fillRect(pad + (W - pad) * reveal, y0, Math.max(2, pad * 0.25), blockH));
      }
      // time until the next headline
      const lineY = Math.min(H - tickH - pad, y0 + blockH + pad * 0.6);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(pad, lineY, W - pad * 2, Math.max(1, Math.round(pad * 0.15)));
      ctx.fillStyle = theme.accent;
      ctx.fillRect(pad, lineY, (W - pad * 2) * Math.min(1, since / 10), Math.max(1, Math.round(pad * 0.15)));

      // ticker
      const ty = H - tickH;
      ctx.fillStyle = '#16060a';
      ctx.fillRect(0, ty, W, tickH);
      const key = `${tickH}|${items.length}|${items[0].title}`;
      if (key !== stripKey) { stripKey = key; strip = buildStrip(tickH); }
      const labelW = Math.round(tickH * 2.4);
      const offset = (t * tickH * 2.2) % strip.width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(labelW, ty, W - labelW, tickH);
      ctx.clip();
      for (let x = labelW - offset; x < W; x += strip.width) ctx.drawImage(strip, Math.round(x), ty);
      ctx.restore();
      ctx.fillStyle = theme.accent;
      ctx.fillRect(0, ty, labelW, tickH);
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font('Bebas Neue', fitSize(ctx, 'LATEST', 'Bebas Neue', labelW * 0.85, tickH * 0.8));
      ctx.fillText('LATEST', labelW / 2, ty + tickH / 2 + 1);
    }, 30);
    return { stop() { stop(); stopFeed(); } };
  }

  // ------------------------------------------------------------ weather

  const WX = [
    [[0], 'clear', 'Clear'], [[1], 'clear', 'Mostly clear'], [[2], 'partly', 'Partly cloudy'], [[3], 'cloud', 'Cloudy'],
    [[45, 48], 'fog', 'Fog'], [[51, 53, 55], 'drizzle', 'Drizzle'], [[56, 57], 'drizzle', 'Freezing drizzle'],
    [[61], 'rain', 'Light rain'], [[63], 'rain', 'Rain'], [[65], 'rain', 'Heavy rain'], [[66, 67], 'rain', 'Freezing rain'],
    [[71], 'snow', 'Light snow'], [[73], 'snow', 'Snow'], [[75], 'snow', 'Heavy snow'], [[77], 'snow', 'Snow grains'],
    [[80], 'rain', 'Showers'], [[81], 'rain', 'Heavy showers'], [[82], 'rain', 'Violent showers'], [[85, 86], 'snow', 'Snow showers'],
    [[95], 'storm', 'Thunderstorm'], [[96, 99], 'storm', 'Thunder and hail'],
  ];
  const wx = (code) => WX.find(([codes]) => codes.includes(code)) || [[], 'cloud', 'Cloudy'];

  function drawCloud(ctx, x, y, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x - s * 0.18, y + s * 0.02, s * 0.17, 0, Math.PI * 2);
    ctx.arc(x + s * 0.02, y - s * 0.08, s * 0.22, 0, Math.PI * 2);
    ctx.arc(x + s * 0.22, y + s * 0.04, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    roundRect(ctx, x - s * 0.35, y, s * 0.72, s * 0.2, s * 0.1);
    ctx.fill();
  }

  // Animated icon centred on (x, y), about s pixels across.
  function weatherIcon(ctx, kind, x, y, s, t, day) {
    const sunny = (cx, cy, r) => {
      if (!day) {
        ctx.fillStyle = '#e9ecff';
        glow(ctx, '#9fb3ff', r * 0.8, () => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); });
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(cx + r * 0.45, cy - r * 0.3, r * 0.85, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.strokeStyle = '#ffc23d';
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.lineCap = 'round';
      for (let i = 0; i < 8; i++) {
        const a = t * 0.4 + (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * 1.35, cy + Math.sin(a) * r * 1.35);
        ctx.lineTo(cx + Math.cos(a) * r * 1.75, cy + Math.sin(a) * r * 1.75);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffc23d';
      glow(ctx, '#ff9d00', r, () => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); });
    };
    const drift = Math.sin(t * 0.8) * s * 0.03;
    if (kind === 'clear') return sunny(x, y, s * 0.24);
    if (kind === 'partly') {
      sunny(x + s * 0.14, y - s * 0.14, s * 0.17);
      return drawCloud(ctx, x - s * 0.04 + drift, y + s * 0.06, s * 0.95, '#dfe6ee');
    }
    if (kind === 'fog') {
      ctx.fillStyle = '#aab4c0';
      for (let i = 0; i < 4; i++) {
        const off = Math.sin(t * 0.7 + i) * s * 0.08;
        roundRect(ctx, x - s * 0.38 + off, y - s * 0.24 + i * s * 0.15, s * 0.76, s * 0.07, s * 0.035);
        ctx.fill();
      }
      return;
    }
    const dark = kind === 'storm' ? '#7d8796' : kind === 'cloud' ? '#c9d2dc' : '#aeb9c6';
    const cy = kind === 'cloud' ? y : y - s * 0.12;
    if (kind === 'rain' || kind === 'drizzle') {
      ctx.strokeStyle = '#4fb6ff';
      ctx.lineWidth = Math.max(1, s * (kind === 'rain' ? 0.035 : 0.025));
      ctx.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        const p = ((t * 1.4 + i * 0.37) % 1);
        const dx = x - s * 0.26 + i * s * 0.13 - p * s * 0.05;
        const dy = cy + s * 0.18 + p * s * 0.3;
        ctx.globalAlpha = 1 - p * 0.7;
        ctx.beginPath();
        ctx.moveTo(dx, dy);
        ctx.lineTo(dx - s * 0.03, dy + s * 0.09);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (kind === 'snow') {
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 6; i++) {
        const p = ((t * 0.5 + i * 0.29) % 1);
        ctx.globalAlpha = 1 - p * 0.6;
        ctx.beginPath();
        ctx.arc(x - s * 0.27 + i * s * 0.11 + Math.sin(t * 2 + i) * s * 0.03, cy + s * 0.2 + p * s * 0.32, Math.max(1, s * 0.03), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (kind === 'storm' && (t % 3.2) < 0.25) {
      ctx.fillStyle = '#ffe14d';
      glow(ctx, '#ffe14d', s * 0.15, () => {
        ctx.beginPath();
        ctx.moveTo(x + s * 0.02, cy + s * 0.12);
        ctx.lineTo(x - s * 0.1, cy + s * 0.34);
        ctx.lineTo(x, cy + s * 0.32);
        ctx.lineTo(x - s * 0.06, cy + s * 0.5);
        ctx.lineTo(x + s * 0.12, cy + s * 0.26);
        ctx.lineTo(x + s * 0.02, cy + s * 0.28);
        ctx.closePath();
        ctx.fill();
      });
    }
    drawCloud(ctx, x + drift, cy, s, dark);
  }

  function weather(canvas, W, H) {
    const theme = THEMES.weather;
    const ctx = canvas.getContext('2d');
    let payload = null, failed = false;
    const stopFeed = feed('weather', (j) => { if (j && j.data) payload = j.data; failed = !j || (!j.ok && !j.data); });

    const stop = animate((t) => {
      backdrop(ctx, W, H, theme.accent);
      const label = payload && payload.place ? payload.place.toUpperCase() : '';
      const hh = header(ctx, W, H, theme, label);
      if (!payload) { message(ctx, W, hh, H, failed ? "Can't reach the weather right now" : 'Loading weather…', '#8a93a3'); return; }
      if (payload.needsPlace) { message(ctx, W, hh, H, 'Set your town in Channel settings on your phone', '#8a93a3'); return; }
      const pad = Math.max(3, Math.round(Math.min(W, H) * 0.05));
      const bodyH = H - hh - pad * 2;
      const nowH = Math.round(bodyH * 0.56);
      const top = hh + pad;
      const now = payload.now;
      const [, kind, desc] = wx(now.code);

      // now: icon left, temperature and details right
      const iconS = Math.min(nowH, (W - pad * 2) * 0.42);
      weatherIcon(ctx, kind, pad + iconS / 2, top + nowH / 2, iconS, t, now.day);
      const tx = pad * 2 + iconS;
      const tw = W - tx - pad;
      const temp = `${Math.round(now.temp)}°`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      const tempSize = fitSize(ctx, temp, 'Anton', tw, nowH * 0.58);
      ctx.font = font('Anton', tempSize);
      glow(ctx, rgba(theme.accent, 0.8), tempSize * 0.15, () => ctx.fillText(temp, tx, top + nowH * 0.58));
      ctx.fillStyle = theme.accent;
      ctx.font = font('Bebas Neue', fitSize(ctx, desc.toUpperCase(), 'Bebas Neue', tw, nowH * 0.2));
      ctx.fillText(desc.toUpperCase(), tx, top + nowH * 0.8);
      const extra = `FEELS ${Math.round(now.feels)}°  ·  WIND ${Math.round(now.wind)} MPH`;
      ctx.fillStyle = '#9aa4b5';
      ctx.font = font('Barlow Condensed', fitSize(ctx, extra, 'Barlow Condensed', tw, nowH * 0.14));
      ctx.fillText(extra, tx, top + nowH * 0.97);

      // forecast: alternates between the next few hours and the next few days
      const showDays = Math.floor(t / 10) % 2 === 1 || !payload.hours.length;
      const fy = top + nowH + pad;
      const fh = H - fy - pad;
      const cols = W >= H ? 4 : 3;
      const list = showDays ? payload.days.slice(0, cols) : payload.hours.slice(0, cols);
      const cw = (W - pad * 2) / cols;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      roundRect(ctx, pad, fy, W - pad * 2, fh, Math.max(2, pad * 0.5));
      ctx.fill();
      list.forEach((f, i) => {
        const cx = pad + cw * i + cw / 2;
        const name = showDays
          ? (i === 0 ? 'TODAY' : new Date(f.date + 'T12:00').toLocaleDateString([], { weekday: 'short' }).toUpperCase())
          : f.time;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#9aa4b5';
        ctx.font = font('Barlow Condensed', fitSize(ctx, name, 'Barlow Condensed', cw * 0.9, fh * 0.2));
        ctx.fillText(name, cx, fy + fh * 0.16);
        weatherIcon(ctx, wx(f.code)[1], cx, fy + fh * 0.48, Math.min(cw * 0.8, fh * 0.42), t + i, true);
        const temps = showDays ? `${Math.round(f.max)}° ${Math.round(f.min)}°` : `${Math.round(f.temp)}°`;
        ctx.fillStyle = '#ffffff';
        ctx.font = font('Barlow Condensed', fitSize(ctx, temps, 'Barlow Condensed', cw * 0.9, fh * 0.22));
        ctx.fillText(temps, cx, fy + fh * 0.84);
      });
    }, 24);
    return { stop() { stop(); stopFeed(); } };
  }

  // ------------------------------------------------------------ visuals

  function palette(stops) {
    // stops: [[position 0-1, '#rrggbb'], ...] -> 256 packed RGB entries
    const out = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      const p = i / 255;
      let j = 0;
      while (j < stops.length - 2 && p > stops[j + 1][0]) j++;
      const [p0, c0] = stops[j], [p1, c1] = stops[j + 1];
      const f = Math.min(1, Math.max(0, (p - p0) / (p1 - p0 || 1)));
      const a = parseInt(c0.slice(1), 16), b = parseInt(c1.slice(1), 16);
      const r = ((a >> 16) + ((b >> 16) - (a >> 16)) * f) | 0;
      const g = (((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * f) | 0;
      const bl = ((a & 255) + ((b & 255) - (a & 255)) * f) | 0;
      out[i] = (255 << 24) | (bl << 16) | (g << 8) | r; // little-endian ImageData order
    }
    return out;
  }

  // Pixel effects run on a small canvas and are scaled up smoothly, which keeps them fast on the Pi.
  function lowRes(W, H, longSide) {
    const k = Math.min(1, longSide / Math.max(W, H));
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(W * k));
    c.height = Math.max(8, Math.round(H * k));
    const x = c.getContext('2d');
    const img = x.createImageData(c.width, c.height);
    return { c, x, img, px: new Uint32Array(img.data.buffer), w: c.width, h: c.height };
  }
  function blitUp(ctx, lr, W, H) {
    lr.x.putImageData(lr.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(lr.c, 0, 0, W, H);
  }

  const EFFECTS = {
    plasma(W, H) {
      const lr = lowRes(W, H, 200);
      const pal = palette([[0, '#000000'], [0.3, '#3a2a06'], [0.5, '#d9b25b'], [0.6, '#fff1c2'], [0.7, '#1b8f6a'], [0.85, '#0a2a3a'], [1, '#000000']]);
      return (ctx, t) => {
        const { w, h, px } = lr;
        for (let y = 0; y < h; y++) {
          const v1 = Math.sin(y * 0.09 + t * 1.1);
          for (let x = 0; x < w; x++) {
            const v = v1 + Math.sin(x * 0.07 - t * 0.8) + Math.sin((x + y) * 0.05 + t * 0.6) +
              Math.sin(Math.sqrt((x - w / 2) ** 2 + (y - h / 2) ** 2) * 0.12 - t * 1.5);
            px[y * w + x] = pal[((v + 4) * 32 + t * 40) & 255];
          }
        }
        blitUp(ctx, lr, W, H);
      };
    },

    fire(W, H) {
      const lr = lowRes(W, H, 140);
      const { w, h } = lr;
      const heat = new Float32Array(w * (h + 1));
      const decay = 2 / (h * 0.75);
      const pal = palette([[0, '#000000'], [0.25, '#4a0000'], [0.5, '#d01800'], [0.7, '#ff7a00'], [0.88, '#ffd24a'], [1, '#fff8e0']]);
      return (ctx) => {
        for (let x = 0; x < w; x++) heat[h * w + x] = 0.85 + Math.random() * 0.15;
        // Each cell drifts up a row with a little sideways jitter and cools, which makes flame tongues.
        for (let y = 1; y <= h; y++) {
          for (let x = 0; x < w; x++) {
            const r = (Math.random() * 3) | 0;
            let dx = x - r + 1;
            if (dx < 0) dx += w; else if (dx >= w) dx -= w;
            const v = heat[y * w + x] - (r & 1) * decay * (0.5 + Math.random());
            heat[(y - 1) * w + dx] = v > 0 ? v : 0;
          }
        }
        for (let i = 0; i < w * h; i++) lr.px[i] = pal[Math.min(255, (heat[i] * 255) | 0)];
        blitUp(ctx, lr, W, H);
      };
    },

    lava(W, H) {
      const lr = lowRes(W, H, 110);
      const { w, h } = lr;
      const pal = palette([[0, '#0a0012'], [0.45, '#2a0040'], [0.55, '#ff2a00'], [0.75, '#ff7a00'], [1, '#ffd200']]);
      const balls = Array.from({ length: 7 }, (_, i) => ({ fx: 0.13 + i * 0.05, fy: 0.07 + i * 0.031, px: i * 1.7, py: i * 2.3, r: 0.12 + (i % 3) * 0.04 }));
      return (ctx, t) => {
        const s = Math.min(w, h);
        const pos = balls.map((b) => [w * (0.5 + 0.38 * Math.sin(t * b.fx + b.px)), h * (0.5 + 0.45 * Math.sin(t * b.fy + b.py)), (b.r * s) ** 2]);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let f = 0;
            for (const [bx, by, r2] of pos) f += r2 / ((x - bx) ** 2 + (y - by) ** 2 + 1);
            lr.px[y * w + x] = pal[Math.min(255, (f * 128) | 0)];
          }
        }
        blitUp(ctx, lr, W, H);
      };
    },

    warp(W, H) {
      const n = Math.min(400, Math.round((W * H) / 900) + 60);
      const stars = Array.from({ length: n }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
      const tints = ['#ffffff', '#9fe8ff', '#ffd27a', '#ff9df0'];
      let last = 0;
      return (ctx, t) => {
        const dt = last ? Math.min(0.1, t - last) : 0;
        last = t;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, 0, W, H);
        const f = Math.max(W, H) * 0.5;
        ctx.lineCap = 'round';
        stars.forEach((s, i) => {
          const z0 = s.z;
          s.z -= dt * 0.45;
          if (s.z <= 0.02) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; return; }
          const x0 = W / 2 + (s.x / z0) * f, y0 = H / 2 + (s.y / z0) * f;
          const x1 = W / 2 + (s.x / s.z) * f, y1 = H / 2 + (s.y / s.z) * f;
          ctx.strokeStyle = tints[i % tints.length];
          ctx.globalAlpha = Math.min(1, (1 - s.z) * 1.6);
          ctx.lineWidth = Math.max(1, (1 - s.z) * Math.min(W, H) * 0.012);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        });
        ctx.globalAlpha = 1;
      };
    },

    // Champagne: golden glass with streams of bubbles and a foamy top.
    bubbles(W, H) {
      const n = Math.round(Math.max(30, (W * H) / 1400));
      const s = Math.min(W, H);
      const make = (y) => ({ x: Math.random() * W, y: y ?? Math.random() * H, r: s * (0.006 + Math.random() * 0.02), v: 0.15 + Math.random() * 0.35, ph: Math.random() * 6 });
      const list = Array.from({ length: n }, () => make());
      let last = 0;
      return (ctx, t) => {
        const dt = last ? Math.min(0.1, t - last) : 0;
        last = t;
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#2a1300');
        g.addColorStop(0.55, '#8a4a00');
        g.addColorStop(1, '#d48a00');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        for (const b of list) {
          b.y -= b.v * H * dt * 0.35;
          if (b.y < -b.r) Object.assign(b, make(H + b.r));
          const x = b.x + Math.sin(t * 2 + b.ph) * s * 0.01;
          ctx.strokeStyle = 'rgba(255,240,200,0.75)';
          ctx.lineWidth = Math.max(1, b.r * 0.25);
          ctx.beginPath();
          ctx.arc(x, b.y, b.r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.beginPath();
          ctx.arc(x - b.r * 0.35, b.y - b.r * 0.35, Math.max(0.5, b.r * 0.25), 0, Math.PI * 2);
          ctx.fill();
        }
        const fh = H * 0.07;
        const fg = ctx.createLinearGradient(0, 0, 0, fh);
        fg.addColorStop(0, 'rgba(255,248,230,0.95)');
        fg.addColorStop(1, 'rgba(255,248,230,0)');
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, W, fh);
      };
    },

    // A neon sign: the bar's name and a cocktail glass, with the odd flicker.
    neon(W, H, opts) {
      const text = (opts.barName || 'THE BAR').toUpperCase();
      const colors = ['#ff3fd2', '#36d6ff', GOLD_LIGHT];
      let flickerAt = 4 + Math.random() * 6;
      return (ctx, t) => {
        const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
        g.addColorStop(0, '#0d0716');
        g.addColorStop(1, '#000000');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        const color = colors[Math.floor(t / 20) % colors.length];
        const glass = colors[(Math.floor(t / 20) + 1) % colors.length];
        if (t > flickerAt + 0.5) flickerAt = t + 5 + Math.random() * 8;
        const flick = t > flickerAt && t < flickerAt + 0.5 && Math.sin(t * 90) > 0 ? 0.25 : 1;
        const s = Math.min(W, H);
        const wide = W / H > 1.25;
        const gs = wide ? Math.min(H * 0.7, W * 0.3) : Math.min(W * 0.6, H * 0.42);
        const gx = wide ? W * 0.08 + gs / 2 : W / 2;
        const gy = wide ? H / 2 : H * 0.08 + gs / 2;
        // cocktail glass
        ctx.save();
        ctx.lineWidth = Math.max(1, s * 0.012);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = glass;
        glow(ctx, glass, s * 0.05, () => {
          ctx.beginPath();
          ctx.moveTo(gx - gs * 0.4, gy - gs * 0.38);
          ctx.lineTo(gx + gs * 0.4, gy - gs * 0.38);
          ctx.lineTo(gx, gy + gs * 0.05);
          ctx.closePath();
          ctx.moveTo(gx, gy + gs * 0.05);
          ctx.lineTo(gx, gy + gs * 0.36);
          ctx.moveTo(gx - gs * 0.18, gy + gs * 0.4);
          ctx.lineTo(gx + gs * 0.18, gy + gs * 0.4);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(gx + gs * 0.12, gy - gs * 0.24, gs * 0.06, 0, Math.PI * 2);
          ctx.moveTo(gx + gs * 0.12, gy - gs * 0.24);
          ctx.lineTo(gx + gs * 0.3, gy - gs * 0.5);
          ctx.stroke();
        });
        ctx.restore();
        // the name, as a tube that glows
        const tx = wide ? gx + gs / 2 + W * 0.05 : W * 0.06;
        const tw = wide ? W - tx - W * 0.05 : W * 0.88;
        const ty = wide ? 0 : gy + gs / 2 + H * 0.04;
        const th = wide ? H : H - ty - H * 0.06;
        const box = fitWrapped(ctx, text, 'Limelight', tw, th * 0.8, 3, 1.05);
        ctx.font = font('Limelight', box.size);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const y0 = ty + th / 2 - ((box.lines.length - 1) * box.size) / 2;
        ctx.globalAlpha = flick;
        ctx.lineWidth = Math.max(1, box.size * 0.05);
        ctx.strokeStyle = color;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        box.lines.forEach((l, i) => {
          const y = y0 + i * box.size;
          glow(ctx, color, box.size * 0.35, () => ctx.strokeText(l, tx + tw / 2, y));
          ctx.save();
          ctx.shadowColor = color;
          ctx.shadowBlur = box.size * 0.12;
          ctx.globalAlpha = flick * 0.9;
          ctx.fillText(l, tx + tw / 2, y);
          ctx.restore();
        });
        ctx.globalAlpha = 1;
      };
    },

    // A deco sign: slowly turning gold sunburst, stacked fan arches and the bar's name in gold,
    // with a band of light sweeping across it now and then.
    deco(W, H, opts) {
      const text = (opts.barName || 'THE BAR').toUpperCase();
      const s = Math.min(W, H);
      return (ctx, t) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        sunburst(ctx, W / 2, H * 0.98, Math.hypot(W, H), 28, GOLD, 0.16, Math.sin(t * 0.15) * 0.05);
        // fan arches rising from the bottom
        ctx.lineWidth = Math.max(1, Math.round(s * 0.008));
        for (let i = 6; i >= 1; i--) {
          const r = (s * 0.12) * i;
          ctx.strokeStyle = rgba(GOLD, 0.25 + 0.1 * Math.sin(t * 1.2 - i * 0.6));
          ctx.beginPath();
          ctx.arc(W / 2, H, r, Math.PI, 0);
          ctx.stroke();
        }
        decoFrame(ctx, W, H, GOLD);
        // the name in gold, with a light sweep
        const pad = s * 0.1;
        const box = fitWrapped(ctx, text, 'Limelight', W - pad * 2, H * 0.42, 3, 1.05);
        ctx.font = font('Limelight', box.size);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const sweep = ((t * 0.35) % 2.2) - 0.6;
        const g = ctx.createLinearGradient(0, 0, W, H * 0.3);
        g.addColorStop(0, '#b8892a');
        g.addColorStop(Math.max(0, Math.min(1, sweep - 0.08)), GOLD);
        g.addColorStop(Math.max(0, Math.min(1, sweep)), '#fffbe8');
        g.addColorStop(Math.max(0, Math.min(1, sweep + 0.08)), GOLD);
        g.addColorStop(1, '#b8892a');
        const y0 = H * 0.42 - ((box.lines.length - 1) * box.size * 1.05) / 2;
        box.lines.forEach((l, i) => {
          const y = y0 + i * box.size * 1.05;
          ctx.save();
          ctx.shadowColor = rgba(GOLD, 0.6);
          ctx.shadowBlur = box.size * 0.25;
          ctx.fillStyle = g;
          ctx.fillText(l, W / 2, y);
          ctx.restore();
        });
        const ry = y0 + (box.lines.length - 0.4) * box.size * 1.05;
        doubleRule(ctx, W * 0.2, Math.min(H * 0.8, ry), W * 0.6, s, GOLD);
      };
    },

    // Classic deco wallpaper: rows of gold fans, with a shimmer rolling across them.
    fans(W, H) {
      const s = Math.min(W, H);
      const r = Math.max(8, Math.round(s / 7));
      const tile = document.createElement('canvas');
      tile.width = r * 2;
      tile.height = r;
      const x = tile.getContext('2d');
      x.lineWidth = Math.max(1, r * 0.06);
      const fan = (cx, cy) => {
        for (let k = 4; k >= 1; k--) {
          x.fillStyle = k % 2 ? '#000' : '#140f04';
          x.beginPath();
          x.arc(cx, cy, r * (k / 4), Math.PI, 0);
          x.closePath();
          x.fill();
          x.strokeStyle = GOLD;
          x.stroke();
        }
        x.strokeStyle = rgba(GOLD, 0.7);
        for (let k = 1; k < 6; k++) {
          const a = Math.PI + (k / 6) * Math.PI;
          x.beginPath();
          x.moveTo(cx, cy);
          x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          x.stroke();
        }
      };
      fan(r, r);
      const pattern = document.createElement('canvas');
      pattern.width = W + r * 2;
      pattern.height = H + r;
      const p = pattern.getContext('2d');
      p.fillStyle = '#000';
      p.fillRect(0, 0, pattern.width, pattern.height);
      for (let row = 0, y = 0; y < pattern.height + r; row++, y += r * 0.5) {
        for (let xx = row % 2 ? -r : 0; xx < pattern.width; xx += r * 2) p.drawImage(tile, xx, y);
      }
      return (ctx, t) => {
        const drift = (t * r * 0.15) % (r * 2);
        ctx.drawImage(pattern, -drift, -((t * r * 0.08) % r));
        const pos = ((t * 0.25) % 1.6) - 0.3;
        const g = ctx.createLinearGradient(W * (pos - 0.25), 0, W * (pos + 0.25), H);
        g.addColorStop(0, 'rgba(255,240,200,0)');
        g.addColorStop(0.5, 'rgba(255,240,200,0.35)');
        g.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      };
    },

    // Club lights: coloured beams sweeping through haze.
    beams(W, H) {
      const colors = ['#ff2fb0', '#36d6ff', '#7a5cff', '#ffb000'];
      return (ctx, t) => {
        ctx.fillStyle = '#05010a';
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const n = colors.length;
        for (let i = 0; i < n; i++) {
          const ox = W * ((i + 0.5) / n);
          const a = Math.sin(t * (0.35 + i * 0.07) + i * 1.7) * 0.75;
          const len = Math.hypot(W, H) * 1.1;
          const spread = 0.09 + 0.03 * Math.sin(t + i);
          const g = ctx.createLinearGradient(ox, H, ox + Math.sin(a) * len, H - Math.cos(a) * len);
          g.addColorStop(0, rgba(colors[i], 0.75));
          g.addColorStop(1, rgba(colors[i], 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(ox, H);
          ctx.lineTo(ox + Math.sin(a - spread) * len, H - Math.cos(a - spread) * len);
          ctx.lineTo(ox + Math.sin(a + spread) * len, H - Math.cos(a + spread) * len);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = rgba(colors[i], 0.9);
          ctx.beginPath();
          ctx.arc(ox, H, Math.min(W, H) * 0.03, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      };
    },
  };
  const MIX = ['deco', 'neon', 'bubbles', 'fans', 'lava', 'beams', 'fire', 'plasma', 'warp'];

  function visuals(canvas, W, H, opts) {
    const ctx = canvas.getContext('2d');
    const style = opts.conf && EFFECTS[opts.conf.style] ? opts.conf.style : 'mix';
    let current = '', draw = null, since = 0;
    const stop = animate((t) => {
      const want = style === 'mix' ? MIX[Math.floor(t / 45) % MIX.length] : style;
      if (want !== current) { current = want; draw = EFFECTS[want](W, H, opts); since = t; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
      draw(ctx, t);
      const fade = 1 - (t - since) / 1.2;
      if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, W, H); }
    }, 30);
    return { stop };
  }

  // ------------------------------------------------------------ channel ident

  // Shown for a few seconds when the channel changes, like a TV station ident: a gold sunburst
  // fan behind the channel number, the name in deco capitals, and the bar's name.
  function drawIdent(canvas, W, H, channel, barName) {
    const theme = THEMES[channel] || THEMES.rotation;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const s = Math.min(W, H);
    const bh = Math.round(s * 0.38);
    const y = Math.round(H - bh - s * 0.07);
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, y, W, bh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, W, bh);
    ctx.clip();
    sunburst(ctx, bh * 0.62, y + bh, bh * 1.1, 18, GOLD, 0.35);
    ctx.restore();
    doubleRule(ctx, 0, y, W, s, GOLD);
    doubleRule(ctx, 0, y + bh - Math.round(s * 0.02), W, s, GOLD);
    const num = String(theme.n);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.accent;
    ctx.font = font('Anton', bh * 0.66);
    glow(ctx, theme.accent, bh * 0.2, () => ctx.fillText(num, bh * 0.62, y + bh * 0.55));
    const x = bh * 1.3;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = font('Limelight', fitSize(ctx, theme.name, 'Limelight', W - x - s * 0.05, bh * 0.36));
    ctx.fillText(theme.name, x, y + bh * 0.42);
    const sub = (barName || '').toUpperCase();
    if (sub) {
      ctx.fillStyle = GOLD_LIGHT;
      ctx.font = font('Barlow Condensed', fitSize(ctx, sub, 'Barlow Condensed', W - x - s * 0.05, bh * 0.2));
      ctx.fillText(sub, x, y + bh * 0.72);
    }
  }

  const FACTORIES = { scores, news, weather, visuals };

  window.BarChannels = {
    THEMES,
    init(helpers) { if (helpers && helpers.fontStr) fontStr = helpers.fontStr; },
    create(name, canvas, W, H, opts) {
      canvas.width = W;
      canvas.height = H;
      return (FACTORIES[name] || visuals)(canvas, W, H, opts || {});
    },
    drawIdent,
  };
})();
