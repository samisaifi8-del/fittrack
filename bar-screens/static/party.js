// Party games on the wall: the drawing half of the game kit (the Pi referees them, see
// partygames.py). The Pi sends the wall one view of the game whenever it changes, over the game
// bus as { type: 'party', game, phase, at, until, now, players, ...data }; this file only draws
// it. Times in a view are the Pi's clock, so every wall and preview animates in step.
//
// A game registers a renderer:  BarParty.register('closest', { draw(g, st, e) { ... } })
// draw() is called about 30 times a second with the kit (g), the latest view (st) and the
// seconds since its phase began (e). It returns false for phases it leaves to the kit, which
// draws them from the view's data (set by self.go(...) on the Pi):
//   'lobby'   the title card with how to join and who's in   { lines: [...], note? }
//   'card'    between rounds                                  { round, heading, lines, night: [top 3] }
//   'podium'  the top three of the round                      { label, places: [{place, name, color, points}] }
// Every view also has players: [{ slot, name, initial, color, points, drop }], where drop is
// when a sip shows by that name (draw it with kit.drop; never anything else about drinking).
//
// The wall is 256 x 384 LEDs seen across a room, and the Pi 4 draws it, so: big type, nothing
// thinner than 1 LED, and anything that doesn't move is drawn once into a cached canvas
// (g.layer) and stamped on; a frame is mostly drawImage, a few rects and a little text.
(() => {
  'use strict';

  const kit = () => window.BarChannels.kit;
  const RENDERERS = {};
  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  const easeOut = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - (1 - u) * (1 - u));

  function offscreen(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    draw(c.getContext('2d'), c.width, c.height);
    return c;
  }

  const fmt = (v, year) => (year ? String(Math.round(v)) : Math.round(v).toLocaleString('en-GB'));

  // ------------------------------------------------------------ the kit

  function setup(canvas, W, H, opts) {
    const k = kit();
    const g = {
      k, W, H, s: Math.min(W, H), ctx: canvas.getContext('2d'), st: null, roster: { players: [], joinUrl: '' },
      offset: 0, layers: new Map(), sprites: new Map(),
    };
    g.off = opts.bus.on((m) => {
      if (m.type === 'roster') g.roster = m;
      else if (m.type === 'party') { g.st = m; g.offset = m.now - Date.now() / 1000; }
    });
    g.now = () => Date.now() / 1000 + g.offset;
    // A whole-wall picture drawn once and kept, by key (a phase, a question...).
    g.layer = (key, draw) => {
      if (!g.layers.has(key)) {
        if (g.layers.size > 24) g.layers.clear();
        g.layers.set(key, offscreen(W, H, (x) => draw(x, W, H)));
      }
      return g.layers.get(key);
    };
    g.sprite = (key, w, h, draw) => {
      if (!g.sprites.has(key)) {
        if (g.sprites.size > 64) g.sprites.clear();
        g.sprites.set(key, offscreen(w, h, draw));
      }
      return g.sprites.get(key);
    };
    // cached pictures are drawn again once the web fonts have arrived
    g.refresh = () => { g.layers.clear(); g.sprites.clear(); };
    if (document.fonts) document.fonts.addEventListener('loadingdone', g.refresh);
    g.player = (slot) => (g.st && g.st.players || []).find((p) => p.slot === slot);
    g.dropOn = (slot) => { const p = g.player(slot); return !!(p && p.drop != null && g.now() >= p.drop); };
    return g;
  }

  // The black wall with its gold hairline frame and the small header, e.g. CLOSEST WINS · 3 / 6.
  function base(g, x, label) {
    const { k, W, H } = g;
    k.backdrop(x, W, H);
    const theme = { name: (g.st && g.st.title || 'GAMES').toUpperCase() };
    return k.header(x, W, H, theme, label);
  }

  // Centred lines of text from the top down. Each line: [text, font, size, colour, tracking].
  function stack(g, x, y, lines, maxW) {
    const { k } = g;
    x.textAlign = 'center';
    x.textBaseline = 'top';
    for (const [text, fontName, size, color, track] of lines) {
      if (!text) { y += size; continue; }
      k.tracking(x, track || 0);
      const px = Math.min(size, k.fitSize(x, text, fontName, maxW || g.W * 0.84, size));
      x.font = k.font(fontName, px);
      x.fillStyle = color;
      x.fillText(text, g.W / 2, y);
      y += px * 1.3;
    }
    k.tracking(x, 0);
    return y;
  }

  // A big title, wrapped to two lines at most, centred at y. Returns the y below it.
  function title(g, x, text, y, maxH, fontName, color) {
    const { k, W, s } = g;
    const f = fontName || 'Poiret One';
    k.tracking(x, s * 0.01);
    const b = k.fitWrapped(x, text, f, W * 0.84, maxH, 2, 1.08);
    x.font = k.font(f, b.size);
    x.fillStyle = color || k.IVORY;
    x.textAlign = 'center';
    x.textBaseline = 'top';
    b.lines.forEach((l, i) => x.fillText(l, W / 2, y + i * b.size * 1.08));
    k.tracking(x, 0);
    return y + b.lines.length * b.size * 1.08;
  }

  // A sip, as the wall shows it: a small gold drop. Nothing else on the wall says who drinks.
  function drop(g, ctx, cx, cy, r) {
    const c = g.sprite(`drop|${r}`, r * 2 + 2, r * 3 + 2, (x) => {
      const m = r + 1;
      x.fillStyle = g.k.GOLD_LIGHT;
      x.beginPath();
      x.moveTo(m, 1);
      x.bezierCurveTo(m + r * 0.35, r * 1.1, m + r, r * 1.5, m + r, r * 2);
      x.arc(m, r * 2, r, 0, Math.PI);
      x.bezierCurveTo(m - r, r * 1.5, m - r * 0.35, r * 1.1, m, 1);
      x.fill();
    });
    ctx.drawImage(c, Math.round(cx - c.width / 2), Math.round(cy - c.height / 2));
  }

  // A player's dot: their colour, with their initial in black (or an empty ring while waiting).
  function dot(g, ctx, p, cx, cy, r, filled) {
    const key = `dot|${p.color}|${p.initial || ''}|${r}|${filled ? 1 : 0}`;
    const c = g.sprite(key, r * 2 + 2, r * 2 + 2, (x) => {
      const m = r + 1;
      x.beginPath();
      x.arc(m, m, filled ? r : r - 1, 0, Math.PI * 2);
      if (filled) { x.fillStyle = p.color; x.fill(); } else { x.strokeStyle = p.color; x.lineWidth = 2; x.globalAlpha = 0.55; x.stroke(); }
      x.globalAlpha = 1;
      const ini = (p.initial || '?').slice(0, 2);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.font = g.k.font('Josefin Sans', g.k.fitSize(x, ini, 'Josefin Sans', r * 1.5, r * (ini.length > 1 ? 0.95 : 1.15)));
      x.fillStyle = filled ? '#000' : g.k.rgba(p.color, 0.8);
      x.fillText(ini, m, m + r * 0.1);
    });
    ctx.drawImage(c, Math.round(cx - r - 1), Math.round(cy - r - 1));
  }

  // A thin gold bar along the bottom that drains as the phase's time runs out.
  function countdown(g, st, y) {
    if (st.until == null) return;
    const { ctx, W } = g;
    const left = Math.max(0, Math.min(1, (st.until - g.now()) / Math.max(0.1, st.until - st.at)));
    const w = Math.round((W - 24) * left);
    ctx.fillStyle = g.k.rgba(g.k.GOLD, 0.25);
    ctx.fillRect(12, y, W - 24, 2);
    ctx.fillStyle = left < 0.25 ? g.k.GOLD_LIGHT : g.k.GOLD;
    ctx.fillRect(12 + Math.round((W - 24 - w) / 2), y, w, 2);
  }

  // One dot per player along the bottom: an empty ring until they lock in, then filled.
  // No numbers, so nobody can copy anyone.
  function lockDots(g, locks, y) {
    const { W, s } = g;
    const list = locks || [];
    if (!list.length) return;
    const r = Math.round(s * 0.042);
    const gap = Math.min(r * 2 + 8, (W - 24) / list.length);
    const x0 = W / 2 - (gap * (list.length - 1)) / 2;
    list.forEach((l, i) => {
      const p = g.player(l.slot);
      if (!p) return;
      dot(g, g.ctx, p, x0 + i * gap, y, r, l.locked);
      if (g.dropOn(l.slot)) drop(g, g.ctx, x0 + i * gap + r * 0.9, y - r * 0.9, Math.max(3, Math.round(r * 0.4)));
    });
  }

  // The lobby: the game's name, how it works, how to join and who's in.
  function lobby(g, st) {
    const { ctx, k, W, H, s } = g;
    const names = (g.roster.players || []).map((p) => p.name).join('  ·  ');
    const key = `lobby|${st.game}|${(st.lines || []).join('|')}|${g.roster.joinUrl}|${names}|${st.note || ''}`;
    ctx.drawImage(g.layer(key, (x) => {
      const hh = base(g, x);
      let y = title(g, x, st.title.toUpperCase(), hh + H * 0.05, H * 0.27, 'Poiret One');
      y += s * 0.04;
      k.decoRule(x, W * 0.22, y, W * 0.56, s);
      y += s * 0.08;
      y = stack(g, x, y, (st.lines || []).map((l) => [l, 'Josefin Sans', Math.round(s * 0.058), k.IVORY, s * 0.008]));
      y = Math.max(y + s * 0.05, H * 0.66);
      y = stack(g, x, y, [
        ['JOIN ON YOUR PHONE', 'Josefin Sans', Math.round(s * 0.047), k.MUTED, s * 0.01],
        [(g.roster.joinUrl || 'THE BAR WI-FI, /PLAY').toUpperCase(), 'Josefin Sans', Math.round(s * 0.058), k.GOLD, s * 0.004],
      ]);
      y += s * 0.03;
      if (st.note) stack(g, x, y, [[st.note.toUpperCase(), 'Josefin Sans', Math.round(s * 0.047), k.GOLD_LIGHT]]);
      else if (names) {
        const b = k.fitWrapped(x, names, 'Josefin Sans', W * 0.84, H - y - s * 0.07, 3, 1.25);
        const px = Math.min(b.size, Math.round(s * 0.055));
        x.font = k.font('Josefin Sans', px);
        x.fillStyle = k.IVORY;
        b.lines.forEach((l, i) => x.fillText(l, W / 2, y + i * px * 1.25));
      } else stack(g, x, y, [['NOBODY HAS JOINED YET', 'Josefin Sans', Math.round(s * 0.047), k.MUTED]]);
    }), 0, 0);
  }

  // Between rounds: the round number, what kind of round it is, and who leads the night.
  function between(g, st) {
    const { ctx, k, W, H, s } = g;
    const night = st.night || [];
    const key = `card|${st.at}`;
    ctx.drawImage(g.layer(key, (x) => {
      const hh = base(g, x);
      let y = hh + H * (night.length ? 0.06 : 0.14);
      y = stack(g, x, y, [[`ROUND ${st.round}`, 'Josefin Sans', Math.round(s * 0.06), k.GOLD, s * 0.02]]);
      y += s * 0.02;
      y = title(g, x, st.heading || '', y, H * 0.26, 'Poiret One');
      y += s * 0.05;
      k.decoRule(x, W * 0.22, y, W * 0.56, s);
      y += s * 0.08;
      y = stack(g, x, y, (st.lines || []).map((l) => [l, 'Josefin Sans', Math.round(s * 0.055), k.IVORY, s * 0.008]));
      if (night.length) {
        y = Math.max(y + s * 0.06, H * 0.68);
        y = stack(g, x, y, [['TONIGHT', 'Josefin Sans', Math.round(s * 0.047), k.MUTED, s * 0.03]]);
        const rowH = Math.round(s * 0.075);
        night.forEach((p, i) => {
          const cy = y + i * rowH + rowH / 2;
          x.textBaseline = 'middle';
          x.font = k.font('Josefin Sans', Math.round(s * 0.06));
          x.fillStyle = i ? k.IVORY : k.GOLD_LIGHT;
          x.textAlign = 'left';
          x.fillText(p.name, W * 0.2, cy);
          x.textAlign = 'right';
          x.fillText(String(p.points), W * 0.8, cy);
        });
      }
    }), 0, 0);
    countdown(g, st, H - Math.round(s * 0.05));
  }

  // The end of a round: the winner's name, then three names on a deco podium.
  function podium(g, st) {
    const { ctx, k, W, H, s } = g;
    const places = st.places || [];
    const key = `podium|${st.at}|${places.map((p) => p.name).join('|')}`;
    ctx.drawImage(g.layer(key, (x) => {
      const hh = base(g, x, st.label || '');
      const firsts = places.filter((p) => p.place === 1).map((p) => p.name);
      const who = firsts.length > 2 ? `${firsts.length}-WAY TIE` : firsts.join(' & ');
      let y = hh + H * 0.04;
      y = title(g, x, who || 'NOBODY SCORED', y, H * 0.17, 'Poiret One');
      y = stack(g, x, y + s * 0.02, [[firsts.length > 1 ? 'SHARE THE ROUND' : 'TAKES THE ROUND', 'Josefin Sans', Math.round(s * 0.05), k.GOLD, s * 0.02]]);
      const floor = Math.round(H * 0.86);
      const bw = Math.round(W * 0.27), gap = Math.round(W * 0.025);
      const heights = { 1: H * 0.24, 2: H * 0.17, 3: H * 0.11 };
      // 2nd on the left, 1st in the middle, 3rd on the right; equal points stand equal
      const order = [places.find((p, i) => i === 1), places[0], places.find((p, i) => i === 2)];
      order.forEach((p, i) => {
        if (!p) return;
        const bx = Math.round(W / 2 - bw * 1.5 - gap + i * (bw + gap));
        const bh = Math.round(heights[p.place] || heights[3]);
        const top = floor - bh;
        x.fillStyle = k.rgba(k.GOLD, p.place === 1 ? 0.32 : 0.18);
        x.fillRect(bx, top, bw, bh);
        x.fillStyle = k.GOLD;
        x.fillRect(bx, top, bw, 2);
        x.fillRect(bx + Math.round(bw * 0.2), top - 3, Math.round(bw * 0.6), 2); // a stepped deco top
        x.textAlign = 'center';
        x.textBaseline = 'top';
        x.font = k.font('Josefin Sans', Math.round(Math.min(bh * 0.42, s * 0.12)));
        x.fillStyle = k.IVORY;
        x.fillText(String(p.place), bx + bw / 2, top + bh * 0.14);
        x.font = k.font('Josefin Sans', Math.round(s * 0.045));
        x.fillStyle = k.GOLD_LIGHT;
        x.fillText(`${p.points} PTS`, bx + bw / 2, top + bh * 0.14 + Math.min(bh * 0.42, s * 0.12) * 1.1);
        x.textBaseline = 'bottom';
        const nameW = bw + gap;
        x.font = k.font('Josefin Sans', Math.min(Math.round(s * 0.065), k.fitSize(x, p.name, 'Josefin Sans', nameW, s * 0.065)));
        x.fillStyle = p.color || k.IVORY;
        x.fillText(p.name, bx + bw / 2, top - 7);
      });
      x.fillStyle = k.GOLD;
      x.fillRect(Math.round(W * 0.06), floor, Math.round(W * 0.88), 2);
      x.textBaseline = 'top';
      stack(g, x, floor + s * 0.03, [['NEXT ROUND ON YOUR PHONE', 'Josefin Sans', Math.round(s * 0.042), k.MUTED, s * 0.01]]);
    }), 0, 0);
  }

  const SHARED = { lobby, card: between, podium };

  // ------------------------------------------------------------ the factory

  function create(name, canvas, W, H, opts) {
    const g = setup(canvas, W, H, opts);
    const renderer = RENDERERS[name] || {};
    let raf = 0, last = 0, stopped = false;
    const frame = (ms) => {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      if (ms - last < 1000 / 30 - 2) return;
      last = ms;
      const st = g.st;
      if (!st || st.game !== name) {
        g.ctx.drawImage(g.layer('waiting', (x) => { base(g, x); }), 0, 0);
        return;
      }
      const e = g.now() - st.at;
      if (renderer.draw && renderer.draw(g, st, e) !== false) return;
      (SHARED[st.phase] || lobby)(g, st, e);
    };
    raf = requestAnimationFrame(frame);
    return { stop() { stopped = true; cancelAnimationFrame(raf); g.off(); if (document.fonts) document.fonts.removeEventListener('loadingdone', g.refresh); } };
  }

  // ------------------------------------------------------------ closest wins

  // Asking: the question in big ivory with its unit in a gold tag, a draining bar, and one dot
  // per player that fills as they lock in. Reveal: a number line down the whole wall; the dots
  // drop on one at a time, furthest first, then the answer falls as a gold line, huge, with the
  // closest name and how far off they were. Nobody is ever labelled as the worst.
  const closest = {
    draw(g, st, e) {
      if (st.phase === 'ask') return askScreen(g, st);
      if (st.phase === 'double') return doubleScreen(g, st, e);
      if (st.phase === 'reveal') return revealScreen(g, st, e);
      return false;
    },
  };

  function askScreen(g, st) {
    const { ctx, k, W, H, s } = g;
    const key = `ask|${st.at}`;
    ctx.drawImage(g.layer(key, (x) => {
      const hh = base(g, x, `${st.n} / ${st.of}${st.double ? ' · DOUBLE' : ''}`);
      const top = hh + H * 0.03, bottom = H * 0.7;
      const tagH = Math.round(s * 0.085);
      const byH = st.by ? Math.round(s * 0.07) : 0;
      k.tracking(x, s * 0.004);
      const b = k.fitWrapped(x, st.text, 'Josefin Sans', W * 0.86, bottom - top - tagH - byH - s * 0.08, 4, 1.12);
      const size = Math.min(b.size, Math.round(s * 0.15));
      x.font = k.font('Josefin Sans', size);
      const blockH = b.lines.length * size * 1.12 + byH + s * 0.06 + tagH;
      let y = top + (bottom - top - blockH) / 2;
      x.fillStyle = k.IVORY;
      x.textAlign = 'center';
      x.textBaseline = 'top';
      b.lines.forEach((l) => { x.fillText(l, W / 2, y); y += size * 1.12; });
      k.tracking(x, 0);
      if (st.by) y = stack(g, x, y + s * 0.01, [[st.by, 'Josefin Sans', Math.round(s * 0.055), k.GOLD_LIGHT, s * 0.01]]) - s * 0.01;
      y += s * 0.05;
      // the unit tag: black capitals on a solid gold plate
      const tag = st.tag || '';
      if (tag) {
        k.tracking(x, s * 0.016);
        x.font = k.font('Josefin Sans', Math.round(tagH * 0.58));
        const tw = Math.min(W * 0.8, x.measureText(tag).width + tagH * 0.9);
        x.fillStyle = k.GOLD;
        x.fillRect(Math.round(W / 2 - tw / 2), Math.round(y), Math.round(tw), tagH);
        x.fillStyle = '#000';
        x.textBaseline = 'middle';
        x.fillText(tag, W / 2 + s * 0.008, Math.round(y) + tagH * 0.56);
        k.tracking(x, 0);
      }
      stack(g, x, H * 0.76, [['LOCK IN ON YOUR PHONE', 'Josefin Sans', Math.round(s * 0.042), k.MUTED, s * 0.012]]);
    }), 0, 0);
    countdown(g, st, Math.round(H * 0.835));
    lockDots(g, st.locks, Math.round(H * 0.915));
  }

  function doubleScreen(g, st) {
    const { ctx, k, W, H, s } = g;
    ctx.drawImage(g.layer(`double|${st.at}`, (x) => {
      const hh = base(g, x, `${st.n} / ${st.of}`);
      k.sunburst(x, W / 2, H * 0.52, H * 0.42, 24, k.GOLD, 0.16, 0);
      let y = hh + H * 0.1;
      y = stack(g, x, y, [[`QUESTION ${st.n}`, 'Josefin Sans', Math.round(s * 0.06), k.GOLD, s * 0.02]]);
      y = title(g, x, 'DOUBLE', y + s * 0.03, H * 0.15, 'Josefin Sans', k.GOLD_LIGHT);
      y = stack(g, x, y + s * 0.01, [['OR NOTHING', 'Josefin Sans', Math.round(s * 0.075), k.IVORY, s * 0.02]]);
      y += s * 0.07;
      k.decoRule(x, W * 0.22, y, W * 0.56, s);
      stack(g, x, y + s * 0.08, [
        ['TAP DOUBLE ON YOUR PHONE', 'Josefin Sans', Math.round(s * 0.05), k.IVORY, s * 0.008],
        ['BEFORE YOU SEE IT', 'Josefin Sans', Math.round(s * 0.05), k.IVORY, s * 0.008],
        ['', '', s * 0.03],
        ['TWICE THE POINTS IF YOU PLACE', 'Josefin Sans', Math.round(s * 0.042), k.MUTED, s * 0.006],
        ['LOSE 2 IF YOU DON\'T', 'Josefin Sans', Math.round(s * 0.042), k.MUTED, s * 0.006],
      ]);
    }), 0, 0);
    countdown(g, st, H - Math.round(s * 0.05));
  }

  // Where everything sits on the number line, worked out once per reveal.
  function revealPlan(g, st) {
    const { W, H, s } = g;
    const axisX = Math.round(W * 0.2), top = Math.round(H * 0.16), bottom = Math.round(H * 0.95);
    const span = Math.max(1e-9, st.max - st.min);
    const yOf = (v) => Math.round(bottom - ((v - st.min) / span) * (bottom - top));
    const r = Math.round(s * 0.042);
    const lane0 = axisX + r + 8, laneW = r * 2 + 5;
    const lanes = Math.max(1, Math.floor((W - 8 - lane0 + r) / laneW));
    const placed = [];
    // close guesses are nudged sideways into the next free lane so dots never overlap
    const dots = (st.rows || []).map((row) => {
      const y = yOf(row.value);
      let lane = 0;
      while (lane < lanes - 1 && placed.some((p) => p.lane === lane && Math.abs(p.y - y) < r * 2 + 1)) lane++;
      const d = { row, y, lane, x: lane0 + lane * laneW };
      placed.push(d);
      return d;
    });
    const ay = yOf(st.answer);
    // The answer plate goes where it hides the fewest dots, the closest ones most of all, and
    // never over the gold line.
    const plateH = Math.round(H * 0.24), lineH = Math.round(s * 0.11), block = plateH + lineH;
    let plateY = top, best = Infinity;
    for (let y = top - 8; y <= bottom + 8 - block; y += 4) {
      if (ay + 4 > y && ay - 4 < y + block) continue;
      let cost = Math.abs(y + block / 2 - ay) / H; // a little nearer the line, all else equal
      for (const d of dots) {
        if (d.y + r > y && d.y - r < y + block) cost += d.row.rank === 1 ? 100 : d.row.rank <= 3 ? 10 : 1;
      }
      if (cost < best) { best = cost; plateY = y; }
    }
    return { axisX, top, bottom, r, dots, ay, plateY, plateH, lineH, yOf };
  }

  function revealScreen(g, st, e) {
    const { ctx, k, W, H, s } = g;
    const key = `reveal|${st.at}`;
    if (!g.plan || g.plan.key !== key) g.plan = { key, ...revealPlan(g, st) };
    const P = g.plan, T = st.times;
    ctx.drawImage(g.layer(key, (x) => {
      k.backdrop(x, W, H);
      // the question, small, at the top
      k.tracking(x, s * 0.004);
      const q = st.by ? `${st.text} · ${st.by}` : st.text;
      const b = k.fitWrapped(x, q, 'Josefin Sans', W * 0.84, H * 0.095, 2, 1.15);
      const px = Math.min(b.size, Math.round(s * 0.05));
      x.font = k.font('Josefin Sans', px);
      x.fillStyle = k.MUTED;
      x.textAlign = 'center';
      x.textBaseline = 'top';
      b.lines.forEach((l, i) => x.fillText(l, W / 2, H * 0.035 + i * px * 1.15));
      k.tracking(x, 0);
      // the line, with its ends labelled
      x.fillStyle = k.rgba(k.GOLD, 0.7);
      x.fillRect(P.axisX, P.top, 2, P.bottom - P.top);
      for (let i = 0; i <= 4; i++) x.fillRect(P.axisX - 3, Math.round(P.top + ((P.bottom - P.top) * i) / 4), 8, 1);
      x.textAlign = 'right';
      x.textBaseline = 'middle';
      x.fillStyle = k.GOLD;
      for (const [v, y] of [[st.max, P.top], [st.min, P.bottom]]) {
        const t = fmt(v, st.year);
        x.font = k.font('Josefin Sans', Math.min(Math.round(s * 0.045), k.fitSize(x, t, 'Josefin Sans', P.axisX - 8, s * 0.045)));
        x.fillText(t, P.axisX - 5, y + 1);
      }
    }), 0, 0);

    // the answer falls as a gold line (under the dots, so none is hidden)
    if (e >= T.answer) {
      const u = ease((e - T.answer) / 0.6);
      const y = Math.round(P.top + (P.ay - P.top) * u);
      ctx.fillStyle = k.GOLD_LIGHT;
      ctx.fillRect(P.axisX - 6, y - 1, W - P.axisX - 4, 3);
      ctx.fillRect(P.axisX - 6, y - 4, 3, 9);
    }
    // the dots drop on, one at a time
    P.dots.forEach((d, i) => {
      const t0 = T.drops[i];
      if (e < t0) return;
      const u = easeOut((e - t0) / 0.45);
      const y = Math.round(P.top - P.r * 2 + (d.y - P.top + P.r * 2) * u);
      const p = { color: d.row.color, initial: d.row.initial };
      if (d.row.doubled) {
        ctx.fillStyle = k.GOLD_LIGHT;
        ctx.fillRect(d.x - P.r - 2, y - 1, P.r * 2 + 4, 2);
      }
      dot(g, ctx, p, d.x, y, P.r, true);
      if (d.row.sip && e >= T.answer + 0.6) drop(g, ctx, d.x, y - P.r - Math.round(P.r * 0.7), Math.max(3, Math.round(P.r * 0.4)));
    });

    // then, huge, the number with the winner's line under it
    if (e >= T.answer + 0.6) {
      const a = ease((e - T.answer - 0.6) / 0.35);
      ctx.globalAlpha = a;
      ctx.drawImage(g.layer(`${key}|plate`, (x) => answerPlate(g, x, st, P)), 0, 0);
      if (e >= T.line) {
        ctx.globalAlpha = ease((e - T.line) / 0.4);
        ctx.drawImage(g.layer(`${key}|line`, (x) => winnerLine(g, x, st, P)), 0, 0);
      }
      ctx.globalAlpha = 1;
    }
  }

  function answerPlate(g, x, st, P) {
    const { k, W, s } = g;
    const left = P.axisX + 8, w = W - 8 - left, h = P.plateH;
    x.fillStyle = 'rgba(0,0,0,0.88)';
    x.fillRect(left, P.plateY, w, h);
    if (st.spot) {
      x.save();
      x.beginPath();
      x.rect(left, P.plateY, w, h);
      x.clip();
      // spot on: a full deco sunburst behind the number (two half fans, one turned over)
      k.sunburst(x, left + w / 2, P.plateY + h * 0.42, w, 20, k.GOLD, 0.22, 0);
      k.sunburst(x, left + w / 2, P.plateY + h * 0.42, w, 20, k.GOLD, 0.22, Math.PI);
      x.restore();
    }
    const numH = h * 0.72;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = k.font('Josefin Sans', k.fitSize(x, st.answerText, 'Josefin Sans', w * 0.94, numH));
    x.fillStyle = k.GOLD_LIGHT;
    x.fillText(st.answerText, left + w / 2, P.plateY + h * 0.4);
    if (st.unit && !st.year) {
      k.tracking(x, s * 0.016);
      x.font = k.font('Josefin Sans', Math.min(Math.round(s * 0.045), k.fitSize(x, st.unit, 'Josefin Sans', w * 0.9, s * 0.045)));
      x.fillStyle = k.GOLD;
      x.fillText(st.unit, left + w / 2, P.plateY + h * 0.82);
      k.tracking(x, 0);
    }
  }

  function winnerLine(g, x, st, P) {
    const { k, W, s } = g;
    const left = P.axisX + 8, w = W - 8 - left;
    const lh = P.lineH;
    const y = P.plateY + P.plateH;
    x.fillStyle = 'rgba(0,0,0,0.88)';
    x.fillRect(left, y, w, lh);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    k.tracking(x, s * 0.006);
    x.font = k.font('Josefin Sans', Math.min(Math.round(s * 0.07), k.fitSize(x, st.winner, 'Josefin Sans', w * 0.94, s * 0.07)));
    x.fillStyle = k.IVORY;
    x.fillText(st.winner, left + w / 2, y + lh * 0.5);
    k.tracking(x, 0);
  }

  RENDERERS.closest = closest;

  window.BarParty = {
    register(name, renderer) { RENDERERS[name] = renderer; },
    has(name) { return name in RENDERERS; },
    create,
    // For other party games: the shared screens and pieces, drawn the same way everywhere.
    kit: { base, stack, title, drop, dot, countdown, lockDots, lobby, between, podium, offscreen, ease, easeOut, fmt },
  };
})();
