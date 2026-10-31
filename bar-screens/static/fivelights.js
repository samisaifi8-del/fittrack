// Five Lights on the wall: Never Have I Ever with five gold bulbs each. The Pi referees it
// (FiveLights in partygames.py); this only draws its views, with the party kit (static/party.js).
//
//   ask      'NEVER HAVE I EVER' small in gold, the prompt huge in ivory, a draining bar, and the
//            players along the bottom: a lock dot (filled once they've answered), the name and
//            five bulbs. A Room prompt carries a gold plate: THE ROOM · NO NAMES.
//   reveal   '3 OF 7 / HAVE' huge; then the names that have light up and their bulbs go out one
//            at a time. A Room prompt shows only the percentage, no names, no bulbs.
//   story    STORY and the teller's name in their colour, while a gold border slowly draws
//            itself round the wall (30 seconds).
//   podium   the last one lit, on a marquee of chasing bulbs, and RELIGHT?
// The lobby and the card between games are the kit's.
//
// A frame is a few cached layers stamped on, plus a bulb or two fading out and the sip drops.
(() => {
  'use strict';

  const kit = () => window.BarParty.kit;

  // A bulb, lit (gold with a small ivory glint and a faint halo) or out (a hollow gold ring, so
  // it still reads on black from across the room).
  function bulb(g, r, state) {
    const { k } = g;
    return g.sprite(`fl-bulb|${r}|${state}`, r * 2 + 6, r * 2 + 6, (x) => {
      const m = r + 3;
      if (state === 'on') {
        x.fillStyle = k.rgba(k.GOLD, 0.28);
        x.beginPath(); x.arc(m, m, r + 2, 0, Math.PI * 2); x.fill();
      }
      if (state === 'off') {
        x.strokeStyle = k.rgba(k.GOLD, 0.75);
        x.lineWidth = 2;
        x.beginPath(); x.arc(m, m, r - 1, 0, Math.PI * 2); x.stroke();
        return;
      }
      x.fillStyle = state === 'on' ? k.GOLD_LIGHT : k.IVORY;
      x.beginPath(); x.arc(m, m, r, 0, Math.PI * 2); x.fill();
      if (state === 'on' && r >= 4) {
        x.fillStyle = k.IVORY;
        x.beginPath(); x.arc(m - r * 0.3, m - r * 0.3, Math.max(1, r * 0.3), 0, Math.PI * 2); x.fill();
      }
    });
  }
  const stamp = (g, c, cx, cy) => g.ctx.drawImage(c, Math.round(cx - c.width / 2), Math.round(cy - c.height / 2));

  // ------------------------------------------------------------ the roster along the bottom

  // Where the rows go: bigger rows for fewer players, the bulbs in a column on the right.
  function rows(g, n) {
    const { W, H } = g;
    const rowH = Math.max(17, Math.min(30, Math.floor(150 / Math.max(1, n))));
    const top = H - 14 - rowH * n;
    const r = Math.max(4, Math.min(7, Math.round(rowH * 0.24)));
    const gap = r * 2 + Math.max(3, Math.round(r * 0.6));
    const bx0 = W - 17 - r - gap * 4;
    return { top, rowH, r, gap, bx0, dotX: 20, nameX: 30, nameW: bx0 - r - 30 - 14 };
  }

  // Bulbs lit as the wall shows them now: one going out in a reveal still counts until it goes.
  function shownLit(st, p, e) {
    let n = p.lit != null ? p.lit : 5;
    if (st.phase === 'reveal' && !st.room) for (const o of st.outs || []) if (o.slot === p.slot && e < o.at) n++;
    return n;
  }

  // mode: 'ask' (lock dots), 'reveal' (who has, once lit), or 'plain'
  function roster(g, st, e, mode) {
    const { ctx, k, s } = g;
    const players = st.players || [];
    if (!players.length) return null;
    const L = rows(g, players.length);
    const marked = mode === 'reveal' && e >= 1.6;
    const have = new Set(st.have || []);
    const lit = players.map((p) => shownLit(st, p, Math.max(e, 0)));
    const key = `fl-roster|${mode}|${marked ? 1 : 0}|${players.map((p, i) => `${p.slot}:${p.name}:${lit[i]}:${p.answered ? 1 : 0}`).join(',')}`;
    if (!g.flEnds) g.flEnds = {};
    ctx.drawImage(g.layer(key, (x) => {
      players.forEach((p, i) => {
        const cy = Math.round(L.top + L.rowH * i + L.rowH / 2);
        const dim = marked && !have.has(p.slot);
        x.globalAlpha = dim ? 0.55 : 1;
        // the lock dot: an empty ring until they've answered (only while answering), a gold
        // bar by the names that have (in a reveal)
        const dr = Math.max(3, Math.round(L.rowH * 0.17));
        if (mode === 'ask') {
          x.beginPath();
          x.arc(L.dotX, cy, p.answered ? dr : dr - 1, 0, Math.PI * 2);
          if (p.answered) { x.fillStyle = p.color; x.fill(); } else { x.strokeStyle = k.rgba(p.color, 0.6); x.lineWidth = 2; x.stroke(); }
        } else if (marked && have.has(p.slot)) {
          x.fillStyle = k.GOLD_LIGHT;
          x.fillRect(L.dotX - 3, Math.round(cy - L.rowH * 0.32), 4, Math.round(L.rowH * 0.64));
        }
        k.tracking(x, s * 0.004);
        // the whole name as big as the row allows; a long two-word one that would come out
        // small goes by its first word (MOHAMMED ALI -> MOHAMMED)
        const full = Math.round(L.rowH * 0.66);
        let name = p.name, size = Math.min(full, k.fitSize(x, name, 'Josefin Sans', L.nameW, full));
        if (size < full * 0.8 && name.includes(' ')) {
          name = name.split(' ')[0];
          size = Math.min(full, k.fitSize(x, name, 'Josefin Sans', L.nameW, full));
        }
        x.font = k.font('Josefin Sans', size);
        x.textAlign = 'left';
        x.textBaseline = 'middle';
        x.fillStyle = lit[i] > 0 || (marked && have.has(p.slot)) ? p.color : k.MUTED;
        x.fillText(name, L.nameX, cy + 1);
        g.flEnds[p.slot] = L.nameX + x.measureText(name).width;
        k.tracking(x, 0);
        x.globalAlpha = 1;
        for (let b = 0; b < 5; b++) {
          const c = bulb(g, L.r, b < lit[i] ? 'on' : 'off');
          x.drawImage(c, Math.round(L.bx0 + b * L.gap - c.width / 2), Math.round(cy - c.height / 2));
        }
      });
    }), 0, 0);
    // a bulb going out: a flash, then it fades to dark glass
    if (mode === 'reveal') {
      for (const o of st.outs || []) {
        const u = (e - o.at) / 0.7;
        if (u < 0 || u >= 1) continue;
        const i = players.findIndex((p) => p.slot === o.slot);
        if (i < 0) continue;
        const cx = L.bx0 + o.left * L.gap, cy = Math.round(L.top + L.rowH * i + L.rowH / 2);
        ctx.globalAlpha = 1 - kit().ease(u);
        stamp(g, bulb(g, L.r, u < 0.18 ? 'flash' : 'on'), cx, cy);
        ctx.globalAlpha = 1;
      }
    }
    // sips: a small gold drop after the name
    players.forEach((p, i) => {
      if (!g.dropOn(p.slot) || g.flEnds[p.slot] == null) return;
      kit().drop(g, ctx, g.flEnds[p.slot] + 9, Math.round(L.top + L.rowH * i + L.rowH / 2), Math.max(3, Math.round(L.rowH * 0.17)));
    });
    return L;
  }

  // ------------------------------------------------------------ screens

  // The prompt, as big as fits in up to four lines, centred between top and bottom.
  function prompt(g, x, text, top, bottom, maxSize) {
    const { k, W, s } = g;
    k.tracking(x, s * 0.004);
    const b = k.fitWrapped(x, text, 'Josefin Sans', W * 0.86, bottom - top, 4, 1.1);
    const size = Math.min(b.size, maxSize || Math.round(s * 0.17));
    x.font = k.font('Josefin Sans', size);
    x.textAlign = 'center';
    x.textBaseline = 'top';
    let y = top + (bottom - top - b.lines.length * size * 1.1) / 2 + size * 0.06;
    b.lines.forEach((l) => { x.fillText(l, W / 2, y); y += size * 1.1; });
    k.tracking(x, 0);
    return y;
  }

  // A gold plate with black capitals (THE ROOM · NO NAMES).
  function plate(g, x, text, cy, h) {
    const { k, W, s } = g;
    k.tracking(x, s * 0.014);
    x.font = k.font('Josefin Sans', Math.round(h * 0.56));
    const w = Math.min(W * 0.84, x.measureText(text).width + h * 1.1);
    x.fillStyle = k.GOLD;
    x.fillRect(Math.round(W / 2 - w / 2), Math.round(cy - h / 2), Math.round(w), h);
    x.fillStyle = '#000';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, W / 2 + s * 0.007, Math.round(cy) + h * 0.06);
    k.tracking(x, 0);
  }

  const header = (g, x) => { g.k.backdrop(x, g.W, g.H); return g.k.header(x, g.W, g.H, { name: 'NEVER HAVE I EVER' }); };

  function askScreen(g, st, e) {
    const { ctx, k, W, H, s } = g;
    const L = rows(g, (st.players || []).length);
    const barY = L.top - 13;
    ctx.drawImage(g.layer(`fl-ask|${st.at}|${L.top}`, (x) => {
      const hh = header(g, x);
      const tagH = st.room ? Math.round(s * 0.075) : 0;
      x.fillStyle = k.IVORY;
      const y = prompt(g, x, st.text, hh + 6, barY - 10 - (tagH ? tagH + s * 0.05 : 0));
      if (tagH) plate(g, x, 'THE ROOM · NO NAMES', y + s * 0.03 + tagH / 2, tagH);
    }), 0, 0);
    kit().countdown(g, st, barY);
    roster(g, st, e, 'ask');
  }

  function revealScreen(g, st, e) {
    const { ctx, k, W, H, s } = g;
    if (st.room) return roomScreen(g, st, e);
    const L = rows(g, (st.players || []).length);
    ctx.drawImage(g.layer(`fl-reveal|${st.at}`, (x) => {
      const hh = header(g, x);
      // the prompt, smaller, then the count huge
      k.tracking(x, s * 0.004);
      const b = k.fitWrapped(x, st.text, 'Josefin Sans', W * 0.84, s * 0.15, 2, 1.12);
      const px = Math.min(b.size, Math.round(s * 0.065));
      x.font = k.font('Josefin Sans', px);
      x.fillStyle = k.MUTED;
      x.textAlign = 'center';
      x.textBaseline = 'top';
      b.lines.forEach((l, i) => x.fillText(l, W / 2, hh + 2 + i * px * 1.12));
      k.tracking(x, 0);
    }), 0, 0);
    const n = st.count, of = st.answered;
    const [big, small] = !of ? ['NOBODY', 'ANSWERED'] : !n ? ['NOBODY', 'HAS'] : n === of && of > 1 ? ['ALL ' + of, 'HAVE'] : [`${n} OF ${of}`, n === 1 ? 'HAS' : 'HAVE'];
    const a = kit().ease(e / 0.35);
    ctx.globalAlpha = a;
    ctx.drawImage(g.layer(`fl-count|${st.at}`, (x) => {
      const top = s * 0.15 + s * 0.16, bottom = L.top - s * 0.04;
      const bigH = Math.min(s * 0.25, (bottom - top) * 0.62);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      k.tracking(x, s * 0.006);
      x.font = k.font('Josefin Sans', k.fitSize(x, big, 'Josefin Sans', W * 0.84, bigH));
      x.fillStyle = k.GOLD_LIGHT;
      const cy = top + (bottom - top) * 0.4;
      x.fillText(big, W / 2, cy);
      k.tracking(x, s * 0.03);
      x.font = k.font('Josefin Sans', Math.round(s * 0.085));
      x.fillStyle = k.IVORY;
      x.fillText(small, W / 2 + s * 0.015, cy + bigH * 0.5 + s * 0.07);
      k.tracking(x, 0);
    }), 0, 0);
    ctx.globalAlpha = 1;
    roster(g, st, e, 'reveal');
  }

  // A Room prompt: only the percentage, the prompt, and nothing about anyone.
  function roomScreen(g, st, e) {
    const { ctx, k, W, H, s } = g;
    ctx.drawImage(g.layer(`fl-room|${st.at}`, (x) => header(g, x)), 0, 0);
    ctx.globalAlpha = kit().ease(e / 0.4);
    ctx.drawImage(g.layer(`fl-room-pct|${st.at}`, (x) => {
      const pct = st.answered ? `${st.pct}%` : '—';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.font = k.font('Josefin Sans', k.fitSize(x, pct, 'Josefin Sans', W * 0.8, s * 0.36));
      x.fillStyle = k.GOLD_LIGHT;
      x.fillText(pct, W / 2, H * 0.27);
      k.tracking(x, s * 0.03);
      x.font = k.font('Josefin Sans', Math.round(s * 0.085));
      x.fillStyle = k.IVORY;
      x.fillText(st.answered ? 'HAVE' : 'NOBODY ANSWERED', W / 2 + s * 0.015, H * 0.41);
      k.tracking(x, 0);
      x.fillStyle = k.IVORY;
      prompt(g, x, st.text, H * 0.47, H * 0.81, Math.round(s * 0.13));
      kit().stack(g, x, H * 0.86, [['THE ROOM · NO NAMES', 'Josefin Sans', Math.round(s * 0.045), k.MUTED, s * 0.012]]);
    }), 0, 0);
    ctx.globalAlpha = 1;
  }

  // Story time: the teller's name, and a gold border that draws itself round the wall.
  function storyScreen(g, st, e) {
    const { ctx, k, W, H, s } = g;
    const inset = 7, t = 3;
    ctx.drawImage(g.layer(`fl-story|${st.at}`, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      x.fillStyle = k.rgba(k.GOLD, 0.22);
      x.fillRect(inset, inset, W - inset * 2, t);
      x.fillRect(inset, H - inset - t, W - inset * 2, t);
      x.fillRect(inset, inset, t, H - inset * 2);
      x.fillRect(W - inset - t, inset, t, H - inset * 2);
      let y = H * 0.27;
      y = kit().stack(g, x, y, [['STORY', 'Josefin Sans', Math.round(s * 0.075), k.GOLD, s * 0.05]]);
      y = kit().title(g, x, st.name, y + s * 0.04, H * 0.24, 'Poiret One', st.color || k.IVORY);
      y += s * 0.07;
      k.decoRule(x, W * 0.24, y, W * 0.52, s);
      y += s * 0.07;
      k.tracking(x, s * 0.004);
      const b = k.fitWrapped(x, st.text, 'Josefin Sans', W * 0.76, s * 0.2, 3, 1.15);
      const px = Math.min(b.size, Math.round(s * 0.06));
      x.font = k.font('Josefin Sans', px);
      x.fillStyle = k.MUTED;
      x.textAlign = 'center';
      x.textBaseline = 'top';
      b.lines.forEach((l, i) => x.fillText(l, W / 2, y + i * px * 1.15));
      k.tracking(x, 0);
    }), 0, 0);
    // the border, clockwise from the top middle, as the half minute runs
    const total = Math.max(1, (st.until || st.at + 30) - st.at);
    const w = W - inset * 2, h = H - inset * 2;
    let left = Math.max(0, Math.min(1, e / total)) * (w + h) * 2;
    ctx.fillStyle = k.GOLD_LIGHT;
    const run = (len, draw) => { const d = Math.min(len, left); if (d > 0) draw(Math.round(d)); left -= d; };
    run(w / 2, (d) => ctx.fillRect(W / 2, inset, d, t));
    run(h, (d) => ctx.fillRect(W - inset - t, inset, t, d));
    run(w, (d) => ctx.fillRect(W - inset - d, H - inset - t, d, t));
    run(h, (d) => ctx.fillRect(inset, H - inset - d, t, d));
    run(w / 2, (d) => ctx.fillRect(inset, inset, d, t));
  }

  // The marquee: bulbs all round the wall, every third one lit, chasing.
  function marqueeLayer(g, phase) {
    const { W, H } = g;
    return g.layer(`fl-marquee|${phase}`, (x) => {
      const inset = 9, step = 15;
      const pts = [];
      const nx = Math.round((W - inset * 2) / step), ny = Math.round((H - inset * 2) / step);
      const dx = (W - inset * 2) / nx, dy = (H - inset * 2) / ny;
      for (let i = 0; i < nx; i++) pts.push([inset + i * dx, inset]);
      for (let i = 0; i < ny; i++) pts.push([W - inset, inset + i * dy]);
      for (let i = 0; i < nx; i++) pts.push([W - inset - i * dx, H - inset]);
      for (let i = 0; i < ny; i++) pts.push([inset, H - inset - i * dy]);
      pts.forEach(([px, py], i) => {
        const c = bulb(g, 4, i % 3 === phase ? 'on' : 'off');
        x.drawImage(c, Math.round(px - c.width / 2), Math.round(py - c.height / 2));
      });
    });
  }

  function winnerScreen(g, st, e) {
    const { ctx, k, W, H, s } = g;
    const winners = st.winners || [];
    ctx.drawImage(g.layer(`fl-win|${st.at}`, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      const one = winners.length === 1;
      let y = H * 0.16;
      y = kit().stack(g, x, y, [[one ? 'LAST ONE LIT' : winners.length ? 'OUT TOGETHER' : 'ALL OUT', 'Josefin Sans', Math.round(s * 0.06), k.GOLD, s * 0.03]]);
      y += s * 0.03;
      if (one) {
        // narrower than the kit's title: the marquee bulbs run down both sides
        k.tracking(x, s * 0.01);
        const b = k.fitWrapped(x, winners[0].name, 'Poiret One', W * 0.72, H * 0.24, 2, 1.08);
        x.font = k.font('Poiret One', b.size);
        x.fillStyle = winners[0].color || k.IVORY;
        x.textAlign = 'center';
        x.textBaseline = 'top';
        b.lines.forEach((l) => { x.fillText(l, W / 2, y); y += b.size * 1.08; });
        k.tracking(x, 0);
      } else {
        // a shared win: each name on its own line, in its colour
        const lh = Math.min(H * 0.36 / Math.max(1, winners.length), s * 0.14);
        winners.forEach((w) => {
          x.font = k.font('Poiret One', Math.min(lh * 0.9, k.fitSize(x, w.name, 'Poiret One', W * 0.76, lh * 0.9)));
          x.fillStyle = w.color || k.IVORY;
          x.textAlign = 'center';
          x.textBaseline = 'top';
          x.fillText(w.name, W / 2, y);
          y += lh;
        });
        y = kit().stack(g, x, y + s * 0.02, [['SHARE THE WIN', 'Josefin Sans', Math.round(s * 0.05), k.GOLD, s * 0.02]]);
      }
      // the bulbs they had left
      if (one && st.spare) {
        y += s * 0.05;
        const r = 7, gap = 22;
        for (let b = 0; b < 5; b++) {
          const c = bulb(g, r, b < st.spare ? 'on' : 'off');
          x.drawImage(c, Math.round(W / 2 + (b - 2) * gap - c.width / 2), Math.round(y - c.height / 2));
        }
        y += s * 0.05;
      }
      y = Math.max(y + s * 0.06, H * 0.64);
      k.decoRule(x, W * 0.24, y, W * 0.52, s);
      kit().stack(g, x, y + s * 0.06, [
        ['RELIGHT?', 'Josefin Sans', Math.round(s * 0.095), k.IVORY, s * 0.03],
        ['ON YOUR PHONE', 'Josefin Sans', Math.round(s * 0.045), k.MUTED, s * 0.02],
      ]);
    }), 0, 0);
    ctx.drawImage(marqueeLayer(g, Math.floor(e * 3) % 3), 0, 0);
  }

  window.BarParty.register('fivelights', {
    draw(g, st, e) {
      if (st.phase === 'ask') return askScreen(g, st, e);
      if (st.phase === 'reveal') return revealScreen(g, st, e);
      if (st.phase === 'story') return storyScreen(g, st, e);
      if (st.phase === 'podium') return winnerScreen(g, st, e);
      return false;
    },
  });
})();
