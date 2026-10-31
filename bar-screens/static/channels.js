// Live channels for the bar's LED walls. Each one draws into a canvas at the wall's own pixel size
// and animates itself.
//
// The look is quiet luxury with a deco accent: black (so unused LEDs stay off), ivory type, and
// one muted gold kept for hairlines. Type does the work: Poiret One for titles, Cormorant Garamond
// for anything read like a headline, and small widely spaced Josefin Sans capitals for labels.
// Motion is slow and mostly fades.
(() => {
  'use strict';

  const GOLD = '#b89a63';
  const GOLD_LIGHT = '#d9c49a';
  const IVORY = '#ece4d4';
  const MUTED = '#8c8370';
  const THEMES = {
    rotation: { n: 1, name: 'THE BAR', accent: GOLD },
    scores: { n: 2, name: 'SCORES', accent: GOLD },
    news: { n: 3, name: 'NEWS', accent: GOLD },
    weather: { n: 4, name: 'WEATHER', accent: GOLD },
    visuals: { n: 5, name: 'VISUALS', accent: GOLD },
    games: { n: 6, name: 'GAMES', accent: GOLD },
    live: { n: 7, name: 'BASEMENT LIVE', accent: GOLD },
    pour: { n: 8, name: 'THE HOUSE POUR', accent: GOLD },
  };

  let fontStr = (name, px) => `600 ${px}px sans-serif`;
  const font = (name, px) => fontStr(name, Math.max(1, Math.round(px)));

  // ------------------------------------------------------------ helpers

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function tracking(ctx, px) {
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(px * 10) / 10}px`;
  }

  function fitSize(ctx, text, fontName, maxW, maxH) {
    let size = Math.max(4, Math.floor(maxH));
    ctx.font = font(fontName, size);
    const w = ctx.measureText(text).width;
    if (w > maxW) size = Math.max(4, Math.floor((size * maxW) / w));
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

  // Gold is always one flat, muted tone.
  function gold() {
    return GOLD;
  }

  const hair = (s) => Math.max(1, Math.round(s * 0.003));
  // The smallest text the walls can show legibly: at 256 x 384, anything under 7 LEDs tall blurs.
  const MIN_TEXT = 7;
  const small = (s) => Math.max(MIN_TEXT, Math.round(s * 0.03));

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

  // A single gold hairline, set in from the edge of the wall.
  function frame(ctx, W, H) {
    const s = Math.min(W, H);
    const lw = hair(s);
    const inset = Math.max(2, Math.round(s * 0.025)) + lw / 2;
    ctx.save();
    ctx.strokeStyle = rgba(GOLD, 0.55);
    ctx.lineWidth = lw;
    ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
    ctx.restore();
  }

  // A hairline with a small diamond set into its middle.
  function decoRule(ctx, x, y, w, s) {
    const lw = hair(s);
    const d = Math.max(2, Math.round(s * 0.009));
    const cx = x + w / 2;
    ctx.fillStyle = rgba(GOLD, 0.8);
    ctx.fillRect(x, Math.round(y), w / 2 - d * 2.5, lw);
    ctx.fillRect(cx + d * 2.5, Math.round(y), w / 2 - d * 2.5, lw);
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(cx, y - d + lw / 2); ctx.lineTo(cx + d, y + lw / 2); ctx.lineTo(cx, y + d + lw / 2); ctx.lineTo(cx - d, y + lw / 2);
    ctx.closePath();
    ctx.fill();
    return lw;
  }

  const timeStr = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function backdrop(ctx, W, H) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    frame(ctx, W, H);
  }

  // A small, widely spaced label centred at the top, with a short rule beneath. Returns its height.
  function header(ctx, W, H, theme, label) {
    const s = Math.min(W, H);
    const hh = Math.max(16, Math.round(s * 0.15));
    const text = label ? `${theme.name}  ·  ${label}` : theme.name;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    tracking(ctx, s * 0.012);
    ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, text, 'Josefin Sans', W * 0.86, Math.max(MIN_TEXT, s * 0.034))));
    ctx.fillStyle = GOLD;
    ctx.fillText(text, W / 2, hh * 0.5);
    tracking(ctx, 0);
    ctx.fillStyle = rgba(GOLD, 0.6);
    ctx.fillRect(Math.round(W / 2 - W * 0.06), Math.round(hh * 0.78), Math.round(W * 0.12), hair(s));
    return hh;
  }

  function message(ctx, W, top, H, text) {
    const pad = Math.round(W * 0.12);
    const box = fitWrapped(ctx, text, 'Cormorant Italic', W - pad * 2, (H - top) * 0.3, 3, 1.15);
    ctx.font = font('Cormorant Italic', box.size);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const y0 = top + (H - top) / 2 - ((box.lines.length - 1) * box.size * 1.15) / 2;
    box.lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * box.size * 1.15));
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

  // ------------------------------------------------------------ city (for the skyline visual)

  function rng(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A dark deco city: skyscrapers with stepped setbacks, spires and masts in two layers of
  // silhouette, plus where their windows are. Seeded, so a wall always gets the same city.
  const cities = new Map();
  function city(W, H, height) {
    const key = `${W}x${H}x${Math.round(height)}`;
    if (cities.has(key)) return cities.get(key);
    const rand = rng(W * 7919 + H * 104729);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const s = Math.min(W, H);
    const windows = [];
    const layers = [{ shade: '#120404', scale: 1, lit: 0.06, near: false }, { shade: '#000000', scale: 0.72, lit: 0.1, near: true }];
    for (const L of layers) {
      let bx = -rand() * s * 0.08;
      while (bx < W) {
        const bw = Math.max(4, s * (0.06 + rand() * 0.11));
        const bh = height * L.scale * (0.3 + rand() * 0.7);
        const top = H - bh;
        x.fillStyle = L.shade;
        x.fillRect(Math.round(bx), Math.round(top), Math.ceil(bw), Math.ceil(bh));
        let tx = bx, tw = bw, ty = top;
        const tiers = (rand() * 3) | 0;
        for (let k = 0; k < tiers; k++) {
          const nw = tw * (0.55 + rand() * 0.2), nh = bh * (0.06 + rand() * 0.09);
          tx += (tw - nw) / 2; ty -= nh; tw = nw;
          x.fillRect(Math.round(tx), Math.round(ty), Math.ceil(tw), Math.ceil(nh) + 1);
        }
        const roll = rand();
        if (roll < 0.4) {
          x.beginPath();
          x.moveTo(tx + tw * 0.3, ty + 1);
          x.lineTo(tx + tw / 2, ty - bh * (0.1 + rand() * 0.16));
          x.lineTo(tx + tw * 0.7, ty + 1);
          x.closePath();
          x.fill();
        } else if (roll < 0.7) {
          const mw = Math.max(1, Math.round(s * 0.004));
          x.fillRect(Math.round(tx + tw / 2 - mw / 2), Math.round(ty - bh * 0.12), mw, Math.ceil(bh * 0.12) + 1);
        }
        const ws = Math.max(1, Math.round(s * 0.006));
        for (let wy = top + ws * 2; wy < H - ws * 2; wy += ws * 3) {
          for (let wx = bx + ws * 1.5; wx < bx + bw - ws * 1.5; wx += ws * 2.6) {
            if (rand() < L.lit) windows.push({ x: Math.round(wx), y: Math.round(wy), w: ws, h: Math.max(1, Math.round(ws * 1.4)), near: L.near, phase: rand() * 1000 });
          }
        }
        bx += bw + (rand() < 0.25 ? s * 0.012 : 0);
      }
    }
    const out = { canvas: c, windows };
    if (cities.size > 8) cities.clear();
    cities.set(key, out);
    return out;
  }

  // ------------------------------------------------------------ scores

  function kickoff(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    if (d.toDateString() === new Date().toDateString()) return timeStr(d);
    return d.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
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

  function scores(canvas, W, H) {
    const theme = THEMES.scores;
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    let payload = null, failed = false, pages = [], pageIndex = 0, pageStart = 0, built = '';
    const stopFeed = feed('scores', (j) => { if (j && j.data) payload = j.data; failed = !j || (!j.ok && !j.data); });

    const stop = animate((t) => {
      backdrop(ctx, W, H);
      const hh = header(ctx, W, H, theme);
      if (!payload) { message(ctx, W, hh, H, failed ? 'The scores are unavailable just now' : 'Fetching the scores…'); return; }
      const pad = Math.round(s * 0.09);
      const titleH = Math.round(s * 0.1);
      const footH = Math.round(s * 0.07);
      const avail = H - hh - titleH - footH - pad * 0.5;
      const rows = Math.max(1, Math.floor(avail / Math.max(10, s * 0.11)));
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
      if (!pages.length) { message(ctx, W, hh, H, 'No fixtures this week'); return; }
      if (t - pageStart > 10) { pageIndex = (pageIndex + 1) % pages.length; pageStart = t; }
      const page = pages[pageIndex];
      const since = t - pageStart;
      const fade = Math.min(1, since / 0.8);
      // rows grow to fill the space when there are only a few matches
      const rowH = Math.round(Math.min(s * 0.17, avail / Math.max(page.rows.length, 4)));

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      tracking(ctx, s * 0.006);
      ctx.font = font('Poiret One', fitSize(ctx, page.name.toUpperCase(), 'Poiret One', W - pad * 2, titleH * 0.62));
      ctx.fillStyle = IVORY;
      ctx.fillText(page.name.toUpperCase(), W / 2, hh + titleH * 0.4);
      tracking(ctx, 0);

      const top = hh + titleH;
      const statusW = W * 0.26;
      const teamsW = W - pad * 2 - statusW - s * 0.03;
      page.rows.forEach((m, i) => {
        const a = Math.min(1, Math.max(0, (since - i * 0.08) / 0.6));
        if (a <= 0) return;
        ctx.globalAlpha = a * fade;
        const y = top + i * rowH;
        const cy = y + rowH / 2;
        const live = m.state === 'in';
        ctx.fillStyle = rgba(GOLD, 0.22);
        ctx.fillRect(pad, Math.round(y + rowH) - 1, W - pad * 2, hair(s));
        tracking(ctx, s * 0.006);
        ctx.font = font('Josefin Sans', rowH * 0.34);
        ctx.fillStyle = IVORY;
        ctx.textAlign = 'left';
        ctx.fillText(m.home.abbr, pad, cy + 1);
        ctx.textAlign = 'right';
        ctx.fillText(m.away.abbr, pad + teamsW, cy + 1);
        tracking(ctx, 0);
        ctx.textAlign = 'center';
        ctx.font = font('Josefin Light', rowH * 0.5);
        ctx.fillStyle = live ? GOLD_LIGHT : IVORY;
        ctx.fillText(m.state === 'pre' ? '·' : `${m.home.score} – ${m.away.score}`, pad + teamsW / 2, cy + 1);
        const status = m.state === 'pre' ? kickoff(m.date) : (m.detail || m.clock || '').toUpperCase();
        tracking(ctx, s * 0.004);
        ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, status, 'Josefin Sans', statusW * 0.95, rowH * 0.3)));
        ctx.textAlign = 'right';
        ctx.fillStyle = live ? GOLD : MUTED;
        ctx.fillText(status, W - pad, cy + 1);
        tracking(ctx, 0);
        if (live) {
          ctx.globalAlpha = a * fade * (0.45 + 0.55 * Math.abs(Math.sin(t * 1.6)));
          ctx.fillStyle = GOLD;
          ctx.beginPath();
          ctx.arc(W - pad - ctx.measureText(status).width - rowH * 0.2, cy, Math.max(1, rowH * 0.05), 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.globalAlpha = fade;
      if (pages.length > 1) {
        tracking(ctx, s * 0.01);
        ctx.font = font('Josefin Sans', small(s));
        ctx.fillStyle = MUTED;
        ctx.textAlign = 'center';
        ctx.fillText(`${pageIndex + 1} / ${pages.length}`, W / 2, H - footH * 0.7);
        tracking(ctx, 0);
      }
      ctx.restore();
    }, 30);
    return { stop() { stop(); stopFeed(); } };
  }

  // ------------------------------------------------------------ news

  function news(canvas, W, H) {
    const theme = THEMES.news;
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    let payload = null, failed = false, items = [], index = 0, shownAt = 0, strip = null, stripKey = '';
    const stopFeed = feed('news', (j) => { if (j && j.data) payload = j.data; failed = !j || (!j.ok && !j.data); });

    function buildStrip(h) {
      const text = items.map((i) => i.title).join('      ◆      ') + '      ◆      ';
      const c = document.createElement('canvas');
      const m = c.getContext('2d');
      const size = Math.max(7, h * 0.42);
      m.font = font('Cormorant', size);
      c.width = Math.min(30000, Math.ceil(m.measureText(text).width));
      c.height = h;
      m.font = font('Cormorant', size);
      m.textBaseline = 'middle';
      m.fillStyle = IVORY;
      m.fillText(text, 0, h / 2);
      return c;
    }

    const stop = animate((t) => {
      backdrop(ctx, W, H);
      const hh = header(ctx, W, H, theme, payload ? payload.section.toUpperCase() : '');
      if (!payload) { message(ctx, W, hh, H, failed ? 'The news is unavailable just now' : 'Fetching the headlines…'); return; }
      if (items !== payload.items) { items = payload.items; index = 0; shownAt = t; }
      if (t - shownAt > 12) { index = (index + 1) % items.length; shownAt = t; }
      const since = t - shownAt;
      const pad = Math.round(s * 0.1);
      const tickH = Math.max(12, Math.round(s * 0.1));
      const bodyTop = hh + pad * 0.3;
      const bodyH = H - hh - tickH - pad * 1.2;

      // the headline, fading in and out
      const alpha = Math.min(1, since / 1, (12 - since) / 0.8);
      const box = fitWrapped(ctx, items[index].title, 'Cormorant', W - pad * 2, bodyH * 0.78, 5, 1.12);
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.font = font('Cormorant', box.size);
      ctx.fillStyle = IVORY;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const blockH = box.lines.length * box.size * 1.12;
      const y0 = bodyTop + (bodyH - blockH) / 2 + box.size * 0.56;
      box.lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * box.size * 1.12));
      const ry = y0 + (box.lines.length - 0.35) * box.size * 1.12;
      decoRule(ctx, W / 2 - W * 0.12, ry, W * 0.24, s);
      tracking(ctx, s * 0.012);
      ctx.font = font('Josefin Sans', small(s));
      ctx.fillStyle = MUTED;
      ctx.fillText((payload.source || '').toUpperCase(), W / 2, ry + s * 0.045);
      tracking(ctx, 0);
      ctx.restore();

      // a slow ticker of the other headlines, fading out at both edges
      const ty = H - tickH - Math.round(s * 0.035);
      ctx.fillStyle = rgba(GOLD, 0.45);
      ctx.fillRect(pad, ty, W - pad * 2, hair(s));
      const fontsReady = !document.fonts || document.fonts.check(font('Cormorant', 20));
      const key = `${tickH}|${items.length}|${items[0].title}|${fontsReady}`;
      if (key !== stripKey) { stripKey = key; strip = buildStrip(tickH); }
      const offset = (t * tickH * 1.3) % strip.width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad, ty + 1, W - pad * 2, tickH);
      ctx.clip();
      for (let x = pad - offset; x < W; x += strip.width) ctx.drawImage(strip, Math.round(x), ty + 1);
      const fadeW = (W - pad * 2) * 0.12;
      for (const [x0, x1] of [[pad, pad + fadeW], [W - pad, W - pad - fadeW]]) {
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(x0, x1), ty + 1, fadeW, tickH);
      }
      ctx.restore();
    }, 30);
    return { stop() { stop(); stopFeed(); } };
  }

  // ------------------------------------------------------------ weather

  const WX = [
    [[0], 'clear', 'Clear'], [[1], 'clear', 'Mostly clear'], [[2], 'partly', 'Partly cloudy'], [[3], 'cloud', 'Overcast'],
    [[45, 48], 'fog', 'Fog'], [[51, 53, 55], 'drizzle', 'Drizzle'], [[56, 57], 'drizzle', 'Freezing drizzle'],
    [[61], 'rain', 'Light rain'], [[63], 'rain', 'Rain'], [[65], 'rain', 'Heavy rain'], [[66, 67], 'rain', 'Freezing rain'],
    [[71], 'snow', 'Light snow'], [[73], 'snow', 'Snow'], [[75], 'snow', 'Heavy snow'], [[77], 'snow', 'Snow grains'],
    [[80], 'rain', 'Showers'], [[81], 'rain', 'Heavy showers'], [[82], 'rain', 'Violent showers'], [[85, 86], 'snow', 'Snow showers'],
    [[95], 'storm', 'Thunderstorm'], [[96, 99], 'storm', 'Thunder and hail'],
  ];
  const wx = (code) => WX.find(([codes]) => codes.includes(code)) || [[], 'cloud', 'Overcast'];

  // Line-drawn cloud: the union of three circles and a base, drawn as one outline.
  function cloudLine(ctx, x, y, s, lw) {
    const parts = [[x - s * 0.18, y + s * 0.03, s * 0.14], [x + s * 0.02, y - s * 0.07, s * 0.19], [x + s * 0.21, y + s * 0.05, s * 0.12]];
    const base = [x - s * 0.32, y + s * 0.03, s * 0.65, s * 0.14];
    ctx.lineWidth = lw;
    for (const [cx, cy, r] of parts) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
    roundRect(ctx, base[0], base[1], base[2], base[3], base[3] / 2);
    ctx.stroke();
    ctx.fillStyle = '#000';
    for (const [cx, cy, r] of parts) { ctx.beginPath(); ctx.arc(cx, cy, r - lw * 0.9, 0, Math.PI * 2); ctx.fill(); }
    roundRect(ctx, base[0] + lw * 0.9, base[1] + lw * 0.9, base[2] - lw * 1.8, base[3] - lw * 1.8, base[3] / 2 - lw);
    ctx.fill();
  }

  // Monochrome line icons, centred on (x, y) and about s pixels across.
  function weatherIcon(ctx, kind, x, y, s, t, day) {
    const lw = Math.max(1, Math.round(s * 0.035));
    ctx.save();
    ctx.strokeStyle = GOLD;
    ctx.fillStyle = GOLD;
    ctx.lineCap = 'round';
    const sun = (cx, cy, r) => {
      ctx.lineWidth = lw;
      if (!day) {
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r + lw, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(cx + r * 0.5, cy - r * 0.35, r * 0.85, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + r * 0.5, cy - r * 0.35, r * 0.85, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        return;
      }
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = t * 0.08 + (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * 1.45, cy + Math.sin(a) * r * 1.45);
        ctx.lineTo(cx + Math.cos(a) * r * 1.8, cy + Math.sin(a) * r * 1.8);
        ctx.stroke();
      }
    };
    if (kind === 'clear') sun(x, y, s * 0.2);
    else if (kind === 'partly') { sun(x + s * 0.13, y - s * 0.13, s * 0.14); cloudLine(ctx, x - s * 0.05, y + s * 0.08, s * 0.9, lw); }
    else if (kind === 'fog') {
      ctx.lineWidth = lw;
      [0.7, 0.9, 0.55].forEach((w, i) => {
        const dx = Math.sin(t * 0.4 + i) * s * 0.04;
        ctx.beginPath(); ctx.moveTo(x - (s * w) / 2 + dx, y - s * 0.15 + i * s * 0.15); ctx.lineTo(x + (s * w) / 2 + dx, y - s * 0.15 + i * s * 0.15); ctx.stroke();
      });
    } else {
      const cy = kind === 'cloud' ? y : y - s * 0.1;
      cloudLine(ctx, x, cy, s, lw);
      ctx.strokeStyle = GOLD;
      ctx.fillStyle = GOLD;
      ctx.lineWidth = lw;
      if (kind === 'rain' || kind === 'drizzle') {
        for (let i = 0; i < 3; i++) {
          const p = (t * 0.6 + i * 0.33) % 1;
          ctx.globalAlpha = 1 - p * 0.8;
          const dx = x - s * 0.16 + i * s * 0.16, dy = cy + s * 0.24 + p * s * 0.16;
          ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx - s * 0.04, dy + s * 0.09); ctx.stroke();
        }
      } else if (kind === 'snow') {
        for (let i = 0; i < 3; i++) {
          const p = (t * 0.3 + i * 0.33) % 1;
          ctx.globalAlpha = 1 - p * 0.7;
          ctx.beginPath(); ctx.arc(x - s * 0.16 + i * s * 0.16, cy + s * 0.27 + p * s * 0.16, Math.max(1, lw), 0, Math.PI * 2); ctx.fill();
        }
      } else if (kind === 'storm') {
        ctx.beginPath();
        ctx.moveTo(x + s * 0.03, cy + s * 0.2); ctx.lineTo(x - s * 0.05, cy + s * 0.34); ctx.lineTo(x + s * 0.03, cy + s * 0.34); ctx.lineTo(x - s * 0.04, cy + s * 0.48);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function weather(canvas, W, H) {
    const theme = THEMES.weather;
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    let payload = null, failed = false;
    const stopFeed = feed('weather', (j) => { if (j && j.data) payload = j.data; failed = !j || (!j.ok && !j.data); });

    const stop = animate((t) => {
      backdrop(ctx, W, H);
      const label = payload && payload.place ? payload.place.toUpperCase() : '';
      const hh = header(ctx, W, H, theme, label);
      if (!payload) { message(ctx, W, hh, H, failed ? 'The forecast is unavailable just now' : 'Fetching the forecast…'); return; }
      if (payload.needsPlace) { message(ctx, W, hh, H, 'Set your town in Channel settings on your phone'); return; }
      const pad = Math.round(s * 0.09);
      const now = payload.now;
      const [, kind, desc] = wx(now.code);
      const nowH = (H - hh) * 0.5;
      const top = hh;

      // now: icon and temperature side by side, centred, with the conditions underneath
      const temp = `${Math.round(now.temp)}°`;
      const tempSize = Math.round(Math.min(nowH * 0.55, W * 0.24));
      ctx.font = font('Josefin Light', tempSize);
      const tw = ctx.measureText(temp).width;
      const iconS = tempSize * 0.95;
      const gap = s * 0.04;
      const x0 = (W - (iconS + gap + tw)) / 2;
      const cy = top + nowH * 0.42;
      weatherIcon(ctx, kind, x0 + iconS / 2, cy, iconS, t, now.day);
      ctx.font = font('Josefin Light', tempSize);
      ctx.fillStyle = IVORY;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(temp, x0 + iconS + gap, cy + tempSize * 0.04);
      ctx.textAlign = 'center';
      ctx.font = font('Cormorant Italic', fitSize(ctx, desc, 'Cormorant Italic', W - pad * 2, nowH * 0.16));
      ctx.fillStyle = GOLD_LIGHT;
      ctx.fillText(desc, W / 2, top + nowH * 0.8);
      let extra = `FEELS ${Math.round(now.feels)}°   ·   WIND ${Math.round(now.wind)} MPH`;
      tracking(ctx, s * 0.008);
      if (fitSize(ctx, extra, 'Josefin Sans', W - pad * 2, small(s)) < MIN_TEXT) extra = `FEELS ${Math.round(now.feels)}°`;
      ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, extra, 'Josefin Sans', W - pad * 2, small(s))));
      ctx.fillStyle = MUTED;
      ctx.fillText(extra, W / 2, top + nowH * 0.95);
      tracking(ctx, 0);

      // forecast: the next few hours, then the next few days, as quiet columns
      const phaseT = t % 20;
      const showDays = phaseT >= 10 || !payload.hours.length;
      const fade = Math.min(1, (phaseT % 10) / 0.8, (10 - (phaseT % 10)) / 0.8);
      const fy = top + nowH + s * 0.05;
      const fh = H - fy - pad * 0.8;
      const cols = W >= H ? 4 : 3;
      const list = showDays ? payload.days.slice(0, cols) : payload.hours.slice(0, cols);
      const cw = (W - pad * 2) / cols;
      ctx.fillStyle = rgba(GOLD, 0.35);
      ctx.fillRect(pad, Math.round(fy), W - pad * 2, hair(s));
      ctx.save();
      ctx.globalAlpha = Math.max(0, fade);
      list.forEach((f, i) => {
        const cx = pad + cw * i + cw / 2;
        if (i > 0) { ctx.fillStyle = rgba(GOLD, 0.2); ctx.fillRect(Math.round(pad + cw * i), fy + fh * 0.15, hair(s), fh * 0.7); }
        const name = showDays ? (i === 0 ? 'TODAY' : new Date(f.date + 'T12:00').toLocaleDateString([], { weekday: 'short' }).toUpperCase()) : f.time;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        tracking(ctx, s * 0.008);
        ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, name, 'Josefin Sans', cw * 0.85, Math.max(MIN_TEXT, fh * 0.12))));
        ctx.fillStyle = MUTED;
        ctx.fillText(name, cx, fy + fh * 0.2);
        tracking(ctx, 0);
        weatherIcon(ctx, wx(f.code)[1], cx, fy + fh * 0.5, Math.min(cw * 0.55, fh * 0.34), t + i, true);
        const temps = showDays ? `${Math.round(f.max)}°  ${Math.round(f.min)}°` : `${Math.round(f.temp)}°`;
        ctx.font = font('Josefin Light', fitSize(ctx, temps, 'Josefin Light', cw * 0.85, fh * 0.18));
        ctx.fillStyle = IVORY;
        ctx.fillText(temps, cx, fy + fh * 0.82);
      });
      ctx.restore();
    }, 24);
    return { stop() { stop(); stopFeed(); } };
  }

  // ------------------------------------------------------------ visuals

  function monogram(name) {
    const words = (name || '').toUpperCase().split(/\s+/).filter((w) => w && !['THE', 'A', 'AN', 'AT'].includes(w));
    return (words.length ? words : ['B']).slice(0, 2).map((w) => w[0]).join('');
  }

  // The bar's name in fine capitals over a rule, with an optional line underneath.
  function nameplate(ctx, name, sub, box, s) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    tracking(ctx, s * 0.014);
    const b = fitWrapped(ctx, name, 'Poiret One', box.w, box.h * 0.55, 2, 1.12);
    ctx.font = font('Poiret One', b.size);
    ctx.fillStyle = IVORY;
    const y0 = box.y + box.h * 0.12 + b.size / 2;
    b.lines.forEach((l, i) => ctx.fillText(l, box.x + box.w / 2, y0 + i * b.size * 1.12));
    const ry = y0 + (b.lines.length - 0.4) * b.size * 1.12;
    decoRule(ctx, box.x + box.w * 0.25, ry, box.w * 0.5, s);
    if (sub) {
      tracking(ctx, s * 0.016);
      ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, sub, 'Josefin Sans', box.w * 0.9, Math.max(MIN_TEXT, b.size * 0.24))));
      ctx.fillStyle = GOLD;
      ctx.fillText(sub, box.x + box.w / 2, ry + b.size * 0.5);
    }
    tracking(ctx, 0);
  }

  // One banana leaf: a stem, then a long blade along a gently curving midrib, with parallel veins
  // and the odd tear in its edge. Back leaves are dimmer; each one fills dark so leaves behind it
  // don't show through.
  function drawLeaf(ctx, L, t, s) {
    const sway = Math.sin(t * 0.22 + L.phase) * 0.035;
    const bend = L.bend + Math.sin(t * 0.16 + L.phase * 1.3) * 0.04;
    const N = 60, step = L.len / N, start = 0.16;
    const pts = [];
    let x = L.bx, y = L.by;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const ang = L.angle + sway + bend * u * u;
      pts.push({ x, y, ang, u });
      x += Math.sin(ang) * step;
      y -= Math.cos(ang) * step;
    }
    const halfWidth = (p, side) => {
      if (p.u < start) return 0;
      const v = (p.u - start) / (1 - start);
      let w = L.width * Math.pow(Math.sin(Math.PI * Math.min(1, v)), 0.6);
      for (const tear of L.tears) if (tear.side === side) w *= 1 - 0.8 * Math.exp(-(((v - tear.at) / 0.014) ** 2));
      return w;
    };
    const edge = (p, side) => {
      const w = halfWidth(p, side) * side;
      return [p.x + Math.cos(p.ang) * w, p.y + Math.sin(p.ang) * w];
    };
    const blade = pts.filter((p) => p.u >= start);
    const lw = hair(s);
    const a = 0.3 + L.depth * 0.55;
    ctx.beginPath();
    blade.forEach((p, i) => { const [ex, ey] = edge(p, 1); if (i) ctx.lineTo(ex, ey); else ctx.moveTo(ex, ey); });
    for (let i = blade.length - 1; i >= 0; i--) { const [ex, ey] = edge(blade[i], -1); ctx.lineTo(ex, ey); }
    ctx.closePath();
    ctx.fillStyle = `rgba(6, 18, 12, ${0.75 + L.depth * 0.2})`;
    ctx.fill();
    ctx.strokeStyle = rgba(GOLD, a);
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.strokeStyle = rgba(GOLD, a * 0.35);
    for (let i = 3; i < blade.length - 3; i += 2) {
      const p = blade[i], q = blade[Math.min(blade.length - 1, i + 3)];
      for (const side of [1, -1]) {
        const [ex, ey] = edge(q, side);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ex, ey); ctx.stroke();
      }
    }
    ctx.strokeStyle = rgba(GOLD, Math.min(1, a + 0.15));
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }

  const EFFECTS = {
    // Banana leaves in fine gold line, after the wallpaper through the house, swaying slowly.
    botanical(W, H) {
      const s = Math.min(W, H);
      const rand = rng(Math.round(W * 13 + H * 7));
      const leaves = Array.from({ length: 8 }, (_, i) => {
        const fromLeft = i % 2 === 0;
        return {
          bx: W * (fromLeft ? -0.08 + rand() * 0.4 : 0.68 + rand() * 0.4),
          by: H * (1.02 + rand() * 0.06),
          angle: (fromLeft ? 1 : -1) * (0.1 + rand() * 0.45),
          len: H * (0.6 + rand() * 0.45),
          width: s * (0.13 + rand() * 0.08),
          bend: (fromLeft ? 1 : -1) * (0.2 + rand() * 0.3),
          phase: rand() * 6.28,
          depth: i / 7,
          tears: Array.from({ length: 2 + ((rand() * 4) | 0) }, () => ({ at: 0.2 + rand() * 0.65, side: rand() < 0.5 ? 1 : -1 })),
        };
      });
      return (ctx, t) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        for (const L of leaves) drawLeaf(ctx, L, t, s);
        const g = ctx.createLinearGradient(0, 0, 0, H * 0.45);
        g.addColorStop(0, 'rgba(0,0,0,0.9)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H * 0.45);
      };
    },

    // The bar's sign: a monogram inside a stepped deco archway, the name underneath.
    deco(W, H, opts) {
      const name = (opts.barName || 'THE BASEMENT').toUpperCase();
      const mono = monogram(name);
      const s = Math.min(W, H);
      const wide = W / H > 1.3;
      const aw = wide ? Math.min(H * 0.48, W * 0.25) : Math.min(W * 0.36, H * 0.3);
      const ah = aw * 1.4;
      const ax = wide ? W * 0.12 + aw / 2 + aw * 0.3 : W / 2;
      const ay = wide ? H / 2 : H * 0.12 + ah / 2;
      const lw = hair(s) + (s > 300 ? 1 : 0);
      const arch = (ctx, inset) => {
        const r = aw / 2 - inset, top = ay - ah / 2 + inset, bottom = ay + ah / 2 - inset;
        ctx.beginPath();
        ctx.moveTo(ax - r, bottom);
        ctx.lineTo(ax - r, top + r);
        ctx.arc(ax, top + r, r, Math.PI, 0);
        ctx.lineTo(ax + r, bottom);
        ctx.closePath();
      };
      return (ctx) => {
        backdrop(ctx, W, H);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = lw;
        arch(ctx, 0);
        ctx.stroke();
        ctx.strokeStyle = rgba(GOLD, 0.45);
        arch(ctx, lw * 4);
        ctx.stroke();
        // stepped shoulders, one ziggurat outline each side
        ctx.strokeStyle = rgba(GOLD, 0.7);
        const bottom = ay + ah / 2, step = aw * 0.08, gap = lw * 4;
        const heights = [ah * 0.36, ah * 0.25, ah * 0.14];
        for (const dir of [-1, 1]) {
          const x0 = ax + dir * (aw / 2 + gap);
          ctx.beginPath();
          ctx.moveTo(x0, bottom);
          heights.forEach((h, i) => { ctx.lineTo(x0 + dir * step * i, bottom - h); ctx.lineTo(x0 + dir * step * (i + 1), bottom - h); });
          ctx.lineTo(x0 + dir * step * heights.length, bottom);
          ctx.stroke();
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font('Poiret One', fitSize(ctx, mono, 'Poiret One', aw * 0.6, ah * 0.4));
        ctx.fillStyle = GOLD;
        ctx.fillText(mono, ax, ay + ah * 0.12);
        const box = wide
          ? { x: ax + aw / 2 + aw * 0.45, y: H * 0.22, w: W - (ax + aw / 2 + aw * 0.45) - W * 0.08, h: H * 0.56 }
          : { x: W * 0.12, y: ay + ah / 2 + s * 0.06, w: W * 0.76, h: H - (ay + ah / 2) - s * 0.16 };
        nameplate(ctx, name, '', box, s);
      };
    },

    // A 1930s lift floor indicator. The needle rests on B, now and then rises to the top floor,
    // and comes back down to The Basement.
    lift(W, H, opts) {
      const name = (opts.barName || 'THE BASEMENT').toUpperCase();
      const floors = ['B', 'G', '1', '2', '3', '4', '5'];
      const topFloor = floors.length - 1;
      const s = Math.min(W, H);
      const wide = W / H > 1.3;
      const R = wide ? Math.min(H * 0.48, W * 0.22) : Math.min(W * 0.36, H * 0.28);
      const cx = wide ? W * 0.12 + R : W / 2;
      const cy = wide ? H * 0.62 : H * 0.12 + R;
      const lw = hair(s);
      const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2);
      const floorAt = (t) => {
        const p = t % 45;
        if (p < 24) return 0;
        if (p < 31) return ease((p - 24) / 7) * topFloor;
        if (p < 34) return topFloor;
        return (1 - ease((p - 34) / 11)) * topFloor;
      };
      const angle = (pos) => Math.PI + (0.08 + (pos / topFloor) * 0.84) * Math.PI;
      return (ctx, t) => {
        backdrop(ctx, W, H);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = lw;
        for (const k of [1, 0.92]) { ctx.beginPath(); ctx.arc(cx, cy, R * k, Math.PI, 0); ctx.stroke(); }
        ctx.beginPath(); ctx.moveTo(cx - R * 1.06, cy); ctx.lineTo(cx + R * 1.06, cy); ctx.stroke();
        ctx.strokeStyle = rgba(GOLD, 0.45);
        ctx.beginPath(); ctx.moveTo(cx - R * 0.8, cy + R * 0.07); ctx.lineTo(cx + R * 0.8, cy + R * 0.07); ctx.stroke();
        const pos = floorAt(t);
        const moving = Math.abs(floorAt(t + 0.1) - pos) > 0.0005;
        const goingUp = floorAt(t + 0.1) > pos;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font('Poiret One', R * 0.16);
        floors.forEach((f, i) => {
          const a = angle(i);
          const lit = Math.abs(pos - i) < 0.3;
          ctx.fillStyle = lit ? IVORY : rgba(GOLD, 0.6);
          ctx.fillText(f, cx + Math.cos(a) * R * 0.74, cy + Math.sin(a) * R * 0.74);
          ctx.fillStyle = rgba(GOLD, lit ? 1 : 0.6);
          ctx.fillRect(cx + Math.cos(a) * R * 0.96 - lw, cy + Math.sin(a) * R * 0.96 - lw, lw * 2, lw * 2);
        });
        const a = angle(pos);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R * 0.58, cy + Math.sin(a) * R * 0.58);
        ctx.stroke();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.05, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        const status = moving ? (goingUp ? 'GOING UP' : 'GOING DOWN') : pos < 0.3 ? 'FLOOR  B' : `FLOOR  ${floors[Math.round(pos)]}`;
        const box = wide
          ? { x: cx + R * 1.3, y: H * 0.2, w: W - (cx + R * 1.3) - W * 0.08, h: H * 0.6 }
          : { x: W * 0.12, y: cy + R * 0.2 + s * 0.04, w: W * 0.76, h: H - cy - R * 0.2 - s * 0.14 };
        nameplate(ctx, name, status, box, s);
      };
    },

    // An art deco wall clock: numerals at the quarters, slim lozenge hands, a sweeping seconds
    // hand, and the bar's name and the date beside it.
    clockface(W, H, opts) {
      const name = (opts.barName || 'THE BASEMENT').toUpperCase();
      const s = Math.min(W, H);
      const wide = W / H > 1.3;
      const R = wide ? Math.min(H * 0.38, W * 0.22) : Math.min(W * 0.36, H * 0.28);
      const cx = wide ? W * 0.12 + R : W / 2;
      const cy = wide ? H / 2 : H * 0.12 + R;
      const lw = hair(s);
      const hand = (ctx, a, len, wid) => {
        const c = Math.cos(a), sn = Math.sin(a), pc = Math.cos(a + Math.PI / 2), ps = Math.sin(a + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(cx - c * len * 0.1, cy - sn * len * 0.1);
        ctx.lineTo(cx + c * len * 0.3 + pc * wid, cy + sn * len * 0.3 + ps * wid);
        ctx.lineTo(cx + c * len, cy + sn * len);
        ctx.lineTo(cx + c * len * 0.3 - pc * wid, cy + sn * len * 0.3 - ps * wid);
        ctx.closePath();
        ctx.fill();
      };
      return (ctx) => {
        const now = new Date();
        backdrop(ctx, W, H);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = rgba(GOLD, 0.4);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.93, 0, Math.PI * 2); ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font('Poiret One', R * 0.18);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
          if (i % 3 === 0) {
            ctx.fillStyle = IVORY;
            ctx.fillText(String(i === 0 ? 12 : i), cx + Math.cos(a) * R * 0.76, cy + Math.sin(a) * R * 0.76 + R * 0.01);
          } else {
            ctx.fillStyle = GOLD;
            ctx.beginPath(); ctx.arc(cx + Math.cos(a) * R * 0.8, cy + Math.sin(a) * R * 0.8, Math.max(1, R * 0.015), 0, Math.PI * 2); ctx.fill();
          }
        }
        const secs = now.getSeconds() + now.getMilliseconds() / 1000;
        const mins = now.getMinutes() + secs / 60;
        const hrs = (now.getHours() % 12) + mins / 60;
        ctx.fillStyle = GOLD;
        hand(ctx, (hrs / 12) * Math.PI * 2 - Math.PI / 2, R * 0.48, R * 0.035);
        hand(ctx, (mins / 60) * Math.PI * 2 - Math.PI / 2, R * 0.74, R * 0.026);
        const sa = (secs / 60) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = IVORY;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(sa) * R * 0.14, cy - Math.sin(sa) * R * 0.14);
        ctx.lineTo(cx + Math.cos(sa) * R * 0.84, cy + Math.sin(sa) * R * 0.84);
        ctx.stroke();
        ctx.fillStyle = GOLD;
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.03, 0, Math.PI * 2); ctx.fill();
        const date = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }).replace(/,/g, '').toUpperCase();
        const box = wide
          ? { x: cx + R * 1.3, y: H * 0.22, w: W - (cx + R * 1.3) - W * 0.08, h: H * 0.56 }
          : { x: W * 0.12, y: cy + R + s * 0.05, w: W * 0.76, h: H - cy - R - s * 0.14 };
        nameplate(ctx, name, date, box, s);
      };
    },

    // Dark deco city at dusk: an oxblood sky, faint searchlights, an airship gliding past, and
    // windows going on and off.
    skyline(W, H) {
      const s = Math.min(W, H);
      const town = city(W, H, H * 0.6);
      const rand = rng(W + H * 3);
      const clouds = Array.from({ length: 5 }, () => ({ y: H * (0.08 + rand() * 0.4), w: W * (0.35 + rand() * 0.5), h: s * (0.015 + rand() * 0.03), x: rand() * W, v: 0.003 + rand() * 0.006 }));
      const lights = [0.25, 0.7].map((p, i) => ({ x: W * p, speed: 0.12 + i * 0.05, phase: i * 2.1 }));
      return (ctx, t) => {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#000000');
        g.addColorStop(0.55, '#140504');
        g.addColorStop(1, '#3a0e09');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        for (const c of clouds) {
          const cx = ((c.x + t * c.v * W) % (W + c.w)) - c.w / 2;
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.beginPath(); ctx.ellipse(cx, c.y, c.w / 2, c.h, 0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const len = Math.hypot(W, H) * 1.2;
        for (const L of lights) {
          const a = Math.sin(t * L.speed + L.phase) * 0.5;
          const beam = ctx.createLinearGradient(L.x, H, L.x + Math.sin(a) * len, H - Math.cos(a) * len);
          beam.addColorStop(0, 'rgba(236,228,212,0.16)');
          beam.addColorStop(1, 'rgba(236,228,212,0)');
          ctx.fillStyle = beam;
          ctx.beginPath();
          ctx.moveTo(L.x - s * 0.008, H);
          ctx.lineTo(L.x + Math.sin(a - 0.03) * len, H - Math.cos(a - 0.03) * len);
          ctx.lineTo(L.x + Math.sin(a + 0.03) * len, H - Math.cos(a + 0.03) * len);
          ctx.lineTo(L.x + s * 0.008, H);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        const rx = s * 0.11, ry = rx * 0.3;
        const ax = ((t * W * 0.01) % (W + rx * 4)) - rx * 2;
        const ay = H * 0.2 + Math.sin(t * 0.3) * s * 0.008;
        ctx.fillStyle = '#030101';
        ctx.beginPath(); ctx.ellipse(ax, ay, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(ax - rx * 0.8, ay); ctx.lineTo(ax - rx * 1.12, ay - ry * 1.05); ctx.lineTo(ax - rx * 1.02, ay); ctx.lineTo(ax - rx * 1.12, ay + ry * 1.05);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(ax - rx * 0.22, ay + ry * 0.85, rx * 0.44, ry * 0.4);
        if ((t % 2) < 0.15) { ctx.fillStyle = '#d24a2a'; ctx.beginPath(); ctx.arc(ax - rx * 1.08, ay, Math.max(1, s * 0.005), 0, Math.PI * 2); ctx.fill(); }
        ctx.drawImage(town.canvas, 0, 0);
        for (const w of town.windows) {
          if (Math.sin(t * 0.04 + w.phase) <= -0.5) continue;
          ctx.fillStyle = w.near ? 'rgba(232,196,140,0.75)' : 'rgba(160,110,70,0.5)';
          ctx.fillRect(w.x, w.y, w.w, w.h);
        }
        frame(ctx, W, H);
      };
    },

    // Fine gold bubbles rising slowly through black, like a glass of champagne in low light.
    bubbles(W, H) {
      const s = Math.min(W, H);
      const n = Math.round(Math.max(24, (W * H) / 2600));
      const make = (y) => ({ x: Math.random() * W, y: y ?? Math.random() * H, r: s * (0.004 + Math.random() * 0.012), v: 0.04 + Math.random() * 0.1, ph: Math.random() * 6 });
      const list = Array.from({ length: n }, () => make());
      let last = 0;
      return (ctx, t) => {
        const dt = last ? Math.min(0.1, t - last) : 0;
        last = t;
        backdrop(ctx, W, H);
        ctx.lineWidth = hair(s);
        for (const b of list) {
          b.y -= b.v * H * dt;
          if (b.y < -b.r) Object.assign(b, make(H + b.r));
          const x = b.x + Math.sin(t * 0.8 + b.ph) * s * 0.006;
          ctx.strokeStyle = rgba(GOLD, Math.min(0.9, 0.35 + 0.5 * (1 - b.y / H)));
          ctx.beginPath(); ctx.arc(x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
        }
      };
    },

    // Deco wallpaper: rows of fine gold fans, drifting very slowly.
    fans(W, H) {
      const s = Math.min(W, H);
      const r = Math.max(8, Math.round(s / 6));
      const tile = document.createElement('canvas');
      tile.width = r * 2;
      tile.height = r;
      const x = tile.getContext('2d');
      x.lineWidth = Math.max(1, hair(s));
      for (let k = 4; k >= 1; k--) {
        x.fillStyle = '#000';
        x.beginPath(); x.arc(r, r, r * (k / 4), Math.PI, 0); x.closePath(); x.fill();
        x.strokeStyle = rgba(GOLD, 0.55);
        x.stroke();
      }
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
        ctx.drawImage(pattern, -((t * r * 0.05) % (r * 2)), 0);
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.1, W / 2, H / 2, Math.hypot(W, H) * 0.6);
        g.addColorStop(0, 'rgba(0,0,0,0.1)');
        g.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        frame(ctx, W, H);
      };
    },
  };
  const MIX = ['deco', 'botanical', 'lift', 'clockface', 'skyline', 'bubbles', 'fans'];
  // Artwork without words is mirrored on the right-hand screen, so a pair frames whatever sits
  // between them.
  const MIRRORED = ['botanical', 'skyline', 'fans', 'bubbles'];

  function visuals(canvas, W, H, opts) {
    const ctx = canvas.getContext('2d');
    const style = opts.conf && EFFECTS[opts.conf.style] ? opts.conf.style : 'mix';
    let current = '', draw = null, since = 0;
    const stop = animate((t) => {
      const want = style === 'mix' ? MIX[Math.floor(t / 60) % MIX.length] : style;
      if (want !== current) { current = want; draw = EFFECTS[want](W, H, opts); since = t; }
      if (opts.side === 'right' && MIRRORED.includes(current)) {
        ctx.save();
        ctx.translate(W, 0);
        ctx.scale(-1, 1);
        draw(ctx, t);
        ctx.restore();
      } else {
        draw(ctx, t);
      }
      if (current === 'botanical') frame(ctx, W, H);
      const fade = 1 - (t - since) / 2;
      if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, W, H); }
    }, 30);
    return { stop };
  }

  // ------------------------------------------------------------ basement live

  // Guests' phone cameras (static/live.html), received on the Pi by livewall.js. An automatic
  // director cuts between them: each person on the whole wall in turn, now and then two stacked,
  // and with three or four live, everyone at once. Frames, nameplates and the curtain are drawn
  // once into small canvases and stamped on, so a frame is little more than drawing the video.
  const LIVE_SOLO = 7;      // seconds per person (give or take one)
  const LIVE_GROUP = 6;     // seconds for a two-up or the grid
  const LIVE_WIPE = 0.55;   // the deco wipe between layouts
  const LIVE_REVEAL = 2.2;  // the curtain for someone joining

  function offscreen(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    draw(c.getContext('2d'), c.width, c.height);
    return c;
  }

  function cached(map, key, make) {
    if (!map.has(key)) map.set(key, make());
    return map.get(key);
  }

  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

  // Cover-fits a camera into a box by cropping its source (no clipping needed). Portrait phone
  // video loses more from the bottom than the top, because faces sit high in the picture; `zoom`
  // pushes in, drifting a little upwards as it does.
  function drawCam(ctx, v, x, y, w, h, zoom) {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const k = Math.max(w / vw, h / vh) * (zoom || 1);
    const sw = Math.min(vw, w / k), sh = Math.min(vh, h / k);
    const fy = vh > vw ? 0.3 : 0.4;
    ctx.drawImage(v, (vw - sw) / 2, (vh - sh) * fy, sw, sh, x, y, w, h);
  }

  // Each person's picture sits in a black matte with a gold line and stepped deco corners.
  function camFrame(w, h) {
    return offscreen(w, h, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, w, 2); x.fillRect(0, h - 2, w, 2); x.fillRect(0, 0, 2, h); x.fillRect(w - 2, 0, 2, h);
      x.fillStyle = GOLD;
      x.fillRect(2, 2, w - 4, 1); x.fillRect(2, h - 3, w - 4, 1); x.fillRect(2, 2, 1, h - 4); x.fillRect(w - 3, 2, 1, h - 4);
      const L = Math.max(6, Math.round(Math.min(w, h) * 0.07));
      for (const [tx, ty, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
        x.save();
        x.translate(tx, ty);
        x.scale(sx, sy);
        // two stepped brackets, each with a black edge inside it so it reads over a bright picture
        for (const [o, len] of [[5, L], [8, Math.round(L * 0.55)]]) {
          x.fillStyle = 'rgba(0,0,0,0.7)';
          x.fillRect(o + 1, o + 1, len - 1, 1); x.fillRect(o + 1, o + 1, 1, len - 1);
          x.fillStyle = GOLD;
          x.fillRect(o, o, len, 1); x.fillRect(o, o, 1, len);
        }
        x.restore();
      }
    });
  }

  // The name in ivory capitals on a small black plate, under a gold rule with a diamond.
  function namePlate(name, px, maxW) {
    const m = document.createElement('canvas').getContext('2d');
    tracking(m, px * 0.16);
    let size = px;
    m.font = font('Josefin Sans', size);
    const w0 = m.measureText(name).width;
    if (w0 > maxW - px * 1.6) size = Math.max(MIN_TEXT, Math.floor((size * (maxW - px * 1.6)) / w0));
    m.font = font('Josefin Sans', size);
    tracking(m, size * 0.16);
    const tw = m.measureText(name).width;
    const w = Math.min(maxW, Math.round(tw + size * 1.6)), h = Math.round(size * 2.1);
    return offscreen(w, h, (x) => {
      x.fillStyle = 'rgba(0,0,0,0.82)';
      x.fillRect(0, 0, w, h);
      x.fillStyle = GOLD;
      const cx = Math.floor(w / 2);
      x.fillRect(0, 0, cx - 3, 1); x.fillRect(cx + 4, 0, w - cx - 4, 1);
      x.fillRect(cx - 1, 0, 3, 1); x.fillRect(cx, 1, 1, 1);                   // the diamond's lower half
      x.font = font('Josefin Sans', size);
      tracking(x, size * 0.16);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillStyle = IVORY;
      x.fillText(name, w / 2 + size * 0.08, h / 2 + 1 + size * 0.06);
      tracking(x, 0);
    });
  }

  // The small gold LIVE in the top corner, on a black chip so it reads over any picture.
  function liveMark() {
    const size = 8;
    const m = document.createElement('canvas').getContext('2d');
    m.font = font('Josefin Sans', size);
    tracking(m, 2);
    const tw = Math.ceil(m.measureText('LIVE').width);
    const w = tw + 14, h = 13;
    return offscreen(w, h, (x) => {
      x.fillStyle = 'rgba(0,0,0,0.78)';
      x.fillRect(0, 0, w, h);
      x.fillStyle = GOLD;
      x.beginPath(); x.moveTo(5, 3.5); x.lineTo(8, 6.5); x.lineTo(5, 9.5); x.lineTo(2, 6.5); x.closePath(); x.fill();
      x.font = font('Josefin Sans', size);
      tracking(x, 2);
      x.textBaseline = 'middle';
      x.fillText('LIVE', 11, h / 2 + 1);
      tracking(x, 0);
    });
  }

  // Draws a QR code (rows of "1"/"0" from the Pi's qrencode) with whole-pixel modules on an ivory
  // panel. Returns its size.
  function drawQR(x, rows, left, top, maxSize) {
    const n = rows.length, quiet = 2;
    const cell = Math.max(1, Math.floor(maxSize / (n + quiet * 2)));
    const size = cell * (n + quiet * 2);
    x.fillStyle = IVORY;
    x.fillRect(left, top, size, size);
    x.fillStyle = '#000';
    rows.forEach((row, r) => {
      for (let c = 0; c < n; c++) if (row[c] === '1') x.fillRect(left + (c + quiet) * cell, top + (r + quiet) * cell, cell, cell);
    });
    return size;
  }

  const qrCache = new Map();
  function loadQR(url) {
    if (!url) return Promise.resolve(null);
    if (!qrCache.has(url)) {
      qrCache.set(url, fetch('/api/live/qr').then((r) => r.json()).then((j) => (j.url === url && j.rows ? j.rows : null)).catch(() => null));
    }
    return qrCache.get(url);
  }

  const shortLink = (url) => (url || '').replace(/^https?:\/\//, '');

  // Nobody live: the channel's card, with the code to scan.
  function liveIdle(W, H, conf, rows, names) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      frame(x, W, H);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      const titleY = Math.round(H * 0.11);
      tracking(x, s * 0.02);
      x.font = font('Poiret One', fitSize(x, 'BASEMENT', 'Poiret One', W * 0.76, s * 0.13));
      x.fillStyle = IVORY;
      x.fillText('BASEMENT', W / 2 + s * 0.01, titleY);
      tracking(x, s * 0.05);
      x.font = font('Josefin Sans', Math.max(MIN_TEXT, Math.round(s * 0.042)));
      x.fillStyle = GOLD;
      x.fillText('LIVE', W / 2 + s * 0.025, titleY + s * 0.1);
      tracking(x, 0);
      decoRule(x, W / 2 - W * 0.2, Math.round(titleY + s * 0.16), W * 0.4, s);
      const label = (text, y, px, color) => {
        tracking(x, px * 0.18);
        x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, text, 'Josefin Sans', W * 0.84, px)));
        x.fillStyle = color;
        x.fillText(text, W / 2 + px * 0.09, Math.round(y));
        tracking(x, 0);
      };
      let top = Math.round(titleY + s * 0.24);
      if (names && names.length) { // a preview on the control page: who's on the wall
        label('ON THE WALL NOW', top + s * 0.04, s * 0.036, MUTED);
        names.slice(0, 4).forEach((n, i) => label(n, top + s * (0.16 + i * 0.12), s * 0.06, IVORY));
        return;
      }
      if (rows) {
        const max = Math.min(W * 0.74, H * 0.5); // as big as fits: it's scanned from across the room
        const cell = Math.max(1, Math.floor(max / (rows.length + 4)));
        const q = cell * (rows.length + 4);
        const qx = Math.round((W - q) / 2), qy = top;
        x.fillStyle = GOLD;
        x.fillRect(qx - 3, qy - 3, q + 6, 1); x.fillRect(qx - 3, qy + q + 2, q + 6, 1);
        x.fillRect(qx - 3, qy - 3, 1, q + 6); x.fillRect(qx + q + 2, qy - 3, 1, q + 6);
        drawQR(x, rows, qx, qy, max);
        label('SCAN TO GO LIVE', qy + q + s * 0.075, s * 0.04, IVORY);
        const link = shortLink(conf.url);
        const dot = link.indexOf('.');
        const lines = dot > 0 ? [link.slice(0, dot), link.slice(dot)] : [link];
        lines.forEach((l, i) => label(l.toUpperCase(), qy + q + s * (0.135 + i * 0.045), s * 0.03, MUTED));
        return;
      }
      // No secure link yet: the home Wi-Fi address, and why it may not be enough. Set a little
      // lower, so the shorter card sits in the middle of the wall.
      top += Math.round(s * 0.16);
      label('ON YOUR PHONE, OPEN', top + s * 0.06, s * 0.034, MUTED);
      const lan = shortLink(conf.lan || '').toUpperCase() || 'THE PI’S ADDRESS /LIVE';
      const dot = lan.indexOf('.');
      const lines = dot > 0 && lan.length > 18 ? [lan.slice(0, dot), lan.slice(dot)] : [lan];
      lines.forEach((l, i) => label(l, top + s * (0.15 + i * 0.075), s * 0.06, IVORY));
      const y = top + s * (0.2 + lines.length * 0.075);
      decoRule(x, W / 2 - W * 0.12, Math.round(y), W * 0.24, s);
      label('THE SECURE LINK ISN’T', y + s * 0.07, s * 0.032, MUTED);
      label('READY YET. PHONES NEED IT', y + s * 0.115, s * 0.032, MUTED);
      label('TO USE THE CAMERA.', y + s * 0.16, s * 0.032, MUTED);
    });
  }

  // The fourth square of the grid when three are live: an invitation, with the code.
  function liveInvite(w, h, rows) {
    const s = Math.min(w, h);
    return offscreen(w, h, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, w, h);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      tracking(x, 1);
      x.font = font('Josefin Sans', MIN_TEXT + 1);
      x.fillStyle = GOLD;
      x.fillText('ONE MORE', w / 2 + 0.5, Math.round(h * 0.16));
      tracking(x, 0);
      x.font = font('Poiret One', fitSize(x, 'GO LIVE', 'Poiret One', w * 0.8, s * 0.16));
      x.fillStyle = IVORY;
      x.fillText('GO LIVE', w / 2, Math.round(h * 0.27));
      if (rows) {
        const max = Math.min(w * 0.82, h * 0.6);
        const cell = Math.max(1, Math.floor(max / (rows.length + 4)));
        const q = cell * (rows.length + 4);
        drawQR(x, rows, Math.round((w - q) / 2), Math.round(h * 0.38), max);
      } else {
        decoRule(x, w * 0.3, Math.round(h * 0.4), w * 0.4, s * 2);
      }
    });
  }

  // Someone joining: the house curtain parts on them, under a spotlight.
  function curtain(w, h, side) {
    return offscreen(w, h, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < w; i++) { // folds: a soft rise and fall of gold, column by column
        const a = 0.05 + 0.13 * (0.5 + 0.5 * Math.sin((i / 9) * Math.PI * 2));
        x.fillStyle = rgba(GOLD, a);
        x.fillRect(i, 0, 1, h);
      }
      x.fillStyle = GOLD;
      const edge = side === 'left' ? w - 1 : 0;
      x.fillRect(edge, 0, 1, h);
      x.fillStyle = '#000';
      x.fillRect(side === 'left' ? w - 3 : 1, 0, 2, h);
      x.fillStyle = rgba(GOLD, 0.8);
      x.fillRect(0, 10, w, 1);
      x.fillRect(0, h - 11, w, 1);
    });
  }

  function spotlight(W, H) {
    return offscreen(W * 2, H * 2, (x, w, h) => {
      const r = Math.min(W, H) * 0.32;
      const g = x.createRadialGradient(w / 2, h / 2, r * 0.55, w / 2, h / 2, r * 1.25);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.92)');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
  }

  function revealCard(W, H, name) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      const cy = Math.round(H * 0.68); // below the face, which the spotlight finds
      x.fillStyle = 'rgba(0,0,0,0.88)';
      x.fillRect(0, cy - s * 0.2, W, s * 0.4);
      x.fillStyle = rgba(GOLD, 0.9);
      x.fillRect(0, Math.round(cy - s * 0.2), W, 1);
      x.fillRect(0, Math.round(cy + s * 0.2) - 1, W, 1);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      tracking(x, s * 0.016);
      x.font = font('Josefin Sans', Math.max(MIN_TEXT, Math.round(s * 0.036)));
      x.fillStyle = GOLD;
      x.fillText('PRESENTING', W / 2 + s * 0.008, Math.round(cy - s * 0.11));
      tracking(x, s * 0.012);
      x.font = font('Poiret One', fitSize(x, name, 'Poiret One', W * 0.84, s * 0.15));
      x.fillStyle = IVORY;
      x.fillText(name, W / 2, Math.round(cy + s * 0.01));
      tracking(x, 0);
      decoRule(x, W / 2 - W * 0.16, Math.round(cy + s * 0.11), W * 0.32, s);
    });
  }

  function live(canvas, W, H, opts) {
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    const conf = opts.conf || {};
    const rx = opts.live;
    let rows = null, idle = null, idleShown = false;
    const frames = new Map(), plates = new Map(), cards = new Map(), invites = new Map();
    const mark = liveMark();
    let curtains = null, spot = null;
    if (conf.url && conf.qr) loadQR(conf.url).then((r) => { rows = r; idle = null; invites.clear(); });

    const frameFor = (w, h) => cached(frames, `${w}x${h}`, () => camFrame(w, h));
    const plateFor = (name, px, maxW) => cached(plates, `${name}|${px}|${maxW}`, () => namePlate(name, px, maxW));

    // ---- the director
    const d = { shot: null, prev: null, wipe: false, k: 0, rr: 0, pp: 0, groups: 0, seen: new Set(), reveals: [] };

    function next(on) {
      const n = on.length;
      if (n === 1) return { kind: 'solo', ids: [on[0].cid], len: Infinity };
      d.k++;
      if (d.k % (n + 1) === 0) { // after a round of everyone on their own, a group shot
        d.groups++;
        if (n >= 3 && d.groups % 2 === 1) return { kind: 'grid', ids: on.slice(0, 4).map((c) => c.cid), len: LIVE_GROUP + 1 };
        const a = on[d.pp % n], b = on[(d.pp + 1) % n];
        d.pp += n === 4 ? 2 : 1;
        return { kind: 'pair', ids: [a.cid, b.cid], len: LIVE_GROUP };
      }
      let c = on[d.rr++ % n];
      if (d.shot && d.shot.kind === 'solo' && d.shot.ids[0] === c.cid) c = on[d.rr++ % n];
      return { kind: 'solo', ids: [c.cid], len: LIVE_SOLO - 1 + Math.random() * 2 };
    }

    function cut(shot, t, wipe) {
      d.prev = d.shot;
      d.shot = { ...shot, at: t };
      d.wipe = !!(wipe && d.prev);
      canvas.dataset.shot = `${shot.kind}${shot.reveal ? '+reveal' : ''}${d.wipe ? '+wipe' : ''}:${shot.ids.length}`; // for checking the director
    }

    function plan(on, t) {
      const ids = on.map((c) => c.cid);
      for (const c of on) {
        if (!d.seen.has(c.cid)) { d.seen.add(c.cid); if (c.announce) d.reveals.push(c.cid); }
      }
      for (const id of [...d.seen]) if (!ids.includes(id)) d.seen.delete(id);
      d.reveals = d.reveals.filter((id) => ids.includes(id));
      const cur = d.shot;
      const revealing = cur && cur.reveal && t - cur.at < LIVE_REVEAL + 0.6;
      if (d.reveals.length && !revealing) return cut({ kind: 'solo', ids: [d.reveals.shift()], reveal: true, len: LIVE_SOLO + 1 }, t, false);
      if (!cur || cur.ids.some((id) => !ids.includes(id))) return cut(next(on), t, false); // someone left: straight to the next shot
      // (a lone camera's shot has no end; once there's company, it gets three seconds at least)
      if (on.length > 1 && t - cur.at > (cur.len === Infinity ? 3 : cur.len)) {
        const n = next(on);
        cut(n, t, n.kind !== 'solo' || cur.kind !== 'solo');
      }
    }

    // ---- drawing
    function tile(c, x, y, w, h, zoom, plateAlpha, px) {
      drawCam(ctx, c.video, x, y, w, h, zoom);
      ctx.drawImage(frameFor(w, h), x, y);
      if (plateAlpha > 0) {
        const p = plateFor(c.name, px, w - 24);
        ctx.globalAlpha = plateAlpha;
        ctx.drawImage(p, Math.round(x + (w - p.width) / 2), Math.round(y + h - p.height - Math.max(8, h * 0.035)));
        ctx.globalAlpha = 1;
      }
    }

    function drawShot(shot, byId, t, count) {
      const age = t - shot.at;
      const plateIn = ease((age - (shot.reveal ? LIVE_REVEAL - 0.4 : 0.2)) / 0.5);
      if (shot.kind === 'solo') {
        const c = byId.get(shot.ids[0]);
        if (!c) return;
        let zoom = 1;
        if (count === 1) { // alone: every half minute, a slow push in, a hold, and back out
          const p = (age % 30) / 30;
          zoom = 1 + 0.09 * (ease((p - 0.35) / 0.25) - ease((p - 0.8) / 0.2));
        } else if (!shot.reveal) {
          zoom = 1 + 0.04 * ease(age / shot.len);
        }
        tile(c, 0, 0, W, H, zoom, plateIn, Math.round(s * 0.055));
        if (shot.reveal && age < LIVE_REVEAL) drawReveal(c, age);
      } else if (shot.kind === 'pair') {
        shot.ids.forEach((id, i) => {
          const c = byId.get(id);
          if (c) tile(c, 0, Math.round((i * H) / 2), W, Math.round(H / 2), 1, plateIn, Math.round(s * 0.045));
        });
      } else {
        const w = Math.round(W / 2), h = Math.round(H / 2);
        for (let i = 0; i < 4; i++) {
          const c = byId.get(shot.ids[i]);
          const x = (i % 2) * w, y = Math.floor(i / 2) * h;
          if (c) tile(c, x, y, w, h, 1, plateIn, Math.round(s * 0.038));
          else {
            ctx.drawImage(cached(invites, `${w}x${h}|${!!rows}`, () => liveInvite(w, h, rows)), x, y);
            ctx.drawImage(frameFor(w, h), x, y);
          }
        }
      }
    }

    function drawReveal(c, age) {
      if (!curtains) curtains = [curtain(W / 2, H, 'left'), curtain(W - Math.round(W / 2), H, 'right')];
      if (!spot) spot = spotlight(W, H);
      // the spotlight opens out over the person as the curtain parts
      const open = ease((age - 0.45) / 1.0);
      const widen = ease((age - 1.1) / 1.0);
      const f = 1 + 3 * widen;
      ctx.globalAlpha = 1 - widen;
      ctx.drawImage(spot, W / 2 - W * f, H * 0.42 - H * f, W * 2 * f, H * 2 * f);
      ctx.globalAlpha = 1;
      const off = Math.round((W / 2) * open);
      if (open < 1) {
        ctx.drawImage(curtains[0], -off, 0);
        ctx.drawImage(curtains[1], Math.round(W / 2) + off, 0);
      }
      const a = Math.min(ease(age / 0.3), 1 - ease((age - 1.45) / 0.4));
      if (a > 0) {
        ctx.globalAlpha = a;
        ctx.drawImage(cached(cards, c.name, () => revealCard(W, H, c.name)), 0, 0);
        ctx.globalAlpha = 1;
      }
    }

    const stop = animate((t) => {
      const on = rx ? rx.cams().slice(0, 4) : [];
      if (!on.length) {
        d.shot = null;
        if (!idle) { idle = liveIdle(W, H, conf, rows, rx ? null : conf.names); idleShown = false; }
        if (!idleShown) { ctx.drawImage(idle, 0, 0); idleShown = true; }
        return;
      }
      idleShown = false;
      plan(on, t);
      const byId = new Map(on.map((c) => [c.cid, c]));
      const shot = d.shot;
      drawShot(shot, byId, t, on.length);
      const w = (t - shot.at) / LIVE_WIPE;
      if (d.wipe && d.prev && w < 1) { // a deco wipe: the new shot comes down behind a gold line
        const y = Math.round(H * ease(w));
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y, W, H - y);
        ctx.clip();
        drawShot(d.prev, byId, t, on.length);
        ctx.restore();
        ctx.fillStyle = '#000';
        ctx.fillRect(0, y - 2, W, 5);
        ctx.fillStyle = GOLD;
        ctx.fillRect(0, y, W, 1);
        ctx.fillStyle = rgba(GOLD, 0.5);
        ctx.fillRect(0, y - 3, W, 1);
      }
      if (!(shot.reveal && t - shot.at < 1.4)) ctx.drawImage(mark, W - mark.width - 13, 12);
    }, 30);
    return { stop };
  }

  // ------------------------------------------------------------ the house pour

  // Channel 8: the bar's card of what's on tonight, three drinks at a time, and the moment a drink
  // is made: its glass, line-drawn in gold, filling in the drink's own colour with the guest's
  // name above. Every glass is drawn once into small canvases (outline, liquid, ice, garnish), so
  // pouring is drawImage of the liquid up to the level, a stream and a few bubbles.
  const POUR_PAGE = 9;      // seconds per page of the menu
  const POUR_FILL = 8;      // seconds to fill the glass
  const POUR_BURST = 2.4;   // the gold sunburst when it's served

  // Glasses in their own units: u across (0-1 of the width), v down (0-1 of the height), drawn
  // with M/L/Q/C commands. `bowl` is the part that holds the drink, `fill` its bottom and top, `rim`
  // where a garnish sits and `ice` the cubes (u, v of the centre, size as a share of the height).
  const GLASS = {
    coupe: { aspect: 0.78, fill: [0.355, 0.075], rim: [0.97, 0.04],
      bowl: [['M', 0.02, 0.04], ['C', 0.04, 0.3, 0.3, 0.37, 0.5, 0.37], ['C', 0.7, 0.37, 0.96, 0.3, 0.98, 0.04]],
      stem: [['M', 0.5, 0.37], ['L', 0.5, 0.95], ['M', 0.2, 1], ['Q', 0.5, 0.9, 0.8, 1], ['L', 0.2, 1]] },
    martini: { aspect: 0.82, fill: [0.46, 0.07], rim: [0.97, 0.03],
      bowl: [['M', 0.01, 0.02], ['L', 0.5, 0.48], ['L', 0.99, 0.02]],
      stem: [['M', 0.5, 0.48], ['L', 0.5, 0.95], ['M', 0.22, 1], ['Q', 0.5, 0.91, 0.78, 1], ['L', 0.22, 1]] },
    flute: { aspect: 0.3, fill: [0.64, 0.08], rim: [0.86, 0.0],
      bowl: [['M', 0.13, 0.0], ['C', 0.1, 0.35, 0.18, 0.62, 0.5, 0.66], ['C', 0.82, 0.62, 0.9, 0.35, 0.87, 0.0]],
      stem: [['M', 0.5, 0.66], ['L', 0.5, 0.96], ['M', 0.02, 1], ['Q', 0.5, 0.93, 0.98, 1], ['L', 0.02, 1]] },
    wine: { aspect: 0.52, fill: [0.565, 0.16], rim: [0.86, 0.02], ice: [[0.4, 0.4, 0.13, 0.3], [0.6, 0.31, 0.12, -0.4]],
      bowl: [['M', 0.13, 0.02], ['C', 0.0, 0.3, 0.1, 0.57, 0.5, 0.58], ['C', 0.9, 0.57, 1.0, 0.3, 0.87, 0.02]],
      stem: [['M', 0.5, 0.58], ['L', 0.5, 0.96], ['M', 0.15, 1], ['Q', 0.5, 0.93, 0.85, 1], ['L', 0.15, 1]] },
    rocks: { aspect: 0.98, fill: [0.86, 0.17], rim: [0.93, 0.0], ice: [[0.4, 0.6, 0.36, 0.2], [0.66, 0.42, 0.3, -0.25]],
      bowl: [['M', 0.05, 0.0], ['L', 0.105, 0.86], ['L', 0.895, 0.86], ['L', 0.95, 0.0]],
      stem: [['M', 0.105, 0.86], ['L', 0.12, 1], ['L', 0.88, 1], ['L', 0.895, 0.86], ['M', 0.105, 0.86], ['L', 0.895, 0.86]] },
    highball: { aspect: 0.46, fill: [0.93, 0.1], rim: [0.95, 0.0],
      ice: [[0.38, 0.78, 0.3, 0.2], [0.62, 0.6, 0.3, -0.2], [0.4, 0.42, 0.3, 0.35], [0.6, 0.25, 0.28, -0.1]],
      bowl: [['M', 0.04, 0.0], ['L', 0.085, 0.93], ['L', 0.915, 0.93], ['L', 0.96, 0.0]],
      stem: [['M', 0.085, 0.93], ['L', 0.09, 1], ['L', 0.91, 1], ['L', 0.915, 0.93], ['M', 0.085, 0.93], ['L', 0.915, 0.93]] },
    mug: { aspect: 1.1, fill: [0.94, 0.13], rim: [0.04, 0.0], ice: [[0.3, 0.38, 0.28, 0.25], [0.5, 0.28, 0.26, -0.3]],
      bowl: [['M', 0.02, 0.0], ['L', 0.06, 0.94], ['Q', 0.06, 1, 0.12, 1], ['L', 0.68, 1], ['Q', 0.74, 1, 0.74, 0.94], ['L', 0.78, 0.0]],
      stem: [['M', 0.775, 0.16], ['C', 1.02, 0.12, 1.02, 0.74, 0.755, 0.72], ['M', 0.77, 0.3], ['C', 0.9, 0.29, 0.9, 0.6, 0.76, 0.6],
        ['M', 0.02, 0.1], ['L', 0.78, 0.1], ['M', 0.055, 0.86], ['L', 0.745, 0.86]] },
  };
  // Where a second colour goes: by default it's a float, foam or crema on top. Muddled mint sits
  // at the bottom, and the margarita's is its salt rim.
  const POUR_LAYER = { d003: 'rim', d005: 'bottom', d021: 'bottom', d025: 'bottom' };
  const GARNISH = { orange: '#f2871c', lemon: '#f4d23a', lime: '#7cc242', mint: '#3fae3f', cherry: '#c8102e', olive: '#8a9a2c' };

  function hexRGB(hex) {
    const n = parseInt((hex || '#000000').slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (hex, other, k) => { const a = hexRGB(hex), b = hexRGB(other); return toHex(a.map((v, i) => v + (b[i] - v) * k)); };

  // A drink as the wall shows it: very dark drinks are lifted a little so the glass doesn't look
  // empty, and clear ones (gin and tonic, a martini) are see-through rather than milky.
  function liquidLook(hex) {
    const c = hexRGB(hex), max = Math.max(...c), min = Math.min(...c);
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    if (lum < 0.1) return { color: mix(hex, '#ffffff', 0.06 + (0.1 - lum)), alpha: 1 };
    if (lum > 0.8 && (max - min) / max < 0.1) return { color: hex, alpha: 0.5 };
    return { color: hex, alpha: 1 };
  }

  function tracePath(x, ops, ox, oy, gw, gh) {
    for (const op of ops) {
      const p = op.slice(1).map((v, i) => (i % 2 ? oy + v * gh : ox + v * gw));
      if (op[0] === 'M') x.moveTo(p[0], p[1]);
      else if (op[0] === 'L') x.lineTo(p[0], p[1]);
      else if (op[0] === 'Q') x.quadraticCurveTo(p[0], p[1], p[2], p[3]);
      else if (op[0] === 'C') x.bezierCurveTo(p[0], p[1], p[2], p[3], p[4], p[5]);
    }
  }

  // Everything one glass needs, in a w x h box: the glass sits at the bottom, centred, with room
  // above it for the garnish. `full` adds ice and garnish (the menu's small icons go without).
  function pourGlass(drink, w, h, lw, full) {
    const g = GLASS[drink.glass] || GLASS.rocks;
    const room = full ? 0.14 : 0.02;
    const gh = Math.min(h * (1 - room) - lw, (w - lw * 2) / g.aspect), gw = gh * g.aspect;
    const ox = Math.round((w - gw) / 2), oy = Math.round(h - gh - lw);
    const at = (u, v) => [ox + u * gw, oy + v * gh];
    const layer = POUR_LAYER[drink.id] || (drink.colour2 ? 'top' : '');
    const bowl = (x) => { x.beginPath(); tracePath(x, g.bowl, ox, oy, gw, gh); x.closePath(); };

    // the shape that holds the drink, kept a pixel clear of the gold line
    const mask = offscreen(w, h, (x) => {
      bowl(x);
      x.fillStyle = '#fff';
      x.fill();
      x.globalCompositeOperation = 'destination-out';
      x.lineWidth = lw + 2;
      x.lineJoin = 'round';
      bowl(x);
      x.stroke();
    });
    const tinted = (hex, alpha) => offscreen(w, h, (x) => {
      x.drawImage(mask, 0, 0);
      x.globalCompositeOperation = 'source-in';
      x.globalAlpha = alpha;
      x.fillStyle = hex;
      x.fillRect(0, 0, w, h);
    });
    const look = liquidLook(drink.colour);
    const second = drink.colour2 && layer !== 'rim' ? liquidLook(drink.colour2) : null;
    const liquid = tinted(look.color, look.alpha);
    const surface = tinted(mix(look.color, '#ffffff', 0.45), 1);
    const liquid2 = second && tinted(second.color, second.alpha);
    const surface2 = second && tinted(mix(second.color, '#ffffff', 0.35), 1);

    // the widest part of the drink on each row, for bubbles
    const rows = [];
    const d = mask.getContext('2d').getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) {
      let a = -1, b = -1;
      for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 200) { if (a < 0) a = x; b = x; }
      rows.push(a < 0 ? null : [a, b]);
    }

    const outline = offscreen(w, h, (x) => {
      x.lineJoin = 'round';
      x.lineCap = 'round';
      if (layer === 'rim' && full) { // a band of salt hugging the top of the bowl
        x.save();
        x.beginPath();
        x.rect(0, 0, w, oy + gh * (g.fill[1] + 0.13));
        x.clip();
        x.strokeStyle = drink.colour2;
        x.lineWidth = lw * 3;
        x.beginPath();
        tracePath(x, g.bowl, ox, oy, gw, gh);
        x.stroke();
        x.restore();
        x.setLineDash([2, 1]); // and the grains along the rim itself
        x.strokeStyle = drink.colour2;
        x.lineWidth = lw;
        x.beginPath();
        x.moveTo(...at(g.bowl[0][1], g.bowl[0][2] - 0.012));
        x.lineTo(...at(g.bowl[g.bowl.length - 1].slice(-2)[0], g.bowl[0][2] - 0.012));
        x.stroke();
        x.setLineDash([]);
      }
      x.strokeStyle = GOLD;
      x.lineWidth = lw;
      x.beginPath();
      tracePath(x, g.bowl, ox, oy, gw, gh);
      tracePath(x, g.stem, ox, oy, gw, gh);
      x.stroke();
    });

    // ice: pale edges, and a frosting that only shows where the drink has reached
    const cubes = (fill) => offscreen(w, h, (x) => {
      for (const [u, v, size, turn] of g.ice) {
        const [cx, cy] = at(u, v), side = size * gh;
        x.save();
        x.translate(cx, cy);
        x.rotate(turn);
        roundRect(x, -side / 2, -side / 2, side, side, side * 0.18);
        if (fill) {
          x.fillStyle = 'rgba(236,240,240,0.16)';
          x.fill();
        } else {
          x.strokeStyle = 'rgba(236,240,240,0.6)';
          x.lineWidth = 1;
          x.stroke();
        }
        x.restore();
      }
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(mask, 0, 0);
    });
    const ice = full && drink.ice && g.ice ? cubes(false) : null;
    const frost = ice && cubes(true);

    // (the garnish gets a margin of its own: a wheel on the rim hangs over the edge of the box)
    const pad = Math.round(gh * 0.14);
    const garnish = full && GARNISH[drink.garnish] ? offscreen(w + pad * 2, h + pad, (x) => {
      x.translate(pad, pad);
      drawGarnish(x, drink.garnish, at(...g.rim), gh, g, at, lw);
    }) : null;
    const [, yBottom] = at(0, g.fill[0]);
    const [, yTop] = at(0, g.fill[1]);
    return { w, h, mask, liquid, surface, liquid2, surface2, layer, rows, outline, ice, frost, garnish, pad,
             yBottom: Math.round(yBottom), yTop: Math.round(yTop), cx: Math.round(ox + gw / 2), top: oy, gh };
  }

  function drawGarnish(x, kind, rim, gh, g, at, lw) {
    const [rx, ry] = rim;
    const color = GARNISH[kind];
    x.lineJoin = 'round';
    x.lineCap = 'round';
    if (kind === 'orange' || kind === 'lemon') { // a wheel on the rim
      const r = Math.max(5, gh * 0.1);
      x.fillStyle = mix(color, '#ffffff', 0.25);
      x.beginPath(); x.arc(rx, ry, r, 0, Math.PI * 2); x.fill();
      x.strokeStyle = color;
      x.lineWidth = Math.max(2, r * 0.22);
      x.beginPath(); x.arc(rx, ry, r - x.lineWidth / 2, 0, Math.PI * 2); x.stroke();
      x.strokeStyle = mix(color, '#ffffff', 0.7);
      x.lineWidth = 1;
      x.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        x.moveTo(rx, ry); x.lineTo(rx + Math.cos(a) * r * 0.7, ry + Math.sin(a) * r * 0.7);
      }
      x.stroke();
    } else if (kind === 'lime') { // a wedge, sat on the rim
      const r = Math.max(5, gh * 0.09);
      x.fillStyle = mix(color, '#ffffff', 0.2);
      x.beginPath(); x.moveTo(rx - r, ry); x.arc(rx, ry, r, Math.PI, Math.PI * 2, true); x.closePath(); x.fill();
      x.strokeStyle = mix(color, '#000000', 0.3);
      x.lineWidth = Math.max(2, r * 0.25);
      x.beginPath(); x.arc(rx, ry, r - x.lineWidth / 2, 0, Math.PI); x.stroke();
    } else if (kind === 'cherry') { // hanging on the rim by its stem
      const r = Math.max(4, gh * 0.055);
      x.strokeStyle = '#7a4a1c';
      x.lineWidth = Math.max(1.5, lw * 0.75);
      x.beginPath(); x.moveTo(rx - r * 0.2, ry - r * 0.4); x.quadraticCurveTo(rx + r * 0.2, ry - r * 2.6, rx + r * 1.6, ry - r * 2.8); x.stroke();
      x.fillStyle = color;
      x.beginPath(); x.arc(rx - r * 0.2, ry + r * 0.4, r, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(255,255,255,0.7)';
      x.fillRect(Math.round(rx - r * 0.6), Math.round(ry), Math.max(1, Math.round(r * 0.35)), Math.max(1, Math.round(r * 0.35)));
    } else if (kind === 'mint') { // a sprig standing up out of the drink
      const [mx, my] = at(0.42, g.fill[1] + 0.02);
      const leaf = Math.max(4, gh * 0.07);
      x.strokeStyle = mix(color, '#000000', 0.25);
      x.lineWidth = Math.max(1.5, lw * 0.75);
      x.beginPath(); x.moveTo(mx, my + leaf); x.lineTo(mx + leaf * 0.3, my - leaf * 2.2); x.stroke();
      x.fillStyle = color;
      for (const [dx, dy, a] of [[-0.7, -0.6, -0.7], [0.9, -1.2, 0.8], [-0.4, -2.1, -0.4], [0.5, -2.6, 0.3]]) {
        x.save();
        x.translate(mx + dx * leaf, my + dy * leaf);
        x.rotate(a);
        x.beginPath(); x.ellipse(0, 0, leaf * 0.42, leaf * 0.8, 0, 0, Math.PI * 2); x.fill();
        x.restore();
      }
    } else if (kind === 'olive') { // on a pick, down in the glass
      const r = Math.max(4, gh * 0.055);
      const [px, py] = at(0.5, 0.33);
      x.strokeStyle = GOLD_LIGHT;
      x.lineWidth = Math.max(1, lw * 0.6);
      x.beginPath(); x.moveTo(px - r * 0.3, py + r * 0.3); x.lineTo(rx - r * 0.4, ry - r * 2.4); x.stroke();
      x.fillStyle = color;
      x.beginPath(); x.ellipse(px, py, r * 1.15, r, -0.6, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#d03a2a';
      x.beginPath(); x.arc(px + r * 0.45, py - r * 0.3, r * 0.4, 0, Math.PI * 2); x.fill();
    }
  }

  // The cards are drawn once, so they wait for the web fonts: until those arrive they're redrawn
  // as soon as they do.
  const pourFonts = () => !document.fonts || (document.fonts.check(font('Poiret One', 20)) && document.fonts.check(font('Josefin Sans', 20)));

  const article = (name) => (/^[AEIOU]/.test(name) ? 'AN ' : 'A ') + name;

  // A full circle of gold rays, drawn once and scaled up when a drink is served.
  function pourBurst(r) {
    return offscreen(r * 2, r * 2, (x) => {
      const rays = 28;
      x.fillStyle = GOLD;
      for (let i = 0; i < rays; i += 1) {
        const a0 = (i / rays) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / rays / 2.2;
        x.globalAlpha = i % 2 ? 0.45 : 0.85;
        x.beginPath();
        x.moveTo(r + Math.cos(a0) * r * 0.18, r + Math.sin(a0) * r * 0.18);
        x.lineTo(r + Math.cos(a0) * r, r + Math.sin(a0) * r);
        x.lineTo(r + Math.cos(a1) * r, r + Math.sin(a1) * r);
        x.lineTo(r + Math.cos(a1) * r * 0.18, r + Math.sin(a1) * r * 0.18);
        x.closePath();
        x.fill();
      }
      // fade the rays out towards their tips, so the burst has no hard edge
      x.globalAlpha = 1;
      x.globalCompositeOperation = 'destination-out';
      const fade = x.createRadialGradient(r, r, r * 0.45, r, r, r);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(1, 'rgba(0,0,0,1)');
      x.fillStyle = fade;
      x.fillRect(0, 0, r * 2, r * 2);
    });
  }

  // One page of the menu: up to three drinks, each a gold glass beside its name.
  function pourPage(W, H, drinks, icons) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      const top = Math.round(H * 0.18), bottom = Math.round(H * 0.91);
      const rowH = (bottom - top) / 3;
      const iconW = Math.round(W * 0.2), iconH = Math.round(rowH * 0.78);
      const textX = Math.round(W * 0.31), textW = Math.round(W * 0.93) - textX;
      x.textAlign = 'left';
      x.textBaseline = 'middle';
      drinks.forEach((d, i) => {
        const y = top + i * rowH, cy = y + rowH / 2;
        if (i > 0) {
          x.fillStyle = rgba(GOLD, 0.3);
          x.fillRect(Math.round(W * 0.08), Math.round(y), Math.round(W * 0.84), hair(s));
        }
        const icon = icons(d, iconW, iconH);
        x.drawImage(icon.liquid, 0, icon.yTop + (icon.yBottom - icon.yTop) * 0.3, iconW, (icon.yBottom - icon.yTop) * 0.7,
          Math.round(W * 0.07), Math.round(cy - iconH / 2) + icon.yTop + (icon.yBottom - icon.yTop) * 0.3, iconW, (icon.yBottom - icon.yTop) * 0.7);
        x.drawImage(icon.outline, Math.round(W * 0.07), Math.round(cy - iconH / 2));
        tracking(x, s * 0.008);
        const max = Math.round(s * 0.094);
        let size = fitSize(x, d.name, 'Josefin Sans', textW, max), lines = [d.name];
        if (size < s * 0.07 && d.name.includes(' ')) {
          const b = fitWrapped(x, d.name, 'Josefin Sans', textW, Math.min(rowH * 0.7, max * 2.3), 2, 1.12);
          if (b.size > size) { size = b.size; lines = b.lines; }
        }
        x.font = font('Josefin Sans', size);
        x.fillStyle = IVORY;
        lines.forEach((l, k) => x.fillText(l, textX, Math.round(cy + (k - (lines.length - 1) / 2) * size * 1.12 + size * 0.06)));
        tracking(x, 0);
      });
    });
  }

  function pour(canvas, W, H, opts) {
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    const conf = opts.conf || {};
    const lw = Math.max(2, Math.round(s * 0.008));
    let t0 = null;

    if (!conf.order) {
      // ---- the menu
      const menu = (conf.menu || []).slice(0, 30);
      const iconLw = Math.max(1, Math.round(s * 0.006));
      const icons = new Map();
      const iconFor = (d, w, h) => cached(icons, `${d.glass}|${d.colour}|${w}x${h}`, () => pourGlass(d, w, h, iconLw, false));
      const menuCard = () => offscreen(W, H, (x) => {
        x.fillStyle = '#000';
        x.fillRect(0, 0, W, H);
        frame(x, W, H);
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        decoRule(x, W / 2 - W * 0.16, Math.round(H * 0.06), W * 0.32, s);
        tracking(x, s * 0.012);
        x.font = font('Poiret One', fitSize(x, 'THE HOUSE POUR', 'Poiret One', W * 0.8, s * 0.1));
        x.fillStyle = IVORY;
        x.fillText('THE HOUSE POUR', W / 2 + s * 0.006, Math.round(H * 0.115));
        tracking(x, 0);
        if (!menu.length) message(x, W, H * 0.2, H, 'Tonight’s drinks are chosen on the control page');
      });
      const pages = [];
      for (let i = 0; i < menu.length; i += 3) pages.push(menu.slice(i, i + 3));
      const pageAt = new Map();
      const pageImg = (i) => cached(pageAt, i, () => pourPage(W, H, pages[i], iconFor));
      const dots = pages.length > 1 ? offscreen(W, 12, (x) => {
        x.fillStyle = rgba(GOLD, 0.45);
        const gap = Math.round(s * 0.04), x0 = Math.round(W / 2 - ((pages.length - 1) * gap) / 2);
        for (let i = 0; i < pages.length; i++) x.fillRect(x0 + i * gap - 1, 5, 3, 3);
      }) : null;
      let shown = -1, card = null, fontsIn = false;
      const stop = animate((t) => {
        if (t0 === null) t0 = t;
        const age = t - t0;
        if (!card || (!fontsIn && pourFonts())) { fontsIn = pourFonts(); card = menuCard(); pageAt.clear(); shown = -1; }
        const i = pages.length ? Math.floor(age / POUR_PAGE) % pages.length : -1;
        const into = age % POUR_PAGE;
        const fade = pages.length > 1 ? Math.min(1, into / 0.9, (POUR_PAGE - into) / 0.6) : Math.min(1, age / 0.6);
        if (fade >= 1 && shown === i) return; // a page holding still: nothing to redraw
        shown = fade >= 1 ? i : -1;
        ctx.drawImage(card, 0, 0);
        if (i < 0) return;
        ctx.globalAlpha = Math.max(0, fade);
        ctx.drawImage(pageImg(i), 0, 0);
        ctx.globalAlpha = 1;
        if (dots) {
          ctx.drawImage(dots, 0, Math.round(H * 0.935));
          const gap = Math.round(s * 0.04), x0 = Math.round(W / 2 - ((pages.length - 1) * gap) / 2);
          ctx.fillStyle = GOLD_LIGHT;
          ctx.fillRect(x0 + i * gap - 2, Math.round(H * 0.935) + 4, 5, 5);
        }
      }, 30);
      return { stop };
    }

    // ---- a drink being made, or just served
    const order = conf.order;
    const drink = order.drink || {};
    const served = order.phase === 'served';
    // the glass stands above a fixed band for the drink's name, which takes one line or two
    const nameBand = [H * 0.805, H * 0.955];
    const box = { x: Math.round(W * 0.1), y: Math.round(H * 0.13), w: Math.round(W * 0.8), h: Math.round(H * 0.66) };
    const g = pourGlass(drink, box.w, box.h, lw, true);
    const burst = served ? pourBurst(Math.round(s * 0.5)) : null;
    const orderCard = () => offscreen(W, H, (x) => {
      frame(x, W, H);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      const head = served ? 'SERVED' : order.guest ? `FOR ${order.guest}` : 'THE HOUSE POUR';
      tracking(x, s * 0.02);
      x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, head, 'Josefin Sans', W * 0.82, s * 0.078)));
      x.fillStyle = GOLD;
      x.fillText(head, W / 2 + s * 0.01, Math.round(H * 0.085));
      tracking(x, 0);
      const name = article((drink.name || 'DRINK').toUpperCase());
      tracking(x, s * 0.008);
      let size = fitSize(x, name, 'Poiret One', W * 0.86, s * 0.13), lines = [name];
      if (size < s * 0.095 && name.includes(' ')) {
        const b = fitWrapped(x, name, 'Poiret One', W * 0.86, nameBand[1] - nameBand[0], 2, 1.06);
        if (b.size > size) { size = b.size; lines = b.lines; }
      }
      x.font = font('Poiret One', size);
      x.fillStyle = IVORY;
      const cy = (nameBand[0] + nameBand[1]) / 2;
      lines.forEach((l, k) => x.fillText(l, W / 2, Math.round(cy + (k - (lines.length - 1) / 2) * size * 1.06)));
      tracking(x, 0);
    });

    // bubbles rise from the bottom of the drink to its surface
    const bubbles = [];
    if (drink.bubbles) {
      const n = drink.glass === 'flute' ? 9 : drink.glass === 'highball' ? 14 : 10;
      for (let i = 0; i < n; i++) bubbles.push({ u: Math.random(), y: g.yTop + Math.random() * (g.yBottom - g.yTop), v: 6 + Math.random() * 14, big: Math.random() < 0.3 });
    }
    const pourEase = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - Math.pow(1 - u, 1.7));
    let last = null, card = null, fontsIn = false;

    const stop = animate((t) => {
      if (t0 === null) t0 = t;
      const age = t - t0;
      if (!card || (!fontsIn && pourFonts())) { fontsIn = pourFonts(); card = orderCard(); }
      const dt = last === null ? 0 : Math.min(0.1, t - last);
      last = t;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const gx = box.x, gy = box.y;
      if (burst) {
        const u = Math.min(1, age / POUR_BURST);
        const k = 0.55 + 0.6 * ease(u);
        const size = burst.width * k;
        ctx.globalAlpha = 0.18 + 0.72 * Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - u * 0.4);
        ctx.drawImage(burst, Math.round(gx + g.cx - size / 2), Math.round(gy + (g.top + g.yBottom) / 2 - size / 2), size, size);
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(card, 0, 0);

      const p = served ? 1 : pourEase((age - 0.7) / POUR_FILL);
      const full = g.yBottom - g.yTop;
      const level = Math.round(g.yBottom - full * p);
      const depth = g.yBottom - level;
      if (depth > 0) {
        let bodyTop = level, band = 0;
        if (g.layer === 'top' && g.liquid2) band = Math.round(Math.min(depth * 0.3, full * 0.17));
        if (g.layer === 'bottom' && g.liquid2) band = Math.round(Math.min(depth, full * 0.2));
        if (g.layer === 'top') bodyTop = level + band;
        if (g.yBottom - bodyTop > 0) ctx.drawImage(g.liquid, 0, bodyTop, g.w, g.yBottom - bodyTop, gx, gy + bodyTop, g.w, g.yBottom - bodyTop);
        if (band > 0 && g.layer === 'top') ctx.drawImage(g.liquid2, 0, level, g.w, band, gx, gy + level, g.w, band);
        if (band > 0 && g.layer === 'bottom') ctx.drawImage(g.liquid2, 0, g.yBottom - band, g.w, band, gx, gy + g.yBottom - band, g.w, band);
        const surf = g.layer === 'top' && band > 0 ? g.surface2 : g.surface;
        ctx.drawImage(surf, 0, level, g.w, 1, gx, gy + level, g.w, 1);
      }
      // the pour itself: a thin stream from above while the glass fills
      if (!served && p > 0 && p < 1) {
        const a = Math.min(1, (age - 0.7) / 0.3, (POUR_FILL + 0.7 - age) / 0.6);
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = mix(liquidLook(drink.colour).color, '#ffffff', 0.15);
        const sw = Math.max(2, Math.round(lw * 1.2));
        ctx.fillRect(gx + g.cx - Math.floor(sw / 2), gy, sw, level);
        ctx.globalAlpha = 1;
      }
      for (const b of bubbles) {
        b.y -= b.v * dt;
        if (b.y < level + 1) { b.y = g.yBottom - 2; b.u = Math.random(); }
        const row = g.rows[Math.round(b.y)];
        if (!row || b.y < level + 1) continue;
        const bx = Math.round(row[0] + 1 + b.u * Math.max(0, row[1] - row[0] - 2));
        ctx.fillStyle = 'rgba(255,255,250,0.75)';
        ctx.fillRect(gx + bx, Math.round(gy + b.y), b.big ? 2 : 1, b.big ? 2 : 1);
      }
      if (g.ice) {
        if (depth > 0) ctx.drawImage(g.frost, 0, level, g.w, depth, gx, gy + level, g.w, depth);
        ctx.drawImage(g.ice, gx, gy);
      }
      ctx.globalAlpha = served ? 1 : Math.min(1, age / 0.7);
      ctx.drawImage(g.outline, gx, gy);
      ctx.globalAlpha = 1;
      if (g.garnish) {
        const u = served ? 1 : ease((age - POUR_FILL - 0.8) / 0.6);
        if (u > 0) {
          ctx.globalAlpha = u;
          ctx.drawImage(g.garnish, gx - g.pad, Math.round(gy - g.pad - (1 - u) * s * 0.08));
          ctx.globalAlpha = 1;
        }
      }
    }, 30);
    return { stop };
  }

  // ------------------------------------------------------------ channel ident

  // Shown for a few seconds when the channel changes: a quiet black title slide.
  function drawIdent(canvas, W, H, channel, barName) {
    const theme = THEMES[channel] || THEMES.rotation;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    frame(ctx, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = H / 2;
    tracking(ctx, s * 0.016);
    ctx.font = font('Josefin Sans', small(s));
    ctx.fillStyle = MUTED;
    ctx.fillText(`CHANNEL ${theme.n}`, W / 2, cy - s * 0.14);
    tracking(ctx, s * 0.014);
    ctx.font = font('Poiret One', fitSize(ctx, theme.name, 'Poiret One', W * 0.8, s * 0.14));
    ctx.fillStyle = IVORY;
    ctx.fillText(theme.name, W / 2, cy);
    decoRule(ctx, W / 2 - W * 0.14, cy + s * 0.1, W * 0.28, s);
    const sub = (barName || '').toUpperCase();
    if (sub) {
      tracking(ctx, s * 0.016);
      ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, sub, 'Josefin Sans', W * 0.8, small(s))));
      ctx.fillStyle = GOLD;
      ctx.fillText(sub, W / 2, cy + s * 0.17);
    }
    tracking(ctx, 0);
  }

  const FACTORIES = { scores, news, weather, visuals, live, pour };

  window.BarChannels = {
    THEMES,
    init(helpers) { if (helpers && helpers.fontStr) fontStr = helpers.fontStr; },
    create(name, canvas, W, H, opts) {
      canvas.width = W;
      canvas.height = H;
      return (FACTORIES[name] || visuals)(canvas, W, H, opts || {});
    },
    drawIdent,
    // Shared drawing kit, used by the games so they match the channels.
    kit: { font, fitSize, fitWrapped, glow, rgba, roundRect, tracking, gold, decoRule, header, backdrop, sunburst, timeStr, THEMES, GOLD, GOLD_LIGHT, IVORY, MUTED },
  };
})();
