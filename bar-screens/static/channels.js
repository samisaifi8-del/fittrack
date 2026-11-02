// Live channels for the bar's LED walls. Each one draws into a canvas at the wall's own pixel size
// and animates itself.
//
// The look is quiet luxury with a deco accent: black (so unused LEDs stay off), ivory type, and
// one muted gold kept for hairlines. Type does the work: Poiret One for titles, Cormorant Garamond
// for anything read like a headline, and small widely spaced Josefin Sans capitals for labels.
// Motion is slow and mostly fades. Where the subject has colours of its own (a club's kit and
// crest), they come in as light on the black, never as a filled background.
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
    nowshowing: { n: 8, name: 'NOW SHOWING', accent: GOLD },
    colours: { n: 9, name: 'COLOURS', accent: GOLD },
    pour: { n: 10, name: 'THE HOUSE POUR', accent: GOLD },
    verdict: { n: 11, name: 'THE VERDICT', accent: GOLD },
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

  // Club crests come through the Pi (/api/image) and are drawn down to each size once, in halving
  // steps so a 500 px PNG still looks crisp at 16 LEDs. Null until the image has loaded.
  const crests = new Map();
  function crest(url, size) {
    if (!url) return null;
    let c = crests.get(url);
    if (!c) {
      c = { img: new Image(), ok: false, sizes: new Map() };
      c.img.onload = () => { c.ok = true; };
      c.img.src = '/api/image?u=' + encodeURIComponent(url);
      crests.set(url, c);
    }
    if (!c.ok) return null;
    const px = Math.max(4, Math.round(size));
    if (!c.sizes.has(px)) {
      let src = c.img, w = src.naturalWidth || px;
      while (w / 2 >= px * 1.5) {
        const k = document.createElement('canvas');
        k.width = k.height = Math.round(w / 2);
        const x = k.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.drawImage(src, 0, 0, k.width, k.height);
        src = k; w = k.width;
      }
      const out = document.createElement('canvas');
      out.width = out.height = px;
      const x = out.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, 0, 0, px, px);
      c.sizes.set(px, out);
    }
    return c.sizes.get(px);
  }

  // A team's colour that shows up on black: its kit colour, else its second colour, else gold.
  function teamTint(t) {
    for (const c of [t.color, t.alt]) {
      if (!c) continue;
      const n = parseInt(c.slice(1), 16);
      const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
      if (lum > 0.14) return c;
    }
    return GOLD;
  }

  const EVENT_MARK = { goal: '', pen: ' (P)', og: ' (OG)', red: '' };

  // Where everything in the hero sits, and how tall it is: crests, names, up to five goals or red
  // cards a side, then the venue.
  function heroLayout(m, W, s) {
    const cs = Math.round(W * 0.27);
    const cy = Math.round(cs * 0.62);
    const nameY = cy + cs * 0.5 + s * 0.045;
    const lineH = Math.max(MIN_TEXT + 2, Math.round(s * 0.042));
    const evTop = nameY + lineH * 1.3;
    const per = (side) => (m.events || []).filter((e) => e.side === side).length;
    const lines = Math.min(5, Math.max(per('home'), per('away')));
    const venueY = lines ? evTop + lines * lineH + lineH * 0.3 : nameY + lineH * 1.6;
    return { cs, cy, nameY, lineH, evTop, lines, venueY, h: Math.round(venueY + (m.venue ? s * 0.045 : 0)) };
  }

  // The match at the top of the page, drawn once into its own canvas: both crests over a glow in
  // each team's colour, the score between them, the names, then the goals and red cards per side.
  function drawHero(m, W, s, L) {
    const c = document.createElement('canvas');
    c.width = W; c.height = L.h;
    const x = c.getContext('2d');
    const pre = m.state === 'pre';
    const { cs, cy } = L;
    const sides = [['home', W * 0.24], ['away', W * 0.76]];
    const lean = W * 0.06;
    for (const [side, dir] of [['home', -1], ['away', 1]]) {
      const tint = teamTint(m[side]);
      const g = x.createLinearGradient(0, 0, 0, L.h);
      g.addColorStop(0, rgba(tint, 0.3));
      g.addColorStop(0.55, rgba(tint, 0.1));
      g.addColorStop(1, rgba(tint, 0));
      x.fillStyle = g;
      x.beginPath();
      x.moveTo(W / 2 + lean, 0); x.lineTo(W / 2 - lean, L.h);
      x.lineTo(dir < 0 ? 0 : W, L.h); x.lineTo(dir < 0 ? 0 : W, 0);
      x.closePath();
      x.fill();
    }
    const seam = x.createLinearGradient(0, 0, 0, L.h);
    seam.addColorStop(0, rgba(GOLD, 0.5));
    seam.addColorStop(1, rgba(GOLD, 0));
    x.strokeStyle = seam;
    x.lineWidth = hair(s);
    x.beginPath(); x.moveTo(W / 2 + lean, 0); x.lineTo(W / 2 - lean, L.h); x.stroke();
    // a black pool behind the score so it reads over the seam
    const pool = x.createRadialGradient(W / 2, cy, 0, W / 2, cy, W * 0.16);
    pool.addColorStop(0, 'rgba(0,0,0,0.85)');
    pool.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = pool;
    x.fillRect(W / 2 - W * 0.16, cy - W * 0.16, W * 0.32, W * 0.32);
    for (const [side, cx] of sides) {
      const t = m[side], tint = teamTint(t);
      const g = x.createRadialGradient(cx, cy, cs * 0.1, cx, cy, cs * 0.95);
      g.addColorStop(0, rgba(tint, 0.42));
      g.addColorStop(0.55, rgba(tint, 0.12));
      g.addColorStop(1, rgba(tint, 0));
      x.fillStyle = g;
      x.fillRect(cx - cs, cy - cs, cs * 2, cs * 2);
      const img = crest(t.logo, cs);
      if (img) x.drawImage(img, Math.round(cx - cs / 2), Math.round(cy - cs / 2));
      else {
        // no crest (yet): the team's initials in a ring of its colour
        x.strokeStyle = tint;
        x.lineWidth = Math.max(2, Math.round(s * 0.008));
        x.beginPath(); x.arc(cx, cy, cs * 0.42, 0, Math.PI * 2); x.stroke();
        x.fillStyle = IVORY; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.font = font('Josefin Sans', fitSize(x, t.abbr, 'Josefin Sans', cs * 0.62, cs * 0.3));
        x.fillText(t.abbr, cx, cy + 1);
      }
      // the name under the crest
      const name = (t.name || t.abbr).toUpperCase();
      tracking(x, s * 0.004);
      x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, name, 'Josefin Sans', W * 0.42, s * 0.046)));
      x.fillStyle = IVORY; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(name, cx, L.nameY);
      tracking(x, 0);
    }
    // the score (or the kickoff) between the crests
    x.textAlign = 'center'; x.textBaseline = 'middle';
    if (pre) {
      const d = new Date(m.date), ko = Number.isNaN(d.getTime()) ? '' : timeStr(d);
      x.font = font('Josefin Light', fitSize(x, ko, 'Josefin Light', W * 0.24, s * 0.1));
      x.fillStyle = IVORY;
      x.fillText(ko, W / 2, cy);
    } else {
      const sc = `${m.home.score}–${m.away.score}`;
      x.font = font('Josefin Light', fitSize(x, sc, 'Josefin Light', W * 0.26, s * 0.17));
      x.fillStyle = m.state === 'in' ? GOLD_LIGHT : IVORY;
      x.fillText(sc, W / 2, cy + 1);
    }
    // goals and red cards, under each team's name
    const { lineH, evTop } = L, maxLines = L.lines;
    for (const [side, cx] of sides) {
      const list = (m.events || []).filter((e) => e.side === side);
      const shown = list.slice(0, maxLines);
      shown.forEach((e, i) => {
        const last = (e.who || '').replace(/^\p{Lu}\.\s*/u, '').toUpperCase();  // 'V. van Dijk' -> VAN DIJK
        const label = `${e.min} ${last}${EVENT_MARK[e.kind] || ''}`;
        const y = evTop + i * lineH;
        tracking(x, s * 0.003);
        x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, label, 'Josefin Sans', W * 0.38, lineH * 0.78)));
        const tw = x.measureText(label).width;
        x.fillStyle = e.kind === 'red' ? '#d23a3a' : GOLD_LIGHT;
        const mk = Math.max(3, Math.round(lineH * 0.42));
        if (e.kind === 'red') x.fillRect(Math.round(cx - tw / 2 - mk - 3), Math.round(y - mk * 0.65), mk, Math.round(mk * 1.3));
        else { x.beginPath(); x.arc(cx - tw / 2 - mk * 0.5 - 3, y, mk * 0.42, 0, Math.PI * 2); x.fill(); }
        x.fillStyle = IVORY;
        x.textAlign = 'center';
        x.fillText(label, cx, y + 1);
        tracking(x, 0);
      });
      if (list.length > shown.length && maxLines > 0) {
        x.fillStyle = MUTED;
        x.font = font('Josefin Sans', MIN_TEXT);
        x.fillText(`+${list.length - shown.length} MORE`, cx, evTop + shown.length * lineH);
      }
    }
    // where it's played
    if (m.venue) {
      tracking(x, s * 0.006);
      const v = m.venue.toUpperCase();
      x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, v, 'Josefin Sans', W * 0.8, s * 0.03)));
      x.fillStyle = MUTED;
      x.fillText(v, W / 2, L.venueY);
      tracking(x, 0);
    }
    return c;
  }

  // One row of the list under the hero: crest and code each side, the score between them, the
  // status on the right. The code size is fitted so the score never runs into a team's name.
  function drawRow(ctx, m, x0, x1, y, rowH, s, t) {
    const live = m.state === 'in';
    const cy = y + rowH / 2;
    const statusW = s * 0.22;
    const teamsR = x1 - statusW - s * 0.02;
    const cs = Math.round(rowH * 0.62);
    const score = m.state === 'pre' ? '·' : `${m.home.score}–${m.away.score}`;
    ctx.font = font('Josefin Light', rowH * 0.5);
    const scoreW = Math.max(ctx.measureText(score).width, rowH * 0.9);
    const mid = (x0 + teamsR) / 2;
    const room = (teamsR - x0) / 2 - scoreW / 2 - cs - s * 0.035;
    const abbrSize = Math.min(rowH * 0.36, ...[m.home.abbr, m.away.abbr].map((a) => fitSize(ctx, a, 'Josefin Sans', room, rowH * 0.36)));
    for (const [side, dir] of [['home', 1], ['away', -1]]) {
      const tm = m[side];
      const edge = dir > 0 ? x0 : teamsR;
      ctx.fillStyle = teamTint(tm);
      ctx.fillRect(Math.round(dir > 0 ? edge : edge - 2), Math.round(cy - rowH * 0.3), 2, Math.round(rowH * 0.6));
      const img = crest(tm.logo, cs);
      const cx = dir > 0 ? edge + 5 : edge - 5 - cs;
      if (img) ctx.drawImage(img, Math.round(cx), Math.round(cy - cs / 2));
      ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, abbrSize));
      ctx.fillStyle = IVORY;
      ctx.textAlign = dir > 0 ? 'left' : 'right';
      ctx.fillText(tm.abbr, dir > 0 ? cx + cs + s * 0.02 : cx - s * 0.02, cy + 1);
    }
    ctx.textAlign = 'center';
    ctx.font = font('Josefin Light', rowH * 0.5);
    ctx.fillStyle = live ? GOLD_LIGHT : IVORY;
    ctx.fillText(score, mid, cy + 1);
    const status = m.state === 'pre' ? kickoff(m.date) : (m.detail || m.clock || '').toUpperCase();
    tracking(ctx, s * 0.004);
    ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, status, 'Josefin Sans', statusW * 0.95, rowH * 0.3)));
    ctx.textAlign = 'right';
    ctx.fillStyle = live ? GOLD : MUTED;
    ctx.fillText(status, x1, cy + 1);
    tracking(ctx, 0);
    if (live) {
      ctx.save();
      ctx.globalAlpha *= 0.45 + 0.55 * Math.abs(Math.sin(t * 1.6));
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(x1 - ctx.measureText(status).width - rowH * 0.2, cy, Math.max(1.5, rowH * 0.06), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // A goal in a live match takes the whole wall for a few seconds. The still parts (crest, GOAL,
  // scorer, score) are drawn once; each frame only turns the rays and eases things in.
  const CELEBRATE = 9;
  function drawGoalCard(m, side, W, H, s) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const team = m[side], tint = teamTint(team);
    const cs = Math.round(W * 0.46);
    const img = crest(team.logo, cs);
    if (img) x.drawImage(img, Math.round(W / 2 - cs / 2), Math.round(H * 0.3 - cs / 2));
    x.textAlign = 'center'; x.textBaseline = 'middle';
    tracking(x, s * 0.02);
    x.font = font('Poiret One', fitSize(x, 'GOAL', 'Poiret One', W * 0.86, s * 0.27));
    x.shadowColor = tint; x.shadowBlur = s * 0.06;
    x.fillStyle = IVORY;
    x.fillText('GOAL', W / 2, H * 0.58);
    x.shadowBlur = 0;
    tracking(x, 0);
    const ev = (m.events || []).filter((e) => e.side === side && e.kind !== 'red').pop();
    if (ev) {
      const who = `${(ev.who || '').replace(/^\p{Lu}\.\s*/u, '').toUpperCase()}${EVENT_MARK[ev.kind] || ''}`.trim();
      tracking(x, s * 0.008);
      x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, who || team.name.toUpperCase(), 'Josefin Sans', W * 0.84, s * 0.075)));
      x.fillStyle = GOLD_LIGHT;
      x.fillText(who || team.name.toUpperCase(), W / 2, H * 0.71);
      x.font = font('Josefin Sans', Math.max(MIN_TEXT, s * 0.045));
      x.fillStyle = IVORY;
      x.fillText(ev.min, W / 2, H * 0.71 + s * 0.08);
      tracking(x, 0);
    }
    const line = `${m.home.abbr}  ${m.home.score}–${m.away.score}  ${m.away.abbr}`;
    tracking(x, s * 0.01);
    x.font = font('Josefin Light', fitSize(x, line, 'Josefin Light', W * 0.8, s * 0.1));
    x.fillStyle = IVORY;
    x.fillText(line, W / 2, H * 0.88);
    tracking(x, 0);
    return { canvas: c, tint, ready: !!img || !team.logo };
  }

  function goalTakeover(ctx, card, W, H, s, age) {
    const { tint } = card;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.3, r = Math.hypot(W, H);
    // rays turning slowly out of the crest, in the scorer's colour
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(age * 0.25);
    const rays = 24;
    ctx.fillStyle = rgba(tint, 0.22);
    for (let i = 0; i < rays; i += 2) {
      const a0 = (i / rays) * Math.PI * 2, a1 = ((i + 1) / rays) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a0) * r, Math.sin(a0) * r); ctx.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.7);
    g.addColorStop(0, rgba(tint, 0.55));
    g.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // the card eases in with a little overshoot, then everything fades out at the end
    const k = Math.min(1, age / 0.6);
    const sc = 0.7 + 0.3 * (1 - Math.pow(1 - k, 3)) + 0.06 * Math.sin(Math.min(1, age / 0.9) * Math.PI);
    ctx.save();
    ctx.globalAlpha = Math.min(1, age / 0.25) * Math.min(1, (CELEBRATE - age) / 0.8);
    ctx.translate(W / 2, H / 2); ctx.scale(sc, sc); ctx.translate(-W / 2, -H / 2);
    ctx.drawImage(card.canvas, 0, 0);
    ctx.restore();
    // a flash of the colour as the goal goes in
    if (age < 0.5) {
      ctx.fillStyle = rgba(tint, 0.6 * (1 - age / 0.5));
      ctx.fillRect(0, 0, W, H);
    }
    frame(ctx, W, H);
  }

  // How long until a kickoff today: IN 2H 14M, IN 9M, or SOON.
  function countdown(dateStr) {
    const mins = Math.round((new Date(dateStr) - Date.now()) / 60000);
    if (!(mins > 0)) return 'SOON';
    return mins >= 60 ? `IN ${Math.floor(mins / 60)}H ${mins % 60}M` : `IN ${mins}M`;
  }

  function scores(canvas, W, H) {
    const theme = THEMES.scores;
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    let payload = null, failed = false, pages = [], pageIndex = 0, pageStart = 0, built = '';
    let hero = null, heroKey = '';
    // each match's last score, so a goal can be spotted (not on the first load), and the goals waiting to be shown
    const seen = new Map(), goals = [];
    let goal = null, goalAt = 0;
    const onData = (data) => {
      for (const league of data.leagues || []) {
        for (const m of league.matches || []) {
          const id = `${m.date}|${m.home.abbr}|${m.away.abbr}`;
          const now = [Number(m.home.score) || 0, Number(m.away.score) || 0];
          const was = seen.get(id);
          if (was && m.state !== 'pre') {
            if (now[0] > was[0]) goals.push({ m, side: 'home' });
            if (now[1] > was[1]) goals.push({ m, side: 'away' });
          }
          seen.set(id, now);
        }
      }
    };
    const stopFeed = feed('scores', (j) => {
      if (j && j.data) { payload = j.data; onData(j.data); }
      failed = !j || (!j.ok && !j.data);
    });

    const stop = animate((t) => {
      if (!goal && goals.length) { const g = goals.shift(); goal = { ...g, card: drawGoalCard(g.m, g.side, W, H, s) }; goalAt = t; }
      if (goal) {
        if (!goal.card.ready && t - goalAt < 1.5) goal.card = drawGoalCard(goal.m, goal.side, W, H, s);  // the crest may still be loading
        goalTakeover(ctx, goal.card, W, H, s, t - goalAt);
        if (t - goalAt >= CELEBRATE) { goal = null; pageStart = t; }
        return;
      }
      backdrop(ctx, W, H);
      const hh = header(ctx, W, H, theme);
      if (!payload) { message(ctx, W, hh, H, failed ? 'The scores are unavailable just now' : 'Fetching the scores…'); return; }
      const pad = Math.round(s * 0.07);
      const titleH = Math.round(s * 0.1);
      const footH = Math.round(s * 0.07);
      const rowH = Math.max(18, Math.round(s * 0.1));
      const top = hh + titleH;
      const room = H - top - footH;
      const key = JSON.stringify([payload, room]);
      if (key !== built) {
        built = key;
        pages = [];
        for (const league of payload.leagues || []) {
          const list = orderMatches(league.matches || []), mine = [];
          for (let i = 0; i < list.length;) {
            const L = heroLayout(list[i], W, s);
            const n = Math.max(0, Math.floor((room - L.h - s * 0.03) / rowH));
            mine.push({ name: league.name, hero: list[i], L, rows: list.slice(i + 1, i + 1 + n) });
            i += 1 + n;
          }
          mine.forEach((p, i) => { p.part = i + 1; p.of = mine.length; pages.push(p); });
        }
        pageIndex = 0;
        pageStart = t;
        heroKey = '';
      }
      if (!pages.length) { message(ctx, W, hh, H, 'No fixtures this week'); return; }
      if (t - pageStart > 12) { pageIndex = (pageIndex + 1) % pages.length; pageStart = t; }
      const page = pages[pageIndex];
      const since = t - pageStart;
      const fade = Math.min(1, since / 0.8);
      const L = page.L;
      const ready = [page.hero.home.logo, page.hero.away.logo].map((u) => !u || !!crest(u, 8));
      const hk = JSON.stringify([pageIndex, page.hero, ready]);
      if (hk !== heroKey) { heroKey = hk; hero = drawHero(page.hero, W, s, L); }
      // a hero on its own sits in the middle of the page
      const heroTop = page.rows.length ? top + s * 0.02 : top + Math.max(0, (room - L.h) / 2);

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const title = page.of > 1 ? `${page.name.toUpperCase()}  ${page.part}/${page.of}` : page.name.toUpperCase();
      tracking(ctx, s * 0.006);
      ctx.font = font('Poiret One', fitSize(ctx, title, 'Poiret One', W - pad * 2, titleH * 0.6));
      ctx.fillStyle = IVORY;
      ctx.fillText(title, W / 2, hh + titleH * 0.38);
      tracking(ctx, 0);
      ctx.drawImage(hero, 0, Math.round(heroTop));
      // two floodlight beams swinging slowly over the match (brighter while it's live)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const beam = page.hero.state === 'in' ? 0.13 : 0.07;
      for (const [fx, dir] of [[W * 0.04, 1], [W * 0.96, -1]]) {
        const a = Math.PI / 2 - dir * (0.42 + 0.16 * Math.sin(t * 0.35 + (dir > 0 ? 0 : 2)));
        const len = L.h * 1.2, spread = 0.13;
        const g = ctx.createLinearGradient(fx, heroTop, fx + Math.cos(a) * len, heroTop + Math.sin(a) * len);
        g.addColorStop(0, `rgba(255,248,230,${beam})`);
        g.addColorStop(1, 'rgba(255,248,230,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(fx, heroTop);
        ctx.lineTo(fx + Math.cos(a - spread) * len, heroTop + Math.sin(a - spread) * len);
        ctx.lineTo(fx + Math.cos(a + spread) * len, heroTop + Math.sin(a + spread) * len);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      if (page.hero.state === 'in') {
        // LIVE and the minute, pulsing under the score
        const label = `LIVE  ${page.hero.clock || page.hero.detail || ''}`.trim();
        tracking(ctx, s * 0.01);
        ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, s * 0.034));
        ctx.globalAlpha = fade * (0.55 + 0.45 * Math.abs(Math.sin(t * 1.6)));
        ctx.fillStyle = GOLD_LIGHT;
        ctx.fillText(label, W / 2, heroTop + L.cy + s * 0.1);
        tracking(ctx, 0);
        ctx.globalAlpha = fade;
      } else {
        const d = new Date(page.hero.date);
        const st = page.hero.state !== 'pre' ? (page.hero.detail || 'FT').toUpperCase()
          : d.toDateString() === new Date().toDateString() ? countdown(page.hero.date)
            : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
        tracking(ctx, s * 0.01);
        ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, st, 'Josefin Sans', W * 0.22, s * 0.032)));
        ctx.fillStyle = MUTED;
        ctx.fillText(st, W / 2, heroTop + L.cy + s * 0.1);
        tracking(ctx, 0);
      }
      const listTop = heroTop + L.h + s * 0.03;
      page.rows.forEach((m, i) => {
        const a = Math.min(1, Math.max(0, (since - 0.3 - i * 0.08) / 0.6));
        if (a <= 0) return;
        ctx.globalAlpha = a * fade;
        const y = listTop + i * rowH;
        ctx.fillStyle = rgba(GOLD, 0.22);
        ctx.fillRect(pad, Math.round(y), W - pad * 2, hair(s));
        drawRow(ctx, m, pad, W - pad, y, rowH, s, t);
      });
      ctx.globalAlpha = fade;
      if (pages.length > 1) {
        // one dot per page along the bottom, the current one lit
        const d = Math.max(2, Math.round(s * 0.01)), gap = d * 3;
        const n = Math.min(pages.length, 12), x0 = W / 2 - ((n - 1) * gap) / 2;
        for (let i = 0; i < n; i++) {
          ctx.fillStyle = i === pageIndex % n ? GOLD_LIGHT : rgba(GOLD, 0.35);
          ctx.fillRect(Math.round(x0 + i * gap - d / 2), Math.round(H - footH * 0.6 - d / 2), d, d);
        }
      }
      ctx.restore();
    }, 20);
    return { stop() { stop(); stopFeed(); } };
  }

  // ------------------------------------------------------------ news

  // Story photos come through the Pi (/api/image). Null until loaded.
  const photos = new Map();
  function photo(url) {
    if (!url) return null;
    let p = photos.get(url);
    if (!p) {
      if (photos.size > 40) photos.clear();
      p = { img: new Image(), ok: false };
      p.img.onload = () => { p.ok = true; };
      p.img.src = '/api/image?u=' + encodeURIComponent(url);
      photos.set(url, p);
    }
    return p.ok ? p.img : null;
  }

  // The photo scaled once to cover the top of the wall, a little wider than it so it can pan.
  function coverPhoto(img, W, h) {
    const scale = Math.max((W * 1.25) / img.naturalWidth, h / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (!(mins >= 0)) return '';
    if (mins < 5) return 'JUST NOW';
    if (mins < 60) return `${mins}M AGO`;
    if (mins < 24 * 60) return `${Math.round(mins / 60)}H AGO`;
    return new Date(iso).toLocaleDateString([], { weekday: 'short' }).toUpperCase();
  }

  const STORY = 12;  // seconds per story

  function news(canvas, W, H) {
    const theme = THEMES.news;
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    let payload = null, failed = false, items = [], index = 0, shownAt = 0, strip = null, stripKey = '';
    let cover = null, coverKey = '';
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
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (!payload) {
        frame(ctx, W, H);
        const hh = header(ctx, W, H, theme);
        message(ctx, W, hh, H, failed ? 'The news is unavailable just now' : 'Fetching the headlines…');
        return;
      }
      if (items !== payload.items) { items = payload.items; index = 0; shownAt = t; }
      if (t - shownAt > STORY) { index = (index + 1) % items.length; shownAt = t; }
      const story = items[index];
      const since = t - shownAt;
      const alpha = Math.max(0, Math.min(1, since / 1, (STORY - since) / 0.8));
      const pad = Math.round(s * 0.08);
      const tickH = Math.max(12, Math.round(s * 0.1));
      const ty = H - tickH - Math.round(s * 0.035);
      const img = photo(story.image);
      photo((items[(index + 1) % items.length] || {}).image);  // have the next one ready
      const photoH = img ? Math.round(H * 0.5) : 0;

      ctx.save();
      ctx.globalAlpha = alpha;
      if (img) {
        // the photo, panning slowly one way then the other, fading into the black below
        const ck = `${story.image}|${W}|${photoH}`;
        if (ck !== coverKey) { coverKey = ck; cover = coverPhoto(img, W, photoH); }
        const travel = cover.width - W, k = since / STORY;
        const x = -(index % 2 ? 1 - k : k) * travel;
        ctx.drawImage(cover, Math.round(x), Math.round((photoH - cover.height) / 2));
        // dark at the top so the label reads over a bright photo
        const fadeTop = ctx.createLinearGradient(0, 0, 0, s * 0.3);
        fadeTop.addColorStop(0, 'rgba(0,0,0,0.92)');
        fadeTop.addColorStop(0.45, 'rgba(0,0,0,0.6)');
        fadeTop.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = fadeTop;
        ctx.fillRect(0, 0, W, s * 0.3);
        const fadeBottom = ctx.createLinearGradient(0, photoH * 0.55, 0, photoH);
        fadeBottom.addColorStop(0, 'rgba(0,0,0,0)');
        fadeBottom.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = fadeBottom;
        ctx.fillRect(0, photoH * 0.55, W, photoH * 0.45 + 1);
      }
      ctx.restore();

      frame(ctx, W, H);
      const hh = header(ctx, W, H, theme, (payload.section || '').toUpperCase());

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // how long this story has left: a gold line drawing across under the photo
      const lineY = img ? photoH - s * 0.02 : hh + s * 0.02;
      ctx.fillStyle = rgba(GOLD, 0.25);
      ctx.fillRect(pad, Math.round(lineY), W - pad * 2, hair(s));
      ctx.fillStyle = GOLD_LIGHT;
      ctx.fillRect(pad, Math.round(lineY), Math.round((W - pad * 2) * Math.min(1, since / STORY)), hair(s) + 1);

      // the headline, then when and who, then the summary if there's room for it
      const textTop = lineY + s * 0.05;
      const textBottom = ty - s * 0.03;
      const box = fitWrapped(ctx, story.title, 'Cormorant', W - pad * 2, (textBottom - textTop) * (img ? 0.56 : 0.6), img ? 4 : 5, 1.1);
      ctx.font = font('Cormorant', box.size);
      ctx.fillStyle = IVORY;
      const blockH = box.lines.length * box.size * 1.1;
      const y0 = img ? textTop + box.size * 0.55 : textTop + (textBottom - textTop - blockH) / 2 - s * 0.04 + box.size * 0.55;
      box.lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * box.size * 1.1));
      let y = y0 + (box.lines.length - 0.5) * box.size * 1.1 + s * 0.045;
      const meta = [ago(story.time), (payload.source || '').toUpperCase()].filter(Boolean).join('  ·  ');
      tracking(ctx, s * 0.012);
      ctx.font = font('Josefin Sans', small(s));
      ctx.fillStyle = GOLD;
      ctx.fillText(meta, W / 2, y);
      tracking(ctx, 0);
      y += s * 0.05;
      if (story.summary) {
        // as many lines of the summary as fit, a little smaller than the headline
        const sz = Math.max(MIN_TEXT + 2, Math.round(Math.min(box.size * 0.62, s * 0.06)));
        ctx.font = font('Cormorant Italic', sz);
        ctx.fillStyle = MUTED;
        const all = wrap(ctx, story.summary, W - pad * 2);
        const fit = Math.min(3, Math.floor((textBottom - y) / (sz * 1.15)));
        const lines = all.slice(0, fit);
        if (lines.length && all.length > lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/[\s,.;:]*\S*$/, '…');
        lines.forEach((l, i) => ctx.fillText(l, W / 2, y + sz * 0.6 + i * sz * 1.15));
      }
      ctx.restore();

      // a slow ticker of the other headlines, fading out at both edges
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

  // ---- the weather's sky: colours by the sun's height and the cloud, kept muted for the LEDs

  const SKY = {
    night: ['#02040c', '#0a1330'], day: ['#0a2c5c', '#4a7fa8'], glow: ['#1c1238', '#b8583a'],
    grey: ['#1e2329', '#4a5058'], storm: ['#0c0e12', '#262a31'],
  };
  function mixHex(a, b, k) {
    const p = parseInt(a.slice(1), 16), q = parseInt(b.slice(1), 16);
    const ch = (sh) => Math.round(((p >> sh) & 255) * (1 - k) + ((q >> sh) & 255) * k);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }
  const rgbHex = (rgb) => '#' + rgb.match(/\d+/g).map((n) => (+n).toString(16).padStart(2, '0')).join('');
  const mix2 = (a, b, k) => [rgbHex(mixHex(a[0], b[0], k)), rgbHex(mixHex(a[1], b[1], k))];

  // Where the sun is for the town right now: alt runs 0 at sunrise, 1 at midday, 0 at sunset, and
  // below 0 through the night; along is 0..1 across the day.
  function sunNow(p) {
    const mins = (((Date.now() / 60000 + (p.utcOffset || 0) / 60) % 1440) + 1440) % 1440;
    const rise = p.sun && p.sun.rise != null ? p.sun.rise : 360, set = p.sun && p.sun.set != null ? p.sun.set : 1080;
    if (mins >= rise && mins <= set) {
      const along = (mins - rise) / (set - rise);
      return { alt: Math.sin(along * Math.PI), along, mins };
    }
    const night = 1440 - (set - rise), into = ((mins - set + 1440) % 1440) / night;
    return { alt: -Math.sin(into * Math.PI), along: into, mins };
  }

  function skyColours(alt, cloud, kind) {
    const day = Math.max(0, Math.min(1, alt * 2.5));
    let c = mix2(SKY.night, SKY.day, day);
    const low = Math.max(0, 1 - Math.abs(alt) * 4);  // the colour at sunrise and sunset
    c = mix2(c, SKY.glow, low * 0.75);
    const wet = kind === 'rain' || kind === 'drizzle' || kind === 'snow';
    const grey = Math.min(1, (cloud / 100) * 0.8 + (wet ? 0.3 : 0));
    c = mix2(c, kind === 'storm' ? SKY.storm : mix2(SKY.night, SKY.grey, 0.3 + day * 0.7), grey * 0.85);
    return c;
  }

  // A soft cloud, drawn once: overlapping blurred puffs, lit or dark by the time of day.
  const cloudSprites = new Map();
  function cloudSprite(w, shade, seed) {
    const key = `${Math.round(w)}|${shade}|${seed}`;
    if (cloudSprites.has(key)) return cloudSprites.get(key);
    const c = document.createElement('canvas');
    c.width = Math.round(w); c.height = Math.round(w * 0.5);
    const x = c.getContext('2d');
    const rand = rng(seed * 977 + 13);
    x.filter = `blur(${Math.max(1, Math.round(w * 0.04))}px)`;
    x.fillStyle = shade;
    for (let i = 0; i < 6; i++) {
      const px = w * (0.2 + rand() * 0.6), py = w * (0.22 + rand() * 0.1), r = w * (0.1 + rand() * 0.1);
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
    x.beginPath(); x.ellipse(w * 0.5, w * 0.33, w * 0.4, w * 0.08, 0, 0, Math.PI * 2); x.fill();
    if (cloudSprites.size > 30) cloudSprites.clear();
    cloudSprites.set(key, c);
    return c;
  }

  // A glow with a disc in it (the sun or the moon), drawn once per size and colour.
  const orbs = new Map();
  function orb(r, core, halo, crescent) {
    const key = `${r}|${core}|${halo}|${!!crescent}`;
    if (orbs.has(key)) return orbs.get(key);
    const size = Math.ceil(r * 7);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d'), m = size / 2;
    const g = x.createRadialGradient(m, m, r * 0.8, m, m, m);
    g.addColorStop(0, rgba(halo, 0.5));
    g.addColorStop(0.35, rgba(halo, 0.14));
    g.addColorStop(1, rgba(halo, 0));
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    // the disc on its own layer, so the moon's shadow can be cut out of it cleanly
    const d = document.createElement('canvas');
    d.width = d.height = size;
    const y = d.getContext('2d');
    y.fillStyle = core;
    y.beginPath(); y.arc(m, m, r, 0, Math.PI * 2); y.fill();
    if (crescent) {
      y.globalCompositeOperation = 'destination-out';
      y.beginPath(); y.arc(m + r * 0.5, m - r * 0.32, r * 0.9, 0, Math.PI * 2); y.fill();
    }
    x.drawImage(d, 0, 0);
    orbs.set(key, c);
    return c;
  }

  function weather(canvas, W, H) {
    const theme = THEMES.weather;
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    let payload = null, failed = false, sky = null, skyKey = '', flashAt = -99, nextFlash = 4;
    const stopFeed = feed('weather', (j) => { if (j && j.data) payload = j.data; failed = !j || (!j.ok && !j.data); });
    const rand = rng(W * 31 + H);
    const stars = Array.from({ length: 70 }, () => ({ x: rand() * W, y: rand() * H * 0.6, r: rand() < 0.15 ? 2 : 1, ph: rand() * 6 }));
    const drops = Array.from({ length: 90 }, () => ({ x: rand() * W * 1.2, y: rand() * H, v: 0.8 + rand() * 0.5, ph: rand() * 6 }));
    const clouds = Array.from({ length: 8 }, (_, i) => ({ x: rand() * W * 1.4 - W * 0.2, y: H * (0.06 + rand() * 0.42), w: W * (0.45 + rand() * 0.45), v: 3 + rand() * 5, seed: i }));

    const stop = animate((t) => {
      if (!payload || payload.needsPlace) {
        backdrop(ctx, W, H);
        const hh = header(ctx, W, H, theme);
        message(ctx, W, hh, H, !payload ? (failed ? 'The forecast is unavailable just now' : 'Fetching the forecast…') : 'Set your town in Channel settings on your phone');
        return;
      }
      const now = payload.now;
      const [, kind, desc] = wx(now.code);
      const cloud = now.cloud != null ? now.cloud : { clear: 5, partly: 45, cloud: 95, fog: 60 }[kind] ?? 85;
      const sun = sunNow(payload);
      const dayK = Math.max(0, Math.min(1, sun.alt * 2.5));
      const panelTop = Math.round(H * 0.74);
      // the sky's horizon is at roof height, so sunrise, sunset and their glow show above the city
      const horizon = panelTop - H * 0.13;

      // the sky, rebuilt each minute
      const sk = `${Math.round(sun.mins)}|${cloud}|${kind}`;
      if (sk !== skyKey) {
        skyKey = sk;
        const [topC, lowC] = skyColours(sun.alt, cloud, kind);
        sky = document.createElement('canvas');
        sky.width = W; sky.height = H;
        const x = sky.getContext('2d');
        const g = x.createLinearGradient(0, 0, 0, horizon);
        g.addColorStop(0, topC); g.addColorStop(1, lowC);
        x.fillStyle = g; x.fillRect(0, 0, W, H);
      }
      ctx.drawImage(sky, 0, 0);
      const clearness = 1 - Math.min(1, cloud / 100);

      // stars, twinkling, on a clear night
      const starK = (1 - dayK) * clearness;
      if (starK > 0.05) {
        for (const st of stars) {
          ctx.fillStyle = `rgba(236,228,212,${(starK * (0.35 + 0.65 * Math.abs(Math.sin(t * 0.8 + st.ph)))).toFixed(3)})`;
          ctx.fillRect(Math.round(st.x), Math.round(st.y), st.r, st.r);
        }
      }
      // the sun on its arc through the day, or the moon at night
      const veil = 1 - Math.min(0.85, (cloud / 100) * 0.9);
      if (sun.alt > -0.08) {
        const r = Math.round(s * 0.055);
        const o = orb(r, sun.alt < 0.25 ? '#f2b264' : '#f6e7b8', sun.alt < 0.25 ? '#e0703a' : '#f2c76b');
        // its arc tops out just under the header, clear of the temperature
        const sx = W * (0.1 + 0.8 * sun.along), sy = horizon - Math.max(0, sun.alt) * (horizon - s * 0.15 - r * 1.3);
        ctx.globalAlpha = veil;
        ctx.drawImage(o, Math.round(sx - o.width / 2), Math.round(sy - o.height / 2));
        ctx.globalAlpha = 1;
      } else {
        const r = Math.round(s * 0.045);
        const o = orb(r, '#e9e4d4', '#9fb4d8', true);
        const mx = W * (0.15 + 0.7 * sun.along), my = H * 0.17 + Math.sin(sun.along * Math.PI) * -H * 0.04;
        ctx.globalAlpha = veil;
        ctx.drawImage(o, Math.round(mx - o.width / 2), Math.round(my - o.height / 2));
        ctx.globalAlpha = 1;
      }
      // clouds drifting across, as many as the sky has
      const nClouds = Math.round((cloud / 100) * clouds.length + (kind === 'partly' ? 1 : 0));
      const shade = dayK > 0.3 ? (cloud > 70 ? '#8a9099' : '#d8dde4') : '#2a3140';
      for (let i = 0; i < nClouds; i++) {
        const c = clouds[i];
        const spr = cloudSprite(c.w, shade, c.seed);
        const span = W + c.w * 1.2;
        const cx = ((c.x + t * c.v) % span + span) % span - c.w * 0.6;
        ctx.globalAlpha = dayK > 0.3 ? 0.55 : 0.8;
        ctx.drawImage(spr, Math.round(cx), Math.round(c.y));
      }
      ctx.globalAlpha = 1;
      // rain, snow or fog when there is some
      if (kind === 'rain' || kind === 'drizzle' || kind === 'storm') {
        const n = kind === 'drizzle' ? 35 : drops.length, len = s * (kind === 'drizzle' ? 0.03 : 0.06);
        ctx.strokeStyle = 'rgba(190,205,225,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const d = drops[i];
          const y = (d.y + t * H * d.v) % (panelTop + len) - len;
          const x = (d.x - (y / H) * W * 0.12) % (W * 1.2);
          ctx.moveTo(Math.round(x), Math.round(y)); ctx.lineTo(Math.round(x - len * 0.2), Math.round(y + len));
        }
        ctx.stroke();
      } else if (kind === 'snow') {
        ctx.fillStyle = 'rgba(236,240,246,0.8)';
        for (let i = 0; i < 60; i++) {
          const d = drops[i];
          const y = (d.y + t * H * 0.08 * d.v) % panelTop;
          const x = d.x % W + Math.sin(t * 0.8 + d.ph) * s * 0.02;
          ctx.fillRect(Math.round(x), Math.round(y), d.v > 1.1 ? 2 : 1, d.v > 1.1 ? 2 : 1);
        }
      } else if (kind === 'fog') {
        for (let i = 0; i < 5; i++) {
          const y = horizon - (i + 1) * s * 0.09 + Math.sin(t * 0.2 + i) * s * 0.01;
          const g = ctx.createLinearGradient(0, y - s * 0.04, 0, y + s * 0.04);
          g.addColorStop(0, 'rgba(160,165,172,0)'); g.addColorStop(0.5, 'rgba(160,165,172,0.22)'); g.addColorStop(1, 'rgba(160,165,172,0)');
          ctx.fillStyle = g;
          ctx.fillRect(0, y - s * 0.04, W, s * 0.08);
        }
      }
      if (kind === 'storm') {
        // now and then, lightning
        if (t - flashAt > nextFlash) { flashAt = t; nextFlash = 5 + (Math.sin(t * 7.3) + 1) * 4; }
        const since = t - flashAt;
        if (since < 0.25) {
          ctx.fillStyle = `rgba(220,225,255,${(0.35 * (1 - since / 0.25)).toFixed(3)})`;
          ctx.fillRect(0, 0, W, H);
          if (since < 0.12) {
            ctx.strokeStyle = 'rgba(245,245,255,0.9)'; ctx.lineWidth = 2;
            let bx = W * (0.3 + 0.4 * ((flashAt * 13) % 1)), by = H * 0.12;
            ctx.beginPath(); ctx.moveTo(bx, by);
            for (let i = 0; i < 6; i++) { bx += (((flashAt * 31 + i * 7) % 1) - 0.5) * s * 0.12; by += (horizon - H * 0.12) / 6; ctx.lineTo(bx, by); }
            ctx.stroke();
          }
        }
      }
      // the deco city along the horizon, its windows lit after dark
      const town = city(W, H, H * 0.24);
      ctx.drawImage(town.canvas, 0, panelTop - H);
      const lit = 1 - dayK * 0.85;
      for (const w of town.windows) {
        const on = 0.5 + 0.5 * Math.sin(t * 0.05 + w.phase);
        if (on < 0.25) continue;
        ctx.fillStyle = `rgba(242,196,120,${(lit * (w.near ? 0.85 : 0.45) * on).toFixed(3)})`;
        ctx.fillRect(w.x, w.y + panelTop - H, w.w, w.h);
      }
      // the foot of the wall is black, for the forecast
      ctx.fillStyle = '#000';
      ctx.fillRect(0, panelTop, W, H - panelTop);

      frame(ctx, W, H);
      const hh = header(ctx, W, H, theme, (payload.place || '').toUpperCase());

      // now: the temperature large over the sky, the conditions and the rest under it
      const pad = Math.round(s * 0.08);
      const temp = `${Math.round(now.temp)}°`;
      const tempSize = Math.round(s * 0.3);
      const ty = hh + (horizon - hh) * 0.42;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font('Josefin Light', tempSize);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(temp, W / 2 + 2, ty + 2);
      ctx.fillStyle = IVORY;
      ctx.fillText(temp, W / 2, ty);
      ctx.font = font('Cormorant Italic', fitSize(ctx, desc, 'Cormorant Italic', W - pad * 2, s * 0.085));
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(desc, W / 2 + 1, ty + tempSize * 0.62 + 1);
      ctx.fillStyle = GOLD_LIGHT;
      ctx.fillText(desc, W / 2, ty + tempSize * 0.62);
      let extra = `FEELS ${Math.round(now.feels)}°   ·   WIND ${Math.round(now.wind)} MPH`;
      tracking(ctx, s * 0.008);
      if (fitSize(ctx, extra, 'Josefin Sans', W - pad * 2, small(s)) < MIN_TEXT) extra = `FEELS ${Math.round(now.feels)}°`;
      ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, extra, 'Josefin Sans', W - pad * 2, small(s))));
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(extra, W / 2 + 1, ty + tempSize * 0.62 + s * 0.075 + 1);
      ctx.fillStyle = IVORY;
      ctx.fillText(extra, W / 2, ty + tempSize * 0.62 + s * 0.075);
      tracking(ctx, 0);

      // forecast: the next few hours, then the next few days, under the city
      const phaseT = t % 20;
      const showDays = phaseT >= 10 || !payload.hours.length;
      const fade = Math.min(1, (phaseT % 10) / 0.8, (10 - (phaseT % 10)) / 0.8);
      const fy = panelTop + s * 0.01;
      const fh = H - fy - s * 0.05;
      const cols = 3;
      const list = showDays ? payload.days.slice(0, cols) : payload.hours.slice(0, cols);
      const cw = (W - pad * 2) / cols;
      ctx.save();
      ctx.globalAlpha = Math.max(0, fade);
      list.forEach((f, i) => {
        const cx = pad + cw * i + cw / 2;
        if (i > 0) { ctx.fillStyle = rgba(GOLD, 0.2); ctx.fillRect(Math.round(pad + cw * i), fy + fh * 0.12, hair(s), fh * 0.76); }
        const name = showDays ? (i === 0 ? 'TODAY' : new Date(f.date + 'T12:00').toLocaleDateString([], { weekday: 'short' }).toUpperCase()) : f.time;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        tracking(ctx, s * 0.008);
        ctx.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(ctx, name, 'Josefin Sans', cw * 0.85, Math.max(MIN_TEXT, fh * 0.14))));
        ctx.fillStyle = MUTED;
        ctx.fillText(name, cx, fy + fh * 0.18);
        tracking(ctx, 0);
        weatherIcon(ctx, wx(f.code)[1], cx, fy + fh * 0.5, Math.min(cw * 0.5, fh * 0.36), t + i, true);
        const temps = showDays ? `${Math.round(f.max)}°  ${Math.round(f.min)}°` : `${Math.round(f.temp)}°`;
        ctx.font = font('Josefin Light', fitSize(ctx, temps, 'Josefin Light', cw * 0.85, fh * 0.2));
        ctx.fillStyle = IVORY;
        ctx.fillText(temps, cx, fy + fh * 0.83);
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
      // the sign in gold, drawn once on its own transparent layer
      const sign = offscreen(W, H, (ctx) => {
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
      });
      // a band of light that crosses the gold now and then, kept to the sign's own lines
      const sheen = offscreen(W, H, () => {});
      const sx = sheen.getContext('2d');
      const foot = { x: ax, y: ay + ah / 2 };
      return (ctx, t) => {
        backdrop(ctx, W, H);
        // deco rays fanning up from the foot of the arch, turning very slowly
        ctx.save();
        ctx.translate(foot.x, foot.y);
        ctx.rotate(Math.sin(t * 0.05) * 0.08);
        const rays = 18, r = Math.hypot(W, H);
        for (let i = 0; i < rays; i++) {
          const a0 = Math.PI + (i / rays) * Math.PI, a1 = a0 + Math.PI / rays * 0.5;
          const g = ctx.createLinearGradient(0, 0, Math.cos(a0) * r * 0.6, Math.sin(a0) * r * 0.6);
          g.addColorStop(0, rgba(GOLD, 0.16 + 0.06 * Math.sin(t * 0.6 + i)));
          g.addColorStop(1, rgba(GOLD, 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a0) * r, Math.sin(a0) * r); ctx.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        // the arch stays dark inside, so the monogram reads cleanly
        ctx.fillStyle = '#000';
        arch(ctx, 0);
        ctx.fill();
        ctx.drawImage(sign, 0, 0);
        const cycle = 7, k = (t % cycle) / cycle;
        if (k < 0.45) {
          const p = k / 0.45, bx = -W * 0.4 + p * W * 1.8;
          sx.clearRect(0, 0, W, H);
          sx.globalCompositeOperation = 'source-over';
          sx.drawImage(sign, 0, 0);
          sx.globalCompositeOperation = 'source-in';
          const g = sx.createLinearGradient(bx - W * 0.25, 0, bx + W * 0.25, H * 0.35);
          g.addColorStop(0, 'rgba(255,240,200,0)');
          g.addColorStop(0.5, 'rgba(255,240,200,0.9)');
          g.addColorStop(1, 'rgba(255,240,200,0)');
          sx.fillStyle = g;
          sx.fillRect(0, 0, W, H);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(sheen, 0, 0);
          ctx.restore();
        }
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
    // Champagne: the glass lit warm from below, bubbles rising in fine streams from points on the
    // bottom, growing as they climb, and bursting into a sparkle at the surface.
    bubbles(W, H) {
      const s = Math.min(W, H);
      const surface = H * 0.16;
      const glass = offscreen(W, H, (x) => {
        x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
        const g = x.createLinearGradient(0, surface, 0, H);
        g.addColorStop(0, '#0e0a02'); g.addColorStop(0.5, '#1c1404'); g.addColorStop(1, '#33240a');
        x.fillStyle = g; x.fillRect(0, surface, W, H - surface);
        const glow = x.createRadialGradient(W / 2, H * 1.05, 0, W / 2, H * 1.05, H * 0.7);
        glow.addColorStop(0, 'rgba(255,196,100,0.3)'); glow.addColorStop(1, 'rgba(255,196,100,0)');
        x.fillStyle = glow; x.fillRect(0, surface, W, H - surface);
        // the meniscus: a bright line where the wine meets the air
        const m = x.createLinearGradient(0, surface - 2, 0, surface + s * 0.03);
        m.addColorStop(0, 'rgba(255,236,190,0.9)'); m.addColorStop(1, 'rgba(255,236,190,0)');
        x.fillStyle = m; x.fillRect(0, surface - 1, W, s * 0.03);
      });
      const rand = rng(W * 13 + H * 7);
      const sources = Array.from({ length: Math.max(6, Math.round(W / 28)) }, () => ({ x: W * (0.06 + rand() * 0.88), rate: 0.25 + rand() * 0.5, ph: rand() * 10 }));
      const bubbles = [], pops = [];
      // streams already running when the scene starts
      for (const src of sources) {
        for (let y = H - 2; y > surface; y -= H * (0.03 + rand() * 0.05)) {
          const climbed = (H - y) / H;
          bubbles.push({ x: src.x + (rand() - 0.5) * 2, y, v: H * (0.08 + climbed * 0.25), r: 0.6 + rand() * 0.6 + climbed * 1.2, ph: rand() * 6 });
        }
      }
      let last = 0;
      return (ctx, t) => {
        const dt = last ? Math.min(0.1, t - last) : 0;
        last = t;
        for (const src of sources) {
          if (rand() < src.rate * dt * 6) bubbles.push({ x: src.x + (rand() - 0.5) * 2, y: H - 2, v: H * (0.06 + rand() * 0.05), r: 0.6 + rand() * 0.6, ph: rand() * 6 });
        }
        ctx.drawImage(glass, 0, 0);
        for (let i = bubbles.length - 1; i >= 0; i--) {
          const b = bubbles[i];
          b.v += H * 0.05 * dt;  // they speed up as they rise
          b.y -= b.v * dt;
          b.r += 0.25 * dt * s / 100;
          if (b.y <= surface) { pops.push({ x: b.x, y: surface, at: t }); bubbles.splice(i, 1); continue; }
          const x = b.x + Math.sin(t * 2 + b.ph) * 0.8;
          ctx.fillStyle = 'rgba(255,238,200,0.75)';
          ctx.beginPath(); ctx.arc(x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
          if (b.r > 1.3) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(Math.round(x - b.r * 0.4), Math.round(b.y - b.r * 0.4), 1, 1); }
        }
        if (bubbles.length > 600) bubbles.splice(0, bubbles.length - 600);
        for (let i = pops.length - 1; i >= 0; i--) {
          const p = pops[i], age = t - p.at;
          if (age > 0.5) { pops.splice(i, 1); continue; }
          ctx.fillStyle = `rgba(255,246,220,${(1 - age / 0.5).toFixed(3)})`;
          const d = 1 + age * 6;
          ctx.fillRect(Math.round(p.x - d), Math.round(p.y), 1, 1); ctx.fillRect(Math.round(p.x + d), Math.round(p.y), 1, 1);
          ctx.fillRect(Math.round(p.x), Math.round(p.y - d * 0.7), 1, 1);
        }
        frame(ctx, W, H);
      };
    },

    // Deco wallpaper: rows of fine gold fans, drifting very slowly, with a light wandering across
    // them that catches the gold (only the lines light up; the black stays black).
    fans(W, H) {
      const s = Math.min(W, H);
      const r = Math.max(8, Math.round(s / 6));
      const tile = offscreen(r * 2, r, (x) => {
        x.lineWidth = Math.max(1, hair(s));
        for (let k = 4; k >= 1; k--) {
          x.globalCompositeOperation = 'destination-out';
          x.beginPath(); x.arc(r, r, r * (k / 4), Math.PI, 0); x.closePath(); x.fill();
          x.globalCompositeOperation = 'source-over';
          x.strokeStyle = GOLD;
          x.beginPath(); x.arc(r, r, r * (k / 4), Math.PI, 0); x.stroke();
        }
      });
      // just the lines, each row hiding the one behind it
      const lines = offscreen(W + r * 2, H + r, (p) => {
        for (let row = 0, y = 0; y < H + r * 2; row++, y += r * 0.5) {
          for (let xx = row % 2 ? -r : 0; xx < W + r * 2; xx += r * 2) {
            p.globalCompositeOperation = 'destination-out';
            p.beginPath(); p.arc(xx + r, y + r, r, Math.PI, 0); p.closePath(); p.fill();
            p.globalCompositeOperation = 'source-over';
            p.drawImage(tile, xx, y);
          }
        }
      });
      const lit = offscreen(W, H, () => {});
      const lx = lit.getContext('2d');
      return (ctx, t) => {
        const ox = -((t * r * 0.05) % (r * 2));
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 0.4;
        ctx.drawImage(lines, ox, 0);
        ctx.globalAlpha = 1;
        // the light: a soft spot drifting in a slow figure of eight
        const cx = W * (0.5 + 0.38 * Math.sin(t * 0.13)), cy = H * (0.5 + 0.36 * Math.sin(t * 0.26 + 1));
        lx.clearRect(0, 0, W, H);
        lx.globalCompositeOperation = 'source-over';
        lx.drawImage(lines, ox, 0);
        lx.globalCompositeOperation = 'source-in';
        const g = lx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.55);
        g.addColorStop(0, 'rgba(255,232,170,1)');
        g.addColorStop(0.5, 'rgba(230,190,110,0.5)');
        g.addColorStop(1, 'rgba(230,190,110,0)');
        lx.fillStyle = g;
        lx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(lit, 0, 0);
        ctx.restore();
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
      // No secure link yet: only the status. The home Wi-Fi address wouldn't give guests a
      // camera (phones need the secure link for that), so it isn't offered. Set a little lower,
      // so the shorter card sits in the middle of the wall.
      top += Math.round(s * 0.22);
      label('CAMERAS NEED', top + s * 0.06, s * 0.06, IVORY);
      label('THE SECURE LINK', top + s * 0.14, s * 0.06, IVORY);
      decoRule(x, W / 2 - W * 0.12, Math.round(top + s * 0.25), W * 0.24, s);
      label('ASK THE HOST', top + s * 0.35, s * 0.05, GOLD);
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

  // ------------------------------------------------------------ now showing

  // Movie night (channel 8). Before the film, tonight's poster in a gold frame, turning now and
  // then to a type-only card; "Start the feature" gives two minutes, the gold curtains close and
  // the wall goes almost dark for the whole film. An intermission brings it back up a little with
  // a draining ring, and THE END closes the night. The Pi keeps where the night is (opts.cinema,
  // with wall-clock times); the channel follows it and fades between scenes itself. Every card is
  // drawn once into a small canvas, and the wall is only redrawn when something on it changes.
  const NS_POSTER = 20;   // seconds of poster before the type-only card
  const NS_CARD = 8;      // seconds of the type-only card
  const NS_TURN = 1.5;    // the fade between them
  const NS_CLOSE = 3;     // the curtains close over the countdown's last three seconds
  const NS_HOLD = 1.2;    // closed, before the wall fades down
  const NS_DOWN = 4;      // the fade down (done before the Pi moves on to the film, 6 s after 0:00)
  const NS_DARK = 0.04;   // the film: a faint gold hairline at about 4%, like an exit sign
  const NS_BREAK = 0.4;   // the intermission: about 40%
  const NS_FADES = { film: 4, intermission: 2.5, end: 2 }; // into each scene; 1 s otherwise

  function filmMeta(f) {
    const parts = [];
    if (f.year) parts.push(String(f.year));
    if (f.runtime) {
      const h = Math.floor(f.runtime / 60), m = f.runtime % 60;
      parts.push(h ? `${h}H${m ? ` ${m}M` : ''}` : `${m}M`);
    }
    return parts.join('  ·  ');
  }

  const clockStr = (secs) => {
    const n = Math.max(0, Math.ceil(secs));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };

  // Spaced capitals, centred.
  function nsLabel(x, text, cx, y, px, color, maxW) {
    tracking(x, px * 0.2);
    x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, text, 'Josefin Sans', maxW, px)));
    x.fillStyle = color;
    x.fillText(text, cx + px * 0.1, Math.round(y));
    tracking(x, 0);
  }

  // The title in Poiret One capitals, as big as fits in the box, on up to `lines` lines, broken
  // where the lines come out most even (so never a lone word on the last line).
  function nsTitle(x, text, cx, cy, maxW, maxH, lines, color) {
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    tracking(x, 0);
    x.font = font('Poiret One', 100);
    // the size at which a line fills maxW (the letter spacing is 1 px whatever the size)
    const fits = (ws) => { const t = ws.join(' '); return ((maxW - t.length) * 100) / x.measureText(t).width; };
    let box = { size: 4, lines: [words.join(' ')], spread: Infinity };
    const tryLines = (parts) => {
      const each = parts.map(fits);
      const size = Math.floor(Math.min(...each, maxH / (parts.length * 1.08)));
      const spread = Math.max(...each) - Math.min(...each); // how uneven the lines are
      if (size > box.size || (size === box.size && spread < box.spread)) box = { size, lines: parts.map((p) => p.join(' ')), spread };
    };
    tryLines([words]);
    for (let i = 1; i < words.length && lines >= 2; i++) {
      tryLines([words.slice(0, i), words.slice(i)]);
      for (let j = i + 1; j < words.length && lines >= 3; j++) tryLines([words.slice(0, i), words.slice(i, j), words.slice(j)]);
    }
    tracking(x, 1);
    x.font = font('Poiret One', box.size);
    x.fillStyle = color || IVORY;
    const y0 = cy - ((box.lines.length - 1) * box.size * 1.08) / 2;
    box.lines.forEach((l, i) => x.fillText(l, cx, Math.round(y0 + i * box.size * 1.08)));
    tracking(x, 0);
    return box.lines.length * box.size * 1.08;
  }

  // Halves a big picture step by step before the last draw, so it isn't jagged.
  function drawCover(x, img, dx, dy, dw, dh) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    const k = Math.max(dw / iw, dh / ih);
    let src = img, sw = iw, sh = ih;
    while (sw / 2 >= iw * k && sh / 2 >= ih * k) {
      const from = src;
      src = offscreen(sw / 2, sh / 2, (c, w, h) => { c.imageSmoothingQuality = 'high'; c.drawImage(from, 0, 0, w, h); });
      sw = src.width; sh = src.height;
    }
    const cw = (dw / k) * (sw / iw), ch = (dh / k) * (sh / ih);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, (sw - cw) / 2, (sh - ch) * 0.3, cw, ch, dx, dy, dw, dh);
  }

  // The poster fills the wall inside a thin gold frame; the bottom of it (the small print) goes
  // under a black plate with tonight's title.
  function posterCard(W, H, film, img) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      drawCover(x, img, 4, 4, W - 8, H - 8);
      const top = H - Math.round(H * 0.25);
      const g = x.createLinearGradient(0, top - H * 0.16, 0, top);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.6, 'rgba(0,0,0,0.85)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      x.fillStyle = g;
      x.fillRect(0, Math.round(top - H * 0.16), W, Math.ceil(H * 0.16));
      x.fillStyle = '#000';
      x.fillRect(0, top, W, H - top);
      x.fillStyle = GOLD;
      x.fillRect(2, 2, W - 4, 1); x.fillRect(2, H - 3, W - 4, 1); x.fillRect(2, 2, 1, H - 4); x.fillRect(W - 3, 2, 1, H - 4);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      nsLabel(x, 'NOW SHOWING', W / 2, top + s * 0.015, small(s), GOLD, W * 0.7);
      const meta = filmMeta(film);
      nsTitle(x, film.title, W / 2, top + (H - top) * (meta ? 0.46 : 0.55), W * 0.86, (H - top) * 0.5, 2);
      if (meta) nsLabel(x, meta, W / 2, H - s * 0.07, Math.round(s * 0.042), GOLD_LIGHT, W * 0.8);
    });
  }

  // The type-only card: the house presents tonight's film. With no film chosen, it's movie night.
  // A cinema marquee's ring of bulbs along the card's edge: every third one lit warm, the rest
  // glowing faintly, for one step of the chase.
  function marqueeBulbs(W, H, step) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      const inset = Math.max(4, Math.round(s * 0.028)), gap = Math.max(8, Math.round(s * 0.05));
      const r = Math.max(1.5, s * 0.008);
      const pts = [];
      const w = W - inset * 2, h = H - inset * 2;
      const nx = Math.round(w / gap), ny = Math.round(h / gap);
      for (let i = 0; i < nx; i++) pts.push([inset + (i * w) / nx, inset]);
      for (let i = 0; i < ny; i++) pts.push([W - inset, inset + (i * h) / ny]);
      for (let i = 0; i < nx; i++) pts.push([W - inset - (i * w) / nx, H - inset]);
      for (let i = 0; i < ny; i++) pts.push([inset, H - inset - (i * h) / ny]);
      pts.forEach(([px, py], i) => {
        const on = i % 3 === step;
        if (on) {
          const g = x.createRadialGradient(px, py, 0, px, py, r * 3.5);
          g.addColorStop(0, 'rgba(255,214,140,0.55)');
          g.addColorStop(1, 'rgba(255,214,140,0)');
          x.fillStyle = g;
          x.fillRect(px - r * 3.5, py - r * 3.5, r * 7, r * 7);
        }
        x.fillStyle = on ? '#ffe2a8' : '#4a3816';
        x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
      });
    });
  }

  function presentsCard(W, H, film, barName) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      frame(x, W, H);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      nsLabel(x, (barName || 'THE BASEMENT').toUpperCase(), W / 2, H * 0.15, Math.round(s * 0.05), GOLD, W * 0.8);
      nsLabel(x, 'PRESENTS', W / 2, H * 0.2, small(s), MUTED, W * 0.6);
      decoRule(x, W / 2 - W * 0.16, Math.round(H * 0.255), W * 0.32, s);
      nsTitle(x, film ? film.title : 'Movie night', W / 2, H * 0.47, W * 0.84, H * 0.3, 3);
      decoRule(x, W / 2 - W * 0.16, Math.round(H * 0.69), W * 0.32, s);
      if (!film) {
        nsLabel(x, 'TONIGHT', W / 2, H * 0.76, Math.round(s * 0.045), GOLD_LIGHT, W * 0.8);
        return;
      }
      const meta = filmMeta(film);
      if (meta) nsLabel(x, meta, W / 2, H * 0.75, Math.round(s * 0.045), GOLD_LIGHT, W * 0.8);
      if (film.director) {
        nsLabel(x, 'A FILM BY', W / 2, H * 0.81, small(s), MUTED, W * 0.6);
        nsLabel(x, film.director.toUpperCase(), W / 2, H * 0.855, Math.round(s * 0.042), IVORY, W * 0.82);
      }
    });
  }

  // The countdown's card, without the time itself.
  function countdownCard(W, H, film) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      frame(x, W, H);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      nsLabel(x, 'THE FEATURE', W / 2, H * 0.17, Math.round(s * 0.05), GOLD, W * 0.8);
      nsLabel(x, 'BEGINS IN', W / 2, H * 0.22, small(s), MUTED, W * 0.6);
      decoRule(x, W / 2 - W * 0.16, Math.round(H * 0.62), W * 0.32, s);
      nsTitle(x, film.title, W / 2, H * 0.73, W * 0.84, H * 0.13, 2);
      const meta = filmMeta(film);
      if (meta) nsLabel(x, meta, W / 2, H * 0.84, Math.round(s * 0.04), GOLD_LIGHT, W * 0.8);
    });
  }

  // One half of the house curtain: deep folds of gold, a hem, and a bright leading edge.
  function goldCurtain(w, h, side) {
    return offscreen(w, h, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < w; i++) {
        const from = side === 'left' ? w - 1 - i : i; // the folds line up at the middle
        // two rhythms of fold, so the drape is uneven like cloth, a little deeper towards the middle
        const v = 0.5 + 0.5 * Math.cos((from / 15) * Math.PI * 2 + 0.9 * Math.sin(from / 23));
        const depth = 0.75 + 0.25 * Math.min(1, from / (w * 0.6));
        x.fillStyle = rgba(GOLD, (0.1 + 0.7 * Math.pow(v, 1.6)) * depth);
        x.fillRect(i, 0, 1, h);
      }
      x.fillStyle = 'rgba(0,0,0,0.45)';
      x.fillRect(0, h - 14, w, 14);
      x.fillStyle = GOLD_LIGHT;
      x.fillRect(0, h - 15, w, 1);
      const edge = side === 'left' ? w - 1 : 0;
      x.fillRect(edge, 0, 1, h);
    });
  }

  // The pelmet across the top: a band of gold with a scalloped edge.
  function pelmet(W) {
    const sc = 16, band = 20, h = band + sc / 2 + 2;
    return offscreen(W, h, (x) => {
      x.fillStyle = GOLD;
      x.beginPath();
      x.moveTo(0, 0);
      x.lineTo(W, 0);
      x.lineTo(W, band);
      for (let cx = W; cx > 0; cx -= sc) x.arc(cx - sc / 2, band, sc / 2, 0, Math.PI);
      x.closePath();
      x.fill();
      x.fillStyle = '#000';
      x.fillRect(0, 3, W, 1);
      x.fillRect(0, band - 5, W, 1);
      x.fillStyle = 'rgba(0,0,0,0.35)';
      x.fillRect(0, 4, W, band - 9);
    });
  }

  // The film: black, and the wall's edge as a faint gold line.
  function darkCard(W, H) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      const inset = Math.max(2, Math.round(s * 0.025));
      x.fillStyle = rgba(GOLD, NS_DARK);
      x.fillRect(inset, inset, W - inset * 2, 1); x.fillRect(inset, H - inset - 1, W - inset * 2, 1);
      x.fillRect(inset, inset + 1, 1, H - inset * 2 - 2); x.fillRect(W - inset - 1, inset + 1, 1, H - inset * 2 - 2);
    });
  }

  // The intermission's card at full strength, without the ring's gold or the time; it goes on
  // the wall at about 40%.
  function breakCard(W, H, film, ring) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      frame(x, W, H);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      tracking(x, s * 0.012);
      x.font = font('Poiret One', fitSize(x, 'INTERMISSION', 'Poiret One', W * 0.84, s * 0.14));
      x.fillStyle = IVORY;
      x.fillText('INTERMISSION', W / 2 + s * 0.006, Math.round(H * 0.12));
      tracking(x, 0);
      decoRule(x, W / 2 - W * 0.16, Math.round(H * 0.18), W * 0.32, s);
      x.strokeStyle = rgba(GOLD, 0.25);
      x.lineWidth = ring.lw;
      x.beginPath();
      x.arc(ring.cx, ring.cy, ring.r, 0, Math.PI * 2);
      x.stroke();
      nsLabel(x, 'WE RESUME IN', ring.cx, ring.cy - ring.r * 0.46, small(s) + 1, GOLD, ring.r * 1.4);
      nsTitle(x, film.title, W / 2, H * 0.86, W * 0.84, H * 0.1, 2, GOLD_LIGHT);
    });
  }

  // THE END, as a classic title card in a double gold frame.
  function endCard(W, H, film, barName) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      frame(x, W, H);
      const i2 = Math.round(s * 0.05);
      x.strokeStyle = rgba(GOLD, 0.35);
      x.lineWidth = 1;
      x.strokeRect(i2 + 0.5, i2 + 0.5, W - i2 * 2 - 1, H - i2 * 2 - 1);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      tracking(x, s * 0.02);
      x.font = font('Cormorant', fitSize(x, 'THE', 'Cormorant', W * 0.5, s * 0.17));
      x.fillStyle = IVORY;
      x.fillText('THE', W / 2 + s * 0.01, Math.round(H * 0.36));
      x.font = font('Cormorant', fitSize(x, 'END', 'Cormorant', W * 0.66, s * 0.34));
      x.fillText('END', W / 2 + s * 0.01, Math.round(H * 0.5));
      tracking(x, 0);
      decoRule(x, W / 2 - W * 0.18, Math.round(H * 0.62), W * 0.36, s);
      if (film) nsLabel(x, film.title.toUpperCase(), W / 2, H * 0.69, Math.round(s * 0.04), MUTED, W * 0.76);
      nsLabel(x, (barName || 'THE BASEMENT').toUpperCase(), W / 2, H * 0.86, small(s), GOLD, W * 0.7);
    });
  }

  function nowshowing(canvas, W, H, opts) {
    const ctx = canvas.getContext('2d');
    const s = Math.min(W, H);
    const read = opts.cinema || (() => null);
    const ring = { cx: W / 2, cy: Math.round(H * 0.5), r: Math.round(W * 0.37), lw: Math.max(4, Math.round(s * 0.03)) };
    const cards = new Map();
    let filmKey = null, poster = null, posterOk = false;
    let scene = null, stamp = '', fade = null, prevBuf = null, nextBuf = null, closedDark = false;
    const card = (name, make) => cached(cards, name, make);

    function setFilm(film) {
      const key = film ? `${film.key}|${film.poster}|${film.title}` : '';
      if (key === filmKey) return;
      filmKey = key;
      cards.clear();
      poster = null;
      posterOk = false;
      if (film && film.poster) {
        const img = new Image();
        img.onload = () => { if (poster === img) { posterOk = true; stamp = ''; } };
        img.src = film.poster;
        poster = img;
      }
    }

    function sceneOf(c) {
      if (!c || !c.film) return 'idle';
      return ['countdown', 'film', 'intermission', 'end'].includes(c.phase) ? c.phase : 'poster';
    }

    // Draws one scene into `x`; returns a key that changes whenever the picture would.
    function render(x, name, c, T, dry) {
      const f = c && c.film;
      if (name === 'idle') {
        // the marquee's bulbs chase round the card, three steps a cycle
        const step = Math.floor(T * 6) % 3;
        if (!dry) {
          x.drawImage(card('idle', () => presentsCard(W, H, null, opts.barName)), 0, 0);
          x.drawImage(card(`bulbs${step}`, () => marqueeBulbs(W, H, step)), 0, 0);
        }
        return `idle${step}`;
      }
      if (name === 'film') {
        if (!dry) x.drawImage(card('dark', () => darkCard(W, H)), 0, 0);
        return 'dark';
      }
      if (name === 'end') {
        if (!dry) x.drawImage(card('end', () => endCard(W, H, f, opts.barName)), 0, 0);
        return 'end';
      }
      if (name === 'poster') {
        const type = card('presents', () => presentsCard(W, H, f, opts.barName));
        if (!posterOk) {
          const step = Math.floor(T * 6) % 3;
          if (!dry) { x.drawImage(type, 0, 0); x.drawImage(card(`bulbs${step}`, () => marqueeBulbs(W, H, step)), 0, 0); }
          return `type${step}`;
        }
        const pic = card('poster', () => posterCard(W, H, f, poster));
        const cycle = NS_POSTER + NS_CARD + NS_TURN * 2;
        const u = (((T - c.at) % cycle) + cycle) % cycle;
        let k = 0, key = 'p';
        if (u >= NS_POSTER + NS_TURN && u < NS_POSTER + NS_TURN + NS_CARD) { k = 1; key = 't'; }
        else if (u >= NS_POSTER && u < NS_POSTER + NS_TURN) { k = ease((u - NS_POSTER) / NS_TURN); key = `f${k}`; }
        else if (u >= NS_POSTER + NS_TURN + NS_CARD) { k = 1 - ease((u - NS_POSTER - NS_TURN - NS_CARD) / NS_TURN); key = `f${k}`; }
        if (dry) return key;
        if (k < 1) x.drawImage(pic, 0, 0);
        if (k > 0) { x.globalAlpha = k; x.drawImage(type, 0, 0); x.globalAlpha = 1; }
        return key;
      }
      if (name === 'countdown') {
        const rem = c.until - T;
        const after = -rem;
        const down = ease((after - NS_HOLD) / NS_DOWN);
        const shut = rem > NS_CLOSE ? 0 : ease(1 - rem / NS_CLOSE);
        const key = down >= 1 ? 'dark' : shut > 0 ? `c${shut}|${down}` : `d${Math.ceil(rem)}`;
        if (dry) return key;
        if (down >= 1) { x.drawImage(card('dark', () => darkCard(W, H)), 0, 0); return key; }
        if (down > 0) { x.drawImage(card('dark', () => darkCard(W, H)), 0, 0); x.globalAlpha = 1 - down; }
        if (shut < 1) { // (once they're shut, the curtains cover all of it)
          x.drawImage(card('countdown', () => countdownCard(W, H, f)), 0, 0);
          x.textAlign = 'center';
          x.textBaseline = 'middle';
          tracking(x, 2);
          x.font = font('Poiret One', card('digits', () => fitSize(x, '0:00', 'Poiret One', W * 0.8, s * 0.42)));
          x.fillStyle = IVORY;
          x.fillText(clockStr(Math.max(0, rem)), W / 2 + 1, Math.round(H * 0.425));
          tracking(x, 0);
        }
        if (shut > 0) {
          const halves = card('curtains', () => [goldCurtain(Math.ceil(W / 2), H, 'left'), goldCurtain(Math.ceil(W / 2), H, 'right')]);
          const hw = halves[0].width, off = Math.round(hw * shut);
          x.drawImage(halves[0], off - hw, 0);
          x.drawImage(halves[1], W - off, 0);
          const p = card('pelmet', () => pelmet(W));
          x.drawImage(p, 0, Math.round(-p.height * (1 - shut)));
        }
        x.globalAlpha = 1;
        return key;
      }
      // the intermission
      const total = Math.max(1, (c.mins || 1) * 60);
      const rem = Math.max(0, c.until - T);
      const key = `i${Math.ceil(rem)}`;
      if (dry) return key;
      x.drawImage(card('break', () => breakCard(W, H, f, ring)), 0, 0);
      x.strokeStyle = GOLD;
      x.lineWidth = ring.lw;
      x.lineCap = 'butt';
      x.beginPath();
      x.arc(ring.cx, ring.cy, ring.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.ceil(rem) / total));
      x.stroke();
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      tracking(x, 1);
      x.font = font('Poiret One', card('bdigits', () => fitSize(x, '00:00', 'Poiret One', ring.r * 1.6, ring.r * 0.8)));
      x.fillStyle = IVORY;
      x.fillText(clockStr(rem), ring.cx + 0.5, Math.round(ring.cy + ring.r * 0.14));
      tracking(x, 0);
      x.fillStyle = rgba('#000000', 1 - NS_BREAK);
      x.fillRect(0, 0, W, H);
      return key;
    }

    const buf = () => offscreen(W, H, () => {});
    const stop = animate((t) => {
      const c = read();
      const T = Date.now() / 1000 + ((c && c.clock) || 0);
      setFilm(c && c.film);
      const name = sceneOf(c);
      if (name !== scene) {
        // a straight cut when nothing would show (the countdown has already gone dark)
        const len = scene === null || (scene === 'countdown' && name === 'film' && closedDark) ? 0 : NS_FADES[name] || 1;
        if (len) {
          if (!prevBuf) { prevBuf = buf(); nextBuf = buf(); }
          const p = prevBuf.getContext('2d');
          p.globalAlpha = 1;
          p.drawImage(canvas, 0, 0);
          fade = { at: t, len };
        } else fade = null;
        scene = name;
        stamp = '';
      }
      if (fade) {
        const u = ease((t - fade.at) / fade.len);
        const n = nextBuf.getContext('2d');
        render(n, name, c, T);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1 - u;
        ctx.drawImage(prevBuf, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = u;
        ctx.drawImage(nextBuf, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        if (u >= 1) { fade = null; stamp = ''; }
        canvas.dataset.scene = `${name}+fade`;
        return;
      }
      const key = render(ctx, name, c, T, true);
      if (key === stamp) return;
      stamp = key;
      closedDark = name === 'countdown' && key === 'dark';
      render(ctx, name, c, T);
      canvas.dataset.scene = name; // for checking the channel
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
          x.lineWidth = 2; // no hairlines: they shimmer on the LEDs
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
      if (r >= 8) { // the segments, only where the wheel is big enough for 2 px spokes
        x.strokeStyle = mix(color, '#ffffff', 0.7);
        x.lineWidth = 2;
        x.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          x.moveTo(rx, ry); x.lineTo(rx + Math.cos(a) * r * 0.7, ry + Math.sin(a) * r * 0.7);
        }
        x.stroke();
      }
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
  // Where each of a menu page's three drinks sits: its row, and its glass.
  function pourLayout(W, H) {
    const top = Math.round(H * 0.18), bottom = Math.round(H * 0.91);
    const rowH = (bottom - top) / 3;
    const iconW = Math.round(W * 0.2), iconH = Math.round(rowH * 0.78);
    return { top, rowH, iconW, iconH, iconX: Math.round(W * 0.07), iconY: (i) => Math.round(top + i * rowH + rowH / 2 - iconH / 2) };
  }

  function pourPage(W, H, drinks, icons) {
    const s = Math.min(W, H);
    return offscreen(W, H, (x) => {
      const { top, rowH, iconW, iconH } = pourLayout(W, H);
      const textX = Math.round(W * 0.31), textW = Math.round(W * 0.93) - textX;
      x.textAlign = 'left';
      x.textBaseline = 'middle';
      drinks.forEach((d, i) => {
        const y = top + i * rowH, cy = y + rowH / 2;
        if (i > 0) {
          x.fillStyle = rgba(GOLD, 0.6); // 1 px, bright enough to hold on the LEDs
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
        // the name, with what's in it underneath in small gold capitals
        const blurb = d.blurb || '';
        const bs = blurb ? Math.max(MIN_TEXT, Math.round(s * 0.034)) : 0;
        const shift = blurb ? bs * 0.75 : 0;
        x.font = font('Josefin Sans', size);
        x.fillStyle = IVORY;
        lines.forEach((l, k) => x.fillText(l, textX, Math.round(cy - shift + (k - (lines.length - 1) / 2) * size * 1.12 + size * 0.06)));
        if (blurb) {
          tracking(x, s * 0.01);
          x.font = font('Josefin Sans', Math.max(MIN_TEXT, fitSize(x, blurb, 'Josefin Sans', textW, bs)));
          x.fillStyle = GOLD;
          x.fillText(blurb, textX, Math.round(cy - shift + ((lines.length - 1) / 2) * size * 1.12 + size * 0.62 + bs * 0.9));
        }
        tracking(x, 0);
      });
    });
  }

  // The menu's glasses come alive: bubbles rising in anything sparkling, and every few seconds a
  // light crossing one glass after another. Drawn only where the glass is (the black stays black).
  function pourLife(ctx, W, H, drinks, icons, t, scratch) {
    const L = pourLayout(W, H);
    const sx = scratch.getContext('2d');
    drinks.forEach((d, i) => {
      const icon = icons(d, L.iconW, L.iconH);
      const x0 = L.iconX, y0 = L.iconY(i);
      const fill = icon.yTop + (icon.yBottom - icon.yTop) * 0.3;  // the menu shows glasses 70% full
      if (d.bubbles) {
        sx.clearRect(0, 0, scratch.width, scratch.height);
        sx.globalCompositeOperation = 'source-over';
        sx.drawImage(icon.liquid, 0, 0);
        sx.clearRect(0, 0, L.iconW, Math.ceil(fill));
        sx.globalCompositeOperation = 'source-atop';
        sx.fillStyle = 'rgba(255,246,220,0.85)';
        for (let b = 0; b < 7; b++) {
          const span = icon.yBottom - fill;
          const y = icon.yBottom - (((t * 0.35 + b * 0.37 + i * 0.21) % 1) * span);
          const bx = L.iconW * (0.3 + ((b * 0.29 + i * 0.13) % 0.4)) + Math.sin(t * 2 + b) * 0.7;
          sx.fillRect(Math.round(bx), Math.round(y), 1, 1);
        }
        ctx.drawImage(scratch, 0, 0, L.iconW, L.iconH, x0, y0, L.iconW, L.iconH);
      }
      // the light: a band crossing each glass in turn, one every two seconds or so
      const k = ((t * 0.5 - i * 0.66) % 2 + 2) % 2;
      if (k < 0.6) {
        const bx = -L.iconW * 0.5 + (k / 0.6) * L.iconW * 2;
        sx.clearRect(0, 0, scratch.width, scratch.height);
        sx.globalCompositeOperation = 'source-over';
        sx.drawImage(icon.outline, 0, 0);
        sx.globalCompositeOperation = 'source-in';
        const g = sx.createLinearGradient(bx - L.iconW * 0.25, 0, bx + L.iconW * 0.25, L.iconH * 0.4);
        g.addColorStop(0, 'rgba(255,240,200,0)'); g.addColorStop(0.5, 'rgba(255,240,200,0.9)'); g.addColorStop(1, 'rgba(255,240,200,0)');
        sx.fillStyle = g;
        sx.fillRect(0, 0, L.iconW, L.iconH);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(scratch, 0, 0, L.iconW, L.iconH, x0, y0, L.iconW, L.iconH);
        ctx.restore();
      }
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
      let card = null, fontsIn = false;
      const scratch = offscreen(Math.round(W * 0.2), Math.round(H), () => {});
      const stop = animate((t) => {
        if (t0 === null) t0 = t;
        const age = t - t0;
        if (!card || (!fontsIn && pourFonts())) { fontsIn = pourFonts(); card = menuCard(); pageAt.clear(); }
        const i = pages.length ? Math.floor(age / POUR_PAGE) % pages.length : -1;
        const into = age % POUR_PAGE;
        const fade = pages.length > 1 ? Math.min(1, into / 0.9, (POUR_PAGE - into) / 0.6) : Math.min(1, age / 0.6);
        ctx.drawImage(card, 0, 0);
        if (i < 0) return;
        ctx.globalAlpha = Math.max(0, fade);
        ctx.drawImage(pageImg(i), 0, 0);
        pourLife(ctx, W, H, pages[i], iconFor, t, scratch);
        ctx.globalAlpha = 1;
        if (dots) {
          ctx.drawImage(dots, 0, Math.round(H * 0.935));
          const gap = Math.round(s * 0.04), x0 = Math.round(W / 2 - ((pages.length - 1) * gap) / 2);
          ctx.fillStyle = GOLD_LIGHT;
          ctx.fillRect(x0 + i * gap - 2, Math.round(H * 0.935) + 4, 5, 5);
        }
      }, 20);
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

  const FACTORIES = { scores, news, weather, visuals, live, nowshowing, pour };

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
    kit: { font, fitSize, fitWrapped, glow, rgba, roundRect, tracking, gold, decoRule, header, backdrop, frame, sunburst, timeStr, drawQR, THEMES, GOLD, GOLD_LIGHT, IVORY, MUTED },
  };
})();
