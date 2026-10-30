// Live channels for the bar's LED walls. Each one draws into a canvas at the wall's own pixel
// size and animates itself. The look is "dark deco": noir city skylines against a blood-red sky,
// searchlights and airships, finished with champagne gold, ivory capitals and one jewel tone per
// channel. Black is most of the picture, so the unused LEDs stay off.
(() => {
  'use strict';

  // Champagne gold, ivory and black, with one jewel tone per channel.
  const GOLD = '#c5a467';
  const GOLD_LIGHT = '#e4d2a6';
  const GOLD_DARK = '#7a6238';
  const IVORY = '#efe6d2';
  const THEMES = {
    rotation: { n: 1, name: 'THE BAR', accent: '#e9c46a' },  // gold
    scores: { n: 2, name: 'SCORES', accent: '#2fd39a' },      // emerald
    news: { n: 3, name: 'NEWS', accent: '#ff4d6a' },          // ruby
    weather: { n: 4, name: 'WEATHER', accent: '#5aa2ff' },    // sapphire
    visuals: { n: 5, name: 'VISUALS', accent: '#b98aff' },    // amethyst
    games: { n: 6, name: 'GAMES', accent: '#ffa94d' },        // topaz
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

  // Gold is always flat champagne: no shine, no gradient.
  function gold() {
    return GOLD;
  }

  function tracking(ctx, px) {
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(px * 10) / 10}px`;
  }

  // A rectangle whose corners step inwards twice, the signature deco corner.
  function steppedRect(ctx, inset, W, H, step) {
    const x0 = inset, y0 = inset, x1 = W - inset, y1 = H - inset;
    ctx.beginPath();
    ctx.moveTo(x0 + step * 2, y0);
    ctx.lineTo(x1 - step * 2, y0); ctx.lineTo(x1 - step * 2, y0 + step); ctx.lineTo(x1 - step, y0 + step);
    ctx.lineTo(x1 - step, y0 + step * 2); ctx.lineTo(x1, y0 + step * 2);
    ctx.lineTo(x1, y1 - step * 2); ctx.lineTo(x1 - step, y1 - step * 2); ctx.lineTo(x1 - step, y1 - step);
    ctx.lineTo(x1 - step * 2, y1 - step); ctx.lineTo(x1 - step * 2, y1);
    ctx.lineTo(x0 + step * 2, y1); ctx.lineTo(x0 + step * 2, y1 - step); ctx.lineTo(x0 + step, y1 - step);
    ctx.lineTo(x0 + step, y1 - step * 2); ctx.lineTo(x0, y1 - step * 2);
    ctx.lineTo(x0, y0 + step * 2); ctx.lineTo(x0 + step, y0 + step * 2); ctx.lineTo(x0 + step, y0 + step);
    ctx.lineTo(x0 + step * 2, y0 + step);
    ctx.closePath();
  }

  // Two nested stepped borders, with a small quarter-fan tucked into each corner.
  function decoFrame(ctx, W, H) {
    const s = Math.min(W, H);
    const lw = Math.max(1, Math.round(s * 0.004));
    const i1 = Math.max(1, Math.round(s * 0.012));
    const i2 = i1 + Math.max(2, Math.round(s * 0.014));
    const step = Math.max(3, Math.round(s * 0.034));
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = rgba(GOLD, 0.85);
    steppedRect(ctx, i1 + lw / 2, W, H, step);
    ctx.stroke();
    ctx.strokeStyle = rgba(GOLD, 0.4);
    steppedRect(ctx, i2 + lw / 2, W, H, Math.max(2, step * 0.6));
    ctx.stroke();
    const fr = step * 1.15;
    ctx.strokeStyle = rgba(GOLD, 0.7);
    [[i2 + step, i2 + step, 0], [W - i2 - step, i2 + step, 0.5], [W - i2 - step, H - i2 - step, 1], [i2 + step, H - i2 - step, 1.5]]
      .forEach(([cx, cy, q]) => {
        for (let k = 1; k <= 3; k++) {
          ctx.beginPath();
          ctx.arc(cx, cy, fr * (k / 3), Math.PI * q, Math.PI * (q + 0.5));
          ctx.stroke();
        }
      });
    ctx.restore();
  }

  // A double gold line that fades out at both ends, with a stepped diamond in the middle.
  function decoRule(ctx, x, y, w, s) {
    const lw = Math.max(1, Math.round(s * 0.005));
    const gap = Math.max(1, Math.round(s * 0.006));
    const d = Math.max(3, Math.round(s * 0.02));
    const cx = x + w / 2, cy = y + lw + gap / 2;
    const fade = ctx.createLinearGradient(x, 0, x + w, 0);
    fade.addColorStop(0, rgba(GOLD, 0));
    fade.addColorStop(0.18, GOLD);
    fade.addColorStop(0.82, GOLD);
    fade.addColorStop(1, rgba(GOLD, 0));
    ctx.fillStyle = fade;
    ctx.fillRect(x, y, w, lw);
    ctx.fillRect(x, y + lw + gap, w, lw);
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - d * 2.9, y - 1, d * 5.8, lw * 2 + gap + 2);
    const diamond = (dx, r) => {
      ctx.beginPath();
      ctx.moveTo(dx, cy - r); ctx.lineTo(dx + r, cy); ctx.lineTo(dx, cy + r); ctx.lineTo(dx - r, cy);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = gold(ctx, cx - d, cy - d, cx + d, cy + d);
    diamond(cx, d);
    ctx.fillStyle = '#000';
    diamond(cx, d * 0.45);
    ctx.fillStyle = GOLD;
    diamond(cx, d * 0.22);
    diamond(cx - d * 1.9, d * 0.42);
    diamond(cx + d * 1.9, d * 0.42);
    return lw * 2 + gap;
  }

  // Cut-corner octagon with a double gold outline: the channel badge and the crest.
  function octagon(ctx, x, y, size, inset) {
    const c = size * 0.26, o = inset || 0;
    ctx.beginPath();
    ctx.moveTo(x + c + o * 0.4, y + o); ctx.lineTo(x + size - c - o * 0.4, y + o);
    ctx.lineTo(x + size - o, y + c + o * 0.4); ctx.lineTo(x + size - o, y + size - c - o * 0.4);
    ctx.lineTo(x + size - c - o * 0.4, y + size - o); ctx.lineTo(x + c + o * 0.4, y + size - o);
    ctx.lineTo(x + o, y + size - c - o * 0.4); ctx.lineTo(x + o, y + c + o * 0.4);
    ctx.closePath();
  }
  function badge(ctx, x, y, size, s, text, color) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    octagon(ctx, x, y, size);
    ctx.fill();
    ctx.lineWidth = Math.max(1, Math.round(s * 0.006));
    ctx.strokeStyle = gold(ctx, x, y, x + size, y + size);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, Math.round(s * 0.003));
    ctx.strokeStyle = rgba(GOLD, 0.45);
    octagon(ctx, x, y, size, Math.max(2, size * 0.11));
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.font = font('Poiret One', fitSize(ctx, text, 'Poiret One', size * 0.6, size * 0.6));
    ctx.fillText(text, x + size / 2, y + size / 2 + size * 0.03);
  }

  // Seeded random numbers, so a wall always gets the same city.
  function rng(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A dark deco city: skyscrapers with stepped setbacks, spires and masts, in two layers of
  // silhouette, plus the positions of their windows. `height` is how tall the tallest tower gets.
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
    const layers = [{ shade: '#1c0707', scale: 1, lit: 0.12, near: false }, { shade: '#000000', scale: 0.72, lit: 0.2, near: true }];
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
        const ws = Math.max(1, Math.round(s * 0.007));
        for (let wy = top + ws * 2; wy < H - ws * 2; wy += ws * 2.8) {
          for (let wx = bx + ws * 1.5; wx < bx + bw - ws * 1.5; wx += ws * 2.4) {
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

  // Lit windows; a few switch on and off slowly, like a city late at night.
  function cityLights(ctx, cityData, t, strength) {
    for (const w of cityData.windows) {
      const on = Math.sin(t * 0.05 + w.phase) > -0.55;
      if (!on) continue;
      ctx.fillStyle = w.near ? `rgba(255,196,107,${strength})` : `rgba(190,110,50,${strength * 0.7})`;
      ctx.fillRect(w.x, w.y, w.w, w.h);
    }
  }

  // Noir sky: black overhead, burning down to deep red at the horizon.
  function redSky(ctx, W, H, horizon, strength) {
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.5, rgba('#2a0404', strength));
    g.addColorStop(0.82, rgba('#6e1209', strength));
    g.addColorStop(1, rgba('#c23a12', strength));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizon);
    ctx.fillStyle = rgba('#c23a12', strength);
    ctx.fillRect(0, horizon, W, H - horizon);
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
      const s = Math.min(W, H);
      redSky(x, W, H, H, 0.55);
      sunburst(x, W / 2, H * 1.02, Math.hypot(W, H), 40, GOLD, 0.035);
      const town = city(W, H, s * 0.3);
      x.globalAlpha = 0.9;
      x.drawImage(town.canvas, 0, 0);
      x.globalAlpha = 1;
      cityLights(x, town, 0, 0.45);
      const g = x.createRadialGradient(W / 2, H, 0, W / 2, H, Math.max(W, H) * 0.7);
      g.addColorStop(0, rgba(accent, 0.08));
      g.addColorStop(1, rgba(accent, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      decoFrame(x, W, H);
      if (backdrops.size > 12) backdrops.clear();
      backdrops.set(key, c);
    }
    ctx.drawImage(c, 0, 0);
  }

  // The channel badge, the name in deco capitals, a subtitle, the clock, and a deco rule
  // underneath. Returns its height.
  function header(ctx, W, H, theme, label) {
    const s = Math.min(W, H);
    const hh = Math.max(12, Math.round(s * 0.15));
    const pad = Math.max(4, Math.round(s * 0.05));
    const ruleH = Math.round(s * 0.02);
    const bs = Math.round((hh - ruleH) * 0.78);
    const by = Math.round((hh - ruleH - bs) / 2) + Math.round(s * 0.008);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, hh);
    badge(ctx, pad, by, bs, s, String(theme.n), theme.accent);
    const midY = by + bs / 2 + 1;
    const clock = timeStr(new Date());
    ctx.font = font('Josefin Sans', bs * 0.42);
    tracking(ctx, s * 0.004);
    const cw = ctx.measureText(clock).width;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD_LIGHT;
    ctx.fillText(clock, W - pad, midY);
    const nx = pad + bs + Math.round(pad * 0.6);
    const room = W - nx - cw - pad * 2;
    ctx.textAlign = 'left';
    tracking(ctx, s * 0.006);
    tracking(ctx, s * 0.01);
    const nameSize = fitSize(ctx, theme.name, 'Josefin Sans', room * (label ? 0.62 : 1), bs * 0.5);
    ctx.font = font('Josefin Sans', nameSize);
    ctx.fillStyle = IVORY;
    ctx.fillText(theme.name, nx, midY);
    if (label) {
      const nw = ctx.measureText(theme.name).width + Math.round(pad * 0.5);
      tracking(ctx, s * 0.005);
      ctx.fillStyle = GOLD;
      ctx.font = font('Josefin Sans', fitSize(ctx, label, 'Josefin Sans', room - nw, nameSize * 0.62));
      ctx.fillText(label, nx + nw, midY + nameSize * 0.06);
    }
    tracking(ctx, 0);
    decoRule(ctx, 0, hh - ruleH, W, s);
    return hh;
  }

  function message(ctx, W, top, H, text, color) {
    const pad = Math.round(W * 0.08);
    const box = fitWrapped(ctx, text, 'Josefin Sans', W - pad * 2, (H - top) * 0.5, 3, 1.05);
    ctx.font = font('Josefin Sans', box.size);
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
      ctx.font = font('Barlow Medium', titleH * 0.6);
      const partW = partText ? ctx.measureText(partText).width + pad : 0;
      ctx.font = font('Josefin Sans', fitSize(ctx, page.name.toUpperCase(), 'Josefin Sans', W - pad * 2 - partW, titleH * 0.85));
      ctx.fillText(page.name.toUpperCase(), pad, y + titleH / 2);
      if (partText) {
        ctx.font = font('Barlow Medium', titleH * 0.6);
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
        ctx.fillStyle = i % 2 ? 'rgba(0,0,0,0.62)' : 'rgba(30,18,10,0.74)';
        ctx.fillRect(pad, ry + 1, W - pad * 2, rowH - 2);
        ctx.fillStyle = m.home.color || '#555';
        ctx.fillRect(pad, ry + 1, chipW, rowH - 2);
        ctx.fillStyle = m.away.color || '#555';
        ctx.fillRect(pad + teamsW - chipW, ry + 1, chipW, rowH - 2);
        const cy = ry + rowH / 2 + 1;
        const live = m.state === 'in';
        ctx.font = font('Barlow Medium', size);
        ctx.fillStyle = IVORY;
        ctx.textAlign = 'left';
        ctx.fillText(m.home.abbr, pad + chipW * 2, cy);
        ctx.textAlign = 'right';
        ctx.fillText(m.away.abbr, pad + teamsW - chipW * 2, cy);
        ctx.textAlign = 'center';
        const score = m.state === 'pre' ? 'v' : `${m.home.score}-${m.away.score}`;
        ctx.font = font('Josefin Sans', size * 0.85);
        ctx.fillStyle = live ? theme.accent : IVORY;
        ctx.fillText(score, pad + teamsW / 2, cy);
        const status = m.state === 'pre' ? kickoff(m.date) : (m.detail || m.clock || '').toUpperCase();
        ctx.font = font('Barlow Medium', fitSize(ctx, status, 'Barlow Medium', statusW - pad * 1.5, size * 0.85));
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
      m.font = font('Barlow Medium', h * 0.62);
      c.width = Math.min(30000, Math.ceil(m.measureText(text).width));
      c.height = h;
      m.font = font('Barlow Medium', h * 0.62);
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
      const box = fitWrapped(ctx, headline, 'Barlow Medium', W - pad * 2, bodyH * 0.86, 5, 1.08);
      ctx.font = font('Barlow Medium', box.size);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const blockH = box.lines.length * box.size * 1.08;
      const y0 = bodyTop + (bodyH - blockH) / 2;
      const reveal = Math.min(1, since / 0.45);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pad + (W - pad) * reveal, H);
      ctx.clip();
      ctx.fillStyle = IVORY;
      box.lines.forEach((l, i) => ctx.fillText(l, pad, y0 + i * box.size * 1.08));
      ctx.restore();
      if (reveal < 1) {
        ctx.fillStyle = theme.accent;
        ctx.fillRect(pad + (W - pad) * reveal, y0, Math.max(1, Math.round(pad * 0.12)), blockH);
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
      ctx.font = font('Josefin Sans', fitSize(ctx, 'LATEST', 'Josefin Sans', labelW * 0.85, tickH * 0.8));
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
      ctx.fillStyle = IVORY;
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
      ctx.fillStyle = IVORY;
      const tempSize = fitSize(ctx, temp, 'Josefin Light', tw, nowH * 0.58);
      ctx.font = font('Josefin Light', tempSize);
      ctx.fillText(temp, tx, top + nowH * 0.58);
      ctx.fillStyle = theme.accent;
      ctx.font = font('Josefin Sans', fitSize(ctx, desc.toUpperCase(), 'Josefin Sans', tw, nowH * 0.2));
      ctx.fillText(desc.toUpperCase(), tx, top + nowH * 0.8);
      const extra = `FEELS ${Math.round(now.feels)}°  ·  WIND ${Math.round(now.wind)} MPH`;
      ctx.fillStyle = '#9aa4b5';
      ctx.font = font('Barlow Medium', fitSize(ctx, extra, 'Barlow Medium', tw, nowH * 0.14));
      ctx.fillText(extra, tx, top + nowH * 0.97);

      // forecast: alternates between the next few hours and the next few days
      const showDays = Math.floor(t / 10) % 2 === 1 || !payload.hours.length;
      const fy = top + nowH + pad;
      const fh = H - fy - pad;
      const cols = W >= H ? 4 : 3;
      const list = showDays ? payload.days.slice(0, cols) : payload.hours.slice(0, cols);
      const cw = (W - pad * 2) / cols;
      ctx.fillStyle = 'rgba(0,0,0,0.66)';
      roundRect(ctx, pad, fy, W - pad * 2, fh, Math.max(2, pad * 0.5));
      ctx.fill();
      ctx.lineWidth = Math.max(1, Math.round(Math.min(W, H) * 0.004));
      ctx.strokeStyle = rgba(GOLD, 0.6);
      ctx.stroke();
      list.forEach((f, i) => {
        const cx = pad + cw * i + cw / 2;
        const name = showDays
          ? (i === 0 ? 'TODAY' : new Date(f.date + 'T12:00').toLocaleDateString([], { weekday: 'short' }).toUpperCase())
          : f.time;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#9aa4b5';
        ctx.font = font('Barlow Medium', fitSize(ctx, name, 'Barlow Medium', cw * 0.9, fh * 0.2));
        ctx.fillText(name, cx, fy + fh * 0.16);
        weatherIcon(ctx, wx(f.code)[1], cx, fy + fh * 0.48, Math.min(cw * 0.8, fh * 0.42), t + i, true);
        const temps = showDays ? `${Math.round(f.max)}° ${Math.round(f.min)}°` : `${Math.round(f.temp)}°`;
        ctx.fillStyle = IVORY;
        ctx.font = font('Barlow Medium', fitSize(ctx, temps, 'Barlow Medium', cw * 0.9, fh * 0.22));
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

    // The bar's sign: a monogram in a stepped deco archway with rays of light behind it, and the
    // name in fine deco capitals underneath.
    deco(W, H, opts) {
      const name = (opts.barName || 'THE BASEMENT').toUpperCase();
      const mono = monogram(name);
      const s = Math.min(W, H);
      const wide = W / H > 1.3;
      return (ctx, t) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        const aw = wide ? Math.min(H * 0.5, W * 0.26) : Math.min(W * 0.42, H * 0.34);
        const ah = aw * 1.35;
        const ax = wide ? W * 0.1 + aw / 2 : W / 2;
        const ay = wide ? H / 2 + ah * 0.05 : H * 0.1 + ah / 2;
        sunburst(ctx, ax, ay + ah * 0.18, Math.hypot(W, H), 32, GOLD, 0.11, Math.sin(t * 0.12) * 0.04);
        decoFrame(ctx, W, H);

        // stepped shoulders, then the archway
        const lw = Math.max(1, Math.round(s * 0.007));
        const arch = (inset) => {
          const r = aw / 2 - inset, top = ay - ah / 2 + inset, bottom = ay + ah / 2 - inset;
          ctx.beginPath();
          ctx.moveTo(ax - r, bottom);
          ctx.lineTo(ax - r, top + r);
          ctx.arc(ax, top + r, r, Math.PI, 0);
          ctx.lineTo(ax + r, bottom);
          ctx.closePath();
        };
        // stepped shoulders either side, as one ziggurat outline each
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = lw;
        ctx.lineJoin = 'miter';
        const bottom = ay + ah / 2, step = aw * 0.085, gap = lw * 3;
        const heights = [ah * 0.44, ah * 0.31, ah * 0.18];
        for (const dir of [-1, 1]) {
          const x0 = ax + dir * (aw / 2 + gap);
          ctx.beginPath();
          ctx.moveTo(x0, bottom);
          heights.forEach((h, i) => {
            ctx.lineTo(x0 + dir * step * i, bottom - h);
            ctx.lineTo(x0 + dir * step * (i + 1), bottom - h);
          });
          ctx.lineTo(x0 + dir * step * heights.length, bottom);
          ctx.closePath();
          ctx.stroke();
        }
        ctx.fillStyle = '#000';
        arch(0);
        ctx.fill();
        ctx.save();
        arch(lw * 3);
        ctx.clip();
        sunburst(ctx, ax, ay + ah / 2, ah, 20, GOLD, 0.2);
        ctx.restore();
        ctx.lineWidth = lw;
        ctx.strokeStyle = gold(ctx, ax - aw / 2, ay - ah / 2, ax + aw / 2, ay + ah / 2);
        arch(0);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, lw * 0.5);
        ctx.strokeStyle = rgba(GOLD, 0.6);
        arch(lw * 3);
        ctx.stroke();
        // monogram
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font('Poiret One', fitSize(ctx, mono, 'Poiret One', aw * 0.62, ah * 0.42));
        ctx.fillStyle = GOLD;
        ctx.fillText(mono, ax, ay + ah * 0.12);

        // the name, in gold foil
        const tx = wide ? ax + aw / 2 + aw * 0.35 + W * 0.03 : W * 0.08;
        const tw = wide ? W - tx - W * 0.07 : W * 0.84;
        const ty = wide ? H * 0.2 : ay + ah / 2 + H * 0.05;
        const th = wide ? H * 0.6 : H - ty - H * 0.1;
        tracking(ctx, s * 0.012);
        const box = fitWrapped(ctx, name, 'Poiret One', tw, th * 0.7, 2, 1.1);
        ctx.font = font('Poiret One', box.size);
        const blockH = box.lines.length * box.size * 1.1;
        const y0 = ty + (th - blockH) / 2 + box.size * 0.55;
        ctx.fillStyle = IVORY;
        box.lines.forEach((l, i) => ctx.fillText(l, tx + tw / 2, y0 + i * box.size * 1.1));
        tracking(ctx, 0);
        decoRule(ctx, tx + tw * 0.12, Math.min(H - s * 0.08, y0 + (box.lines.length - 0.35) * box.size * 1.1), tw * 0.76, s);
      };
    },

    // Dark deco city at night: red sky, drifting cloud, searchlights sweeping overhead, an airship
    // gliding past with its tail light blinking, and windows going on and off.
    skyline(W, H) {
      const s = Math.min(W, H);
      const horizon = H;
      const town = city(W, H, H * 0.62);
      const rand = rng(W + H * 3);
      const clouds = Array.from({ length: 6 }, () => ({ y: H * (0.08 + rand() * 0.4), w: W * (0.35 + rand() * 0.5), h: s * (0.02 + rand() * 0.04), x: rand() * W, v: 0.004 + rand() * 0.008 }));
      const lights = [0.22, 0.58, 0.85].map((p, i) => ({ x: W * p, speed: 0.18 + i * 0.07, phase: i * 2.1 }));
      return (ctx, t) => {
        redSky(ctx, W, H, horizon, 1);
        for (const c of clouds) {
          const cx = ((c.x + t * c.v * W) % (W + c.w)) - c.w / 2;
          ctx.fillStyle = 'rgba(8,0,0,0.55)';
          ctx.beginPath();
          ctx.ellipse(cx, c.y, c.w / 2, c.h, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // searchlights, behind the towers
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const len = Math.hypot(W, H) * 1.2;
        for (const L of lights) {
          const a = Math.sin(t * L.speed + L.phase) * 0.55;
          const spread = 0.035;
          const g = ctx.createLinearGradient(L.x, H, L.x + Math.sin(a) * len, H - Math.cos(a) * len);
          g.addColorStop(0, 'rgba(255,235,200,0.5)');
          g.addColorStop(1, 'rgba(255,235,200,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(L.x - s * 0.01, H);
          ctx.lineTo(L.x + Math.sin(a - spread) * len, H - Math.cos(a - spread) * len);
          ctx.lineTo(L.x + Math.sin(a + spread) * len, H - Math.cos(a + spread) * len);
          ctx.lineTo(L.x + s * 0.01, H);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        // the airship
        const rx = s * 0.13, ry = rx * 0.3;
        const ax = ((t * W * 0.012) % (W + rx * 4)) - rx * 2;
        const ay = H * 0.2 + Math.sin(t * 0.3) * s * 0.01;
        ctx.fillStyle = '#050101';
        ctx.beginPath();
        ctx.ellipse(ax, ay, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(ax - rx * 0.8, ay);
        ctx.lineTo(ax - rx * 1.15, ay - ry * 1.1);
        ctx.lineTo(ax - rx * 1.05, ay);
        ctx.lineTo(ax - rx * 1.15, ay + ry * 1.1);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(ax - rx * 0.25, ay + ry * 0.85, rx * 0.5, ry * 0.45);
        ctx.strokeStyle = 'rgba(255,120,60,0.35)';
        ctx.lineWidth = Math.max(1, s * 0.003);
        ctx.beginPath();
        ctx.ellipse(ax, ay, rx, ry, 0, Math.PI * 1.05, Math.PI * 1.95);
        ctx.stroke();
        if ((t % 1.6) < 0.18) {
          ctx.fillStyle = '#ff2a1a';
          glow(ctx, '#ff2a1a', s * 0.03, () => { ctx.beginPath(); ctx.arc(ax - rx * 1.1, ay, Math.max(1, s * 0.006), 0, Math.PI * 2); ctx.fill(); });
        }
        ctx.drawImage(town.canvas, 0, 0);
        cityLights(ctx, town, t, 0.95);
        decoFrame(ctx, W, H);
      };
    },

    // A 1930s lift floor indicator. The needle rests on B with its lamp lit, now and then rises
    // to the top floor, and comes back down to The Basement.
    lift(W, H, opts) {
      const name = (opts.barName || 'THE BASEMENT').toUpperCase();
      const floors = ['B', 'G', '1', '2', '3', '4', '5'];
      const top = floors.length - 1;
      const s = Math.min(W, H);
      const wide = W / H > 1.3;
      const R = wide ? Math.min(H * 0.5, W * 0.24) : Math.min(W * 0.4, H * 0.3);
      const cx = wide ? W * 0.09 + R : W / 2;
      const cy = wide ? H * 0.64 : H * 0.1 + R;
      const lw = Math.max(1, Math.round(s * 0.005));
      const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2);
      const floorAt = (t) => {
        const p = t % 45;
        if (p < 24) return 0;
        if (p < 31) return ease((p - 24) / 7) * top;
        if (p < 34) return top;
        return (1 - ease((p - 34) / 11)) * top;
      };
      const angle = (pos) => Math.PI + (0.08 + (pos / top) * 0.84) * Math.PI;
      const diamond = (ctx, x, y, r) => {
        ctx.beginPath();
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
      };
      return (ctx, t) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        decoFrame(ctx, W, H);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, Math.PI, 0);
        ctx.closePath();
        ctx.clip();
        sunburst(ctx, cx, cy, R, 30, GOLD, 0.1);
        ctx.restore();
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = lw;
        for (const k of [1, 0.93]) { ctx.beginPath(); ctx.arc(cx, cy, R * k, Math.PI, 0); ctx.stroke(); }
        ctx.beginPath(); ctx.moveTo(cx - R * 1.08, cy); ctx.lineTo(cx + R * 1.08, cy); ctx.stroke();
        const ph = Math.max(2, R * 0.08);
        ctx.strokeRect(cx - R * 1.08, cy + ph * 0.6, R * 2.16, ph);
        ctx.strokeRect(cx - R * 0.84, cy + ph * 1.6 + lw, R * 1.68, ph);

        const pos = floorAt(t);
        const moving = Math.abs(floorAt(t + 0.1) - pos) > 0.0005;
        const goingUp = floorAt(t + 0.1) > pos;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font('Poiret One', R * 0.17);
        floors.forEach((f, i) => {
          const a = angle(i);
          const lit = Math.abs(pos - i) < 0.3;
          ctx.fillStyle = lit ? IVORY : rgba(GOLD, 0.7);
          ctx.fillText(f, cx + Math.cos(a) * R * 0.76, cy + Math.sin(a) * R * 0.76);
          ctx.fillStyle = lit ? IVORY : GOLD;
          diamond(ctx, cx + Math.cos(a) * R * 0.965, cy + Math.sin(a) * R * 0.965, Math.max(1, R * 0.022));
        });
        const a = angle(pos);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = Math.max(1, lw * 1.3);
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(a) * R * 0.1, cy - Math.sin(a) * R * 0.1);
        ctx.lineTo(cx + Math.cos(a) * R * 0.58, cy + Math.sin(a) * R * 0.58);
        ctx.stroke();
        ctx.fillStyle = GOLD;
        diamond(ctx, cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6, Math.max(2, R * 0.035));
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.07, 0, Math.PI * 2); ctx.fill();
        ctx.stroke();
        ctx.fillStyle = GOLD;
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.025, 0, Math.PI * 2); ctx.fill();

        // the name, and what the lift is doing
        const tx = wide ? cx + R * 1.25 : W * 0.1;
        const tw = wide ? W - tx - W * 0.07 : W * 0.8;
        const ty = wide ? H * 0.2 : cy + ph * 3 + s * 0.06;
        const th = wide ? H * 0.6 : H - ty - s * 0.1;
        tracking(ctx, s * 0.012);
        const box = fitWrapped(ctx, name, 'Poiret One', tw, th * 0.55, 2, 1.12);
        ctx.font = font('Poiret One', box.size);
        ctx.fillStyle = IVORY;
        const y0 = ty + th * 0.08 + box.size / 2;
        box.lines.forEach((l, i) => ctx.fillText(l, tx + tw / 2, y0 + i * box.size * 1.12));
        const ry = y0 + (box.lines.length - 0.4) * box.size * 1.12;
        decoRule(ctx, tx + tw * 0.15, ry, tw * 0.7, s);
        const status = moving ? (goingUp ? 'GOING UP' : 'GOING DOWN') : pos < 0.3 ? 'FLOOR B' : `FLOOR ${floors[Math.round(pos)]}`;
        tracking(ctx, s * 0.014);
        ctx.font = font('Josefin Sans', fitSize(ctx, status, 'Josefin Sans', tw * 0.7, box.size * 0.32));
        ctx.fillStyle = GOLD;
        ctx.fillText(status, tx + tw / 2, ry + box.size * 0.55);
        tracking(ctx, 0);
      };
    },

    // An art deco wall clock: sunburst face, numerals at the quarters, lozenge hands and a
    // sweeping second hand, with the bar's name and the date beside it.
    clockface(W, H, opts) {
      const name = (opts.barName || 'THE BASEMENT').toUpperCase();
      const s = Math.min(W, H);
      const wide = W / H > 1.3;
      const R = wide ? Math.min(H * 0.4, W * 0.24) : Math.min(W * 0.4, H * 0.3);
      const cx = wide ? W * 0.09 + R : W / 2;
      const cy = wide ? H / 2 : H * 0.1 + R;
      const lw = Math.max(1, Math.round(s * 0.005));
      const hand = (ctx, a, len, wid) => {
        const c = Math.cos(a), sn = Math.sin(a), pc = Math.cos(a + Math.PI / 2), ps = Math.sin(a + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(cx - c * len * 0.12, cy - sn * len * 0.12);
        ctx.lineTo(cx + c * len * 0.3 + pc * wid, cy + sn * len * 0.3 + ps * wid);
        ctx.lineTo(cx + c * len, cy + sn * len);
        ctx.lineTo(cx + c * len * 0.3 - pc * wid, cy + sn * len * 0.3 - ps * wid);
        ctx.closePath();
        ctx.fill();
      };
      return (ctx) => {
        const now = new Date();
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        decoFrame(ctx, W, H);
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
        sunburst(ctx, cx, cy, R, 36, GOLD, 0.09);
        sunburst(ctx, cx, cy, R, 36, GOLD, 0.09, Math.PI);
        ctx.restore();
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = lw;
        for (const k of [1, 0.94, 0.28]) { ctx.beginPath(); ctx.arc(cx, cy, R * k, 0, Math.PI * 2); ctx.stroke(); }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font('Poiret One', R * 0.2);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
          if (i % 3 === 0) {
            ctx.fillStyle = IVORY;
            ctx.fillText(String(i === 0 ? 12 : i), cx + Math.cos(a) * R * 0.75, cy + Math.sin(a) * R * 0.75 + R * 0.01);
          } else {
            const x = cx + Math.cos(a) * R * 0.82, y = cy + Math.sin(a) * R * 0.82, d = Math.max(1.5, R * 0.03);
            ctx.fillStyle = GOLD;
            ctx.beginPath(); ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.fill();
          }
        }
        const secs = now.getSeconds() + now.getMilliseconds() / 1000;
        const mins = now.getMinutes() + secs / 60;
        const hrs = (now.getHours() % 12) + mins / 60;
        ctx.fillStyle = GOLD;
        hand(ctx, (hrs / 12) * Math.PI * 2 - Math.PI / 2, R * 0.5, R * 0.06);
        hand(ctx, (mins / 60) * Math.PI * 2 - Math.PI / 2, R * 0.78, R * 0.045);
        const sa = (secs / 60) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = IVORY;
        ctx.lineWidth = Math.max(1, lw * 0.6);
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(sa) * R * 0.18, cy - Math.sin(sa) * R * 0.18);
        ctx.lineTo(cx + Math.cos(sa) * R * 0.88, cy + Math.sin(sa) * R * 0.88);
        ctx.stroke();
        ctx.fillStyle = GOLD;
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.045, 0, Math.PI * 2); ctx.fill();

        const tx = wide ? cx + R * 1.25 : W * 0.1;
        const tw = wide ? W - tx - W * 0.07 : W * 0.8;
        const ty = wide ? H * 0.22 : cy + R + s * 0.06;
        const th = wide ? H * 0.56 : H - ty - s * 0.1;
        ctx.textAlign = 'center';
        tracking(ctx, s * 0.012);
        const box = fitWrapped(ctx, name, 'Poiret One', tw, th * 0.5, 2, 1.12);
        ctx.font = font('Poiret One', box.size);
        ctx.fillStyle = IVORY;
        const y0 = ty + th * 0.1 + box.size / 2;
        box.lines.forEach((l, i) => ctx.fillText(l, tx + tw / 2, y0 + i * box.size * 1.12));
        const ry = y0 + (box.lines.length - 0.4) * box.size * 1.12;
        decoRule(ctx, tx + tw * 0.15, ry, tw * 0.7, s);
        const date = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }).replace(/,/g, '').toUpperCase();
        tracking(ctx, s * 0.01);
        ctx.font = font('Josefin Sans', fitSize(ctx, date, 'Josefin Sans', tw * 0.9, box.size * 0.3));
        ctx.fillStyle = GOLD;
        ctx.fillText(date, tx + tw / 2, ry + box.size * 0.55);
        tracking(ctx, 0);
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

  };
  const MIX = ['skyline', 'deco', 'lift', 'clockface', 'fans', 'bubbles'];

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

  function monogram(name) {
    const words = (name || '').toUpperCase().split(/\s+/).filter((w) => w && !['THE', 'A', 'AN', 'AT'].includes(w));
    return (words.length ? words : ['B']).slice(0, 2).map((w) => w[0]).join('');
  }

  // Shown for a few seconds when the channel changes, like a TV station ident: the channel number
  // in a gold crest with a sunburst behind it, the channel name, and the bar's name.
  function drawIdent(canvas, W, H, channel, barName) {
    const theme = THEMES[channel] || THEMES.rotation;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const s = Math.min(W, H);
    const bh = Math.round(s * 0.42);
    const y = Math.round(H - bh - s * 0.07);
    const ruleH = Math.round(s * 0.02);
    const crest = Math.round(bh * 0.66);
    const cx = Math.round(s * 0.07) + crest / 2;
    const cy = y + bh / 2;
    ctx.save();
    ctx.translate(0, y);
    ctx.beginPath();
    ctx.rect(0, 0, W, bh);
    ctx.clip();
    redSky(ctx, W, bh, bh, 0.85);
    sunburst(ctx, cx, crest * 0.5 + bh / 2, bh * 1.2, 24, GOLD, 0.16);
    const town = city(W, bh, bh * 0.55);
    ctx.drawImage(town.canvas, 0, 0);
    cityLights(ctx, town, 0, 0.6);
    const shade = ctx.createLinearGradient(0, 0, W, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.75)');
    shade.addColorStop(0.7, 'rgba(0,0,0,0.35)');
    shade.addColorStop(1, 'rgba(0,0,0,0.1)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, bh);
    ctx.restore();
    decoRule(ctx, 0, y, W, s);
    decoRule(ctx, 0, y + bh - ruleH, W, s);
    badge(ctx, cx - crest / 2, cy - crest / 2, crest, s, String(theme.n), theme.accent);
    const x = cx + crest / 2 + s * 0.05;
    const room = W - x - s * 0.05;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    tracking(ctx, s * 0.008);
    ctx.fillStyle = IVORY;
    ctx.font = font('Poiret One', fitSize(ctx, theme.name, 'Poiret One', room, bh * 0.34));
    ctx.fillText(theme.name, x, cy - bh * 0.1);
    const sub = (barName || '').toUpperCase();
    if (sub) {
      tracking(ctx, s * 0.01);
      ctx.fillStyle = gold(ctx, x, 0, x + room, 0);
      ctx.font = font('Josefin Sans', fitSize(ctx, sub, 'Josefin Sans', room, bh * 0.15));
      ctx.fillText(sub, x, cy + bh * 0.2);
    }
    tracking(ctx, 0);
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
    // Shared drawing kit, used by the games so they match the channels.
    kit: { font, fitSize, fitWrapped, glow, rgba, roundRect, tracking, gold, decoRule, header, backdrop, sunburst, timeStr, THEMES, GOLD, GOLD_LIGHT, IVORY },
  };
})();
