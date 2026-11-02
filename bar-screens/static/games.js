// Party games for the LED walls. The wall runs each game; phones on the Wi-Fi are the controllers
// (static/play.html). Inputs arrive over the game bus as { slot, kind, x | dir | ... }, and each
// game reports its status back so the phones can show scores and what to do next. Quiz and vote
// games are refereed by the Pi instead and drawn by static/party.js.
(() => {
  'use strict';

  const kit = () => window.BarChannels.kit;
  const JEWELS = ['#b89a63', '#d9c49a', '#ece4d4', '#9c8256', '#cdb68a', '#e2d3b0']; // tonal golds and ivories

  function loop(step) {
    let raf = 0, last = 0, stopped = false;
    const frame = (ms) => {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      const t = ms / 1000;
      const dt = last ? Math.min(0.05, t - last) : 0;
      last = t;
      step(dt, t);
    };
    raf = requestAnimationFrame(frame);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }

  // Shared scaffolding: roster, inputs, the framed play area and throttled status reports.
  function setup(canvas, W, H, opts) {
    const k = kit();
    const g = {
      k, W, H, ctx: canvas.getContext('2d'), s: Math.min(W, H), players: [], joinUrl: '', inputs: [],
      lastReport: '', reportAt: 0, pending: null,
    };
    g.off = opts.bus.on((m) => {
      if (m.type === 'roster') {
        g.players = m.players || []; g.joinUrl = m.joinUrl || '';
        const key = (m.joinQr || []).join('');
        if (key !== g.qrKey) { g.qrKey = key; g.joinQr = m.joinQr || null; g.qrCanvas = null; }
      }
      else if (m.type === 'input') g.inputs.push(m);
    });
    g.frame = (label) => {
      k.backdrop(g.ctx, W, H, k.THEMES.games.accent);
      const hh = k.header(g.ctx, W, H, k.THEMES.games, label);
      const pad = Math.max(4, Math.round(g.s * 0.05));
      return { x: pad, y: hh + Math.round(pad * 0.5), w: W - pad * 2, h: H - hh - Math.round(pad * 1.5) };
    };
    g.drain = () => { const list = g.inputs; g.inputs = []; return list; };
    g.name = (slot) => { const p = g.players.find((x) => x.slot === slot); return p ? p.name : `PLAYER ${slot + 1}`; };
    g.color = (slot) => { const p = g.players.find((x) => x.slot === slot); return p ? p.color : JEWELS[slot % JEWELS.length]; };
    // Status goes to the phones at most a few times a second.
    g.report = (status, now) => {
      const json = JSON.stringify(status);
      if (json === g.lastReport) return;
      if (now - g.reportAt < 0.3) { g.pending = status; return; }
      g.lastReport = json;
      g.reportAt = now;
      g.pending = null;
      opts.bus.report(status);
    };
    g.flush = (now) => { if (g.pending && now - g.reportAt >= 0.3) g.report(g.pending, now); };
    return g;
  }

  // Title card shown between games: the name, how to play, where to join and who's in.
  function card(g, area, title, lines, alpha) {
    const { ctx, k, s } = g;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = '#000';
    ctx.fillRect(area.x, area.y, area.w, area.h);
    const pad = area.w * 0.06;
    let y = area.y + area.h * 0.1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    k.tracking(ctx, s * 0.01);
    const tb = k.fitWrapped(ctx, title, 'Poiret One', area.w - pad * 2, area.h * 0.22, 2, 1.05);
    ctx.font = k.font('Poiret One', tb.size);
    ctx.fillStyle = k.gold(ctx, area.x, y, area.x + area.w, y + tb.size);
    tb.lines.forEach((l) => { ctx.fillText(l, area.x + area.w / 2, y); y += tb.size * 1.05; });
    k.tracking(ctx, 0);
    y += s * 0.015;
    k.decoRule(ctx, area.x + area.w * 0.15, y, area.w * 0.7, s);
    y += s * 0.05;
    const lineSize = Math.max(8, Math.min(area.h * 0.075, s * 0.06));
    for (const line of lines) {
      if (!line) { y += lineSize * 0.5; continue; }
      if (line.qr) {
        // the code to scan, as big as the card has room for (drawn once, then stamped)
        const room = Math.min(area.w * 0.52, area.y + area.h - y - lineSize * 1.6);
        const n = g.joinQr.length + 4, cell = Math.floor(room / n);
        if (cell >= 2) {
          const px = cell * n;
          if (!g.qrCanvas || g.qrCanvas.width !== px) {
            g.qrCanvas = document.createElement('canvas');
            g.qrCanvas.width = g.qrCanvas.height = px;
            k.drawQR(g.qrCanvas.getContext('2d'), g.joinQr, 0, 0, px);
          }
          ctx.drawImage(g.qrCanvas, Math.round(area.x + area.w / 2 - px / 2), Math.round(y));
          y += px + lineSize * 0.5;
        }
        continue;
      }
      const [text, color] = Array.isArray(line) ? line : [line, k.IVORY];
      const b = k.fitWrapped(ctx, text, 'Cormorant', area.w - pad * 2, lineSize * 2.2, 2, 1.1);
      ctx.font = k.font('Cormorant', Math.min(b.size, lineSize));
      ctx.fillStyle = color;
      b.lines.forEach((l) => { ctx.fillText(l, area.x + area.w / 2, y); y += Math.min(b.size, lineSize) * 1.15; });
    }
    ctx.restore();
  }

  function joinLines(g) {
    const who = g.players.length ? g.players.map((p) => p.name).join('  ·  ') : 'Nobody has joined yet';
    if (g.joinQr) return ['', ['Scan to play', g.k.GOLD_LIGHT], { qr: true }, [who, '#a59a84']];
    return ['', ['Join on your phone', g.k.GOLD], [g.joinUrl ? g.joinUrl.toUpperCase() : 'OPEN /PLAY ON THE BAR WI-FI', g.k.GOLD_LIGHT], '', [who, '#a59a84']];
  }

  function scores(g, area, list, top) {
    // list: [{ name, color, score }], drawn as a row of name chips along the top of the area
    const { ctx, k, s } = g;
    if (!list.length) return;
    const h = Math.max(9, Math.round(s * 0.06));
    const w = area.w / Math.min(list.length, 4);
    ctx.textBaseline = 'middle';
    list.slice(0, 8).forEach((p, i) => {
      const x = area.x + (i % 4) * w, y = top + Math.floor(i / 4) * h;
      ctx.fillStyle = p.color;
      ctx.fillRect(x + 2, y + h * 0.2, Math.max(2, h * 0.12), h * 0.6);
      ctx.textAlign = 'left';
      const label = `${p.name} ${p.score}`;
      ctx.font = k.font('Cormorant', k.fitSize(ctx, label, 'Cormorant', w - h * 0.5, h * 0.7));
      ctx.fillStyle = k.IVORY;
      ctx.fillText(label, x + h * 0.35, y + h / 2);
    });
    return Math.ceil(Math.min(list.length, 8) / 4) * h;
  }

  // ------------------------------------------------------------ brick breaker

  function breaker(canvas, W, H, opts) {
    const g = setup(canvas, W, H, opts);
    const { ctx, k, s } = g;
    let area = g.frame('BRICK BREAKER');
    let phase = 'attract', level = 1, score = 0, lives = 3, now = 0, banner = null, overAt = 0;
    let bricks = [], balls = [], drops = [], wideUntil = 0, slowUntil = 0, serveAt = 0;
    const paddle = { x: 0.5, target: 0.5 };
    const r = Math.max(2, s * 0.013);

    function pattern(r0, c, rows, cols) {
      const mid = (cols - 1) / 2;
      switch ((level - 1) % 4) {
        case 1: return Math.abs(c - mid) <= r0 + 1;                     // stepped ziggurat
        case 2: return (r0 + c) % 2 === 0 || r0 === 0;                  // checkerboard
        case 3: return r0 === 0 || Math.abs(c - mid) >= (rows - r0) / 1.4; // chevron
        default: return true;
      }
    }
    function layout() {
      const cols = Math.max(5, Math.min(14, Math.round(area.w / (s * 0.12))));
      const rows = area.h > area.w ? 7 : 5;
      const bw = area.w / cols, bh = Math.max(3, Math.round(area.h * 0.045));
      bricks = [];
      for (let r0 = 0; r0 < rows; r0++) {
        for (let c = 0; c < cols; c++) {
          if (pattern(r0, c, rows, cols)) {
            bricks.push({ x: area.x + c * bw, y: area.y + area.h * 0.1 + r0 * bh, w: bw, h: bh, hits: r0 === 0 ? 2 : 1, gold: r0 === 0, color: JEWELS[r0 % JEWELS.length] });
          }
        }
      }
    }
    const speed = () => area.h * (0.7 + level * 0.06) * (now < slowUntil ? 0.65 : 1);
    function serve() { balls = [{ x: 0, y: 0, vx: 0, vy: 0, stuck: true }]; drops = []; serveAt = now + 2.5; }
    function launch(b) {
      const a = (Math.random() - 0.5) * 0.9, sp = speed();
      Object.assign(b, { vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp, stuck: false });
    }
    function newGame() { level = 1; score = 0; lives = 3; wideUntil = slowUntil = 0; layout(); serve(); phase = 'play'; }
    layout();
    serve();

    function physics(dt) {
      const pw = area.w * (now < wideUntil ? 0.3 : 0.2);
      const ph = Math.max(3, Math.round(area.h * 0.025));
      const px = area.x + pw / 2 + (area.w - pw) * paddle.x;
      const py = area.y + area.h - ph - area.h * 0.02;
      for (const b of balls) {
        if (b.stuck) {
          b.x = px; b.y = py - r - 1;
          if (now > serveAt) launch(b);
          continue;
        }
        const steps = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy) * dt) / r));
        for (let i = 0; i < steps; i++) {
          b.x += (b.vx * dt) / steps;
          b.y += (b.vy * dt) / steps;
          if (b.x < area.x + r) { b.x = area.x + r; b.vx = Math.abs(b.vx); }
          if (b.x > area.x + area.w - r) { b.x = area.x + area.w - r; b.vx = -Math.abs(b.vx); }
          if (b.y < area.y + r) { b.y = area.y + r; b.vy = Math.abs(b.vy); }
          if (b.vy > 0 && b.y + r >= py && b.y - r <= py + ph && Math.abs(b.x - px) <= pw / 2 + r) {
            const a = Math.max(-1, Math.min(1, (b.x - px) / (pw / 2))) * 1.05;
            const sp = Math.min(speed() * 1.6, Math.hypot(b.vx, b.vy) * 1.02);
            b.vx = Math.sin(a) * sp; b.vy = -Math.cos(a) * sp; b.y = py - r;
          }
          for (const br of bricks) {
            if (br.hits <= 0 || b.x + r < br.x || b.x - r > br.x + br.w || b.y + r < br.y || b.y - r > br.y + br.h) continue;
            const ox = Math.min(b.x + r - br.x, br.x + br.w - (b.x - r));
            const oy = Math.min(b.y + r - br.y, br.y + br.h - (b.y - r));
            if (ox < oy) b.vx = -b.vx; else b.vy = -b.vy;
            br.hits--;
            if (phase === 'play') score += br.gold ? 25 : 10;
            if (br.hits <= 0 && Math.random() < 0.14) drops.push({ x: br.x + br.w / 2, y: br.y, kind: ['W', 'M', 'S'][(Math.random() * 3) | 0] });
            break;
          }
        }
      }
      for (const d of drops) {
        d.y += area.h * 0.28 * dt;
        if (d.y >= py && d.y <= py + ph * 2 && Math.abs(d.x - px) <= pw / 2) {
          d.y = Infinity;
          if (d.kind === 'W') wideUntil = now + 15;
          if (d.kind === 'S') slowUntil = now + 10;
          if (d.kind === 'M') {
            const src = balls.find((b) => !b.stuck);
            if (src) for (const a of [-0.5, 0.5]) { const sp = Math.hypot(src.vx, src.vy); balls.push({ x: src.x, y: src.y, vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp, stuck: false }); }
          }
        }
      }
      drops = drops.filter((d) => d.y < area.y + area.h);
      balls = balls.filter((b) => b.y - r < area.y + area.h);
      if (!balls.length) {
        if (phase === 'play' && --lives <= 0) { phase = 'over'; overAt = now; }
        serve();
      }
      if (!bricks.some((b) => b.hits > 0)) {
        if (phase === 'play') { level++; banner = { text: `LEVEL ${level}`, until: now + 2 }; }
        layout();
        serve();
      }
      return { pw, ph, px, py };
    }

    function draw(geo) {
      for (const br of bricks) {
        if (br.hits <= 0) continue;
        ctx.fillStyle = br.gold ? k.gold(ctx, br.x, br.y, br.x + br.w, br.y + br.h, 0.45) : br.color;
        ctx.fillRect(br.x + 1, br.y + 1, br.w - 2, br.h - 2);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(br.x + 1, br.y + 1, br.w - 2, Math.max(1, br.h * 0.22));
        if (br.gold && br.hits === 1) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(br.x + 1, br.y + br.h * 0.5, br.w - 2, br.h * 0.5 - 1); }
      }
      for (const d of drops) {
        ctx.fillStyle = d.kind === 'W' ? '#2fd39a' : d.kind === 'M' ? '#ff4d6a' : '#5aa2ff';
        k.roundRect(ctx, d.x - r * 1.8, d.y - r, r * 3.6, r * 2, r);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = k.font('Cormorant', r * 1.8);
        ctx.fillText(d.kind, d.x, d.y + 1);
      }
      ctx.fillStyle = k.gold(ctx, geo.px - geo.pw / 2, 0, geo.px + geo.pw / 2, 0, 0.5);
      k.roundRect(ctx, geo.px - geo.pw / 2, geo.py, geo.pw, geo.ph, geo.ph / 2);
      ctx.fill();
      ctx.fillStyle = k.IVORY;
      for (const b of balls) k.glow(ctx, '#fff3cf', r * 2, () => { ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill(); });
      ctx.fillStyle = k.GOLD;
      for (let i = 0; i < lives && phase === 'play'; i++) {
        const cx = area.x + area.w - r * 2 - i * r * 3.2, cy = area.y + r * 1.5;
        ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.fill();
      }
    }

    const stop = loop((dt, t) => {
      now = t;
      for (const m of g.drain()) {
        if (m.kind === 'move') paddle.target = m.x;
        if (m.kind === 'start' || m.kind === 'tap') {
          if (phase !== 'play') newGame();
          else balls.forEach((b) => { if (b.stuck) launch(b); });
        }
      }
      if (phase !== 'play') {
        const b = balls[0];
        if (b) paddle.target = Math.max(0, Math.min(1, (b.x - area.x) / area.w + Math.sin(t) * 0.05));
      }
      paddle.x += (paddle.target - paddle.x) * Math.min(1, dt * 16);
      area = g.frame(phase === 'play' ? `LEVEL ${level} · ${score}` : 'BRICK BREAKER');
      const geo = physics(dt);
      draw(geo);
      if (banner && t < banner.until) card(g, { x: area.x, y: area.y + area.h * 0.35, w: area.w, h: area.h * 0.25 }, banner.text, [], 0.9);
      if (phase === 'attract') card(g, area, 'BRICK BREAKER', ['Slide your finger on your phone to move', 'Tap Start to play', ...joinLines(g)], 0.96);
      if (phase === 'over') {
        card(g, area, 'GAME OVER', [[`SCORE ${score}`, k.GOLD_LIGHT], `Level ${level}`, '', 'Tap Start to play again'], 0.96);
        if (t - overAt > 30) phase = 'attract';
      }
      g.report({
        game: 'breaker', phase,
        message: phase === 'play' ? `Level ${level} · Score ${score} · Lives ${lives}` : phase === 'over' ? `Game over. Score ${score}.` : 'Tap Start to play.',
      }, t);
      g.flush(t);
    });
    return { stop() { stop(); g.off(); } };
  }

  // ------------------------------------------------------------ deco duel

  // Two paddles facing each other along the wall's long side. Player 1 is nearest the floor on a
  // tall wall, or on the left on a wide one. With one player, the Pi plays the other side.
  function duel(canvas, W, H, opts) {
    const g = setup(canvas, W, H, opts);
    const { ctx, k, s } = g;
    let area = g.frame('DECO DUEL');
    const tall = area.h >= area.w;
    let phase = 'attract', now = 0, serveAt = 0, overAt = 0, winner = -1, flash = null;
    const score = [0, 0];
    const pads = [{ u: 0.5, target: 0.5 }, { u: 0.5, target: 0.5 }];
    let ball = { u: 0, v: 0, vu: 0, vv: 0, live: false }, trail = [];
    const TO_WIN = 7;
    const A = () => (tall ? area.w : area.h); // across
    const L = () => (tall ? area.h : area.w); // along
    const r = Math.max(2, s * 0.014);
    const seats = () => g.players.slice().sort((a, b) => a.slot - b.slot).slice(0, 2);

    function toScreen(u, v) { return tall ? [area.x + u, area.y + area.h - v] : [area.x + v, area.y + u]; }
    function serve(toward) {
      ball = { u: A() / 2, v: L() / 2, vu: 0, vv: 0, live: false, toward };
      serveAt = now + 1.4;
      trail = [];
    }
    function newGame() { score[0] = score[1] = 0; phase = 'play'; winner = -1; serve(Math.random() < 0.5 ? 0 : 1); }
    serve(0);

    const stop = loop((dt, t) => {
      now = t;
      const seated = seats();
      for (const m of g.drain()) {
        const i = seated.findIndex((p) => p.slot === m.slot);
        if (m.kind === 'move' && i >= 0) pads[i].target = m.x;
        if ((m.kind === 'start' || m.kind === 'tap') && phase !== 'play') newGame();
      }
      area = g.frame(phase === 'play' ? `${score[0]} – ${score[1]}` : 'DECO DUEL');
      const a = A(), l = L();
      const pw = a * 0.22, ph = Math.max(3, Math.round(l * 0.025)), off = l * 0.04;
      // the Pi plays any empty seat (and both while nobody's playing)
      for (let i = 0; i < 2; i++) {
        if (phase === 'play' && seated[i]) continue;
        const coming = i === 0 ? ball.vv < 0 : ball.vv > 0;
        const aim = coming ? ball.u / a : 0.5;
        pads[i].target += Math.max(-dt * 0.9, Math.min(dt * 0.9, aim - pads[i].target));
      }
      for (const p of pads) p.u += (p.target - p.u) * Math.min(1, dt * 18);
      if (!ball.live && now > serveAt) {
        const ang = (Math.random() - 0.5) * 0.8, sp = l * 0.55;
        ball.vu = Math.sin(ang) * sp;
        ball.vv = Math.cos(ang) * sp * (ball.toward === 0 ? -1 : 1);
        ball.live = true;
      }
      if (ball.live) {
        const steps = Math.max(1, Math.ceil((Math.hypot(ball.vu, ball.vv) * dt) / r));
        for (let i = 0; i < steps; i++) {
          ball.u += (ball.vu * dt) / steps;
          ball.v += (ball.vv * dt) / steps;
          if (ball.u < r) { ball.u = r; ball.vu = Math.abs(ball.vu); }
          if (ball.u > a - r) { ball.u = a - r; ball.vu = -Math.abs(ball.vu); }
          for (let p = 0; p < 2; p++) {
            const centre = pw / 2 + (a - pw) * pads[p].u;
            const face = p === 0 ? off + ph : l - off - ph;
            const toward = p === 0 ? ball.vv < 0 : ball.vv > 0;
            const reached = p === 0 ? ball.v - r <= face && ball.v >= off - r : ball.v + r >= face && ball.v <= l - off + r;
            if (toward && reached && Math.abs(ball.u - centre) <= pw / 2 + r) {
              const hit = Math.max(-1, Math.min(1, (ball.u - centre) / (pw / 2)));
              const sp = Math.min(l * 1.6, Math.hypot(ball.vu, ball.vv) * 1.07);
              ball.vu = Math.sin(hit) * sp;
              ball.vv = Math.cos(hit) * sp * (p === 0 ? 1 : -1);
              ball.v = p === 0 ? face + r : face - r;
            }
          }
        }
        trail.push([ball.u, ball.v]);
        if (trail.length > 8) trail.shift();
        const out = ball.v < -r * 2 ? 1 : ball.v > l + r * 2 ? 0 : -1;
        if (out >= 0) {
          if (phase === 'play') {
            score[out]++;
            flash = { side: out, until: now + 0.6 };
            if (score[out] >= TO_WIN) { phase = 'over'; winner = out; overAt = now; }
          }
          serve(out === 0 ? 1 : 0);
        }
      }

      // court: centre line with a diamond, faint scores in each half
      const [mx0, my0] = toScreen(0, l / 2), [mx1, my1] = toScreen(a, l / 2);
      ctx.strokeStyle = k.rgba(k.GOLD, 0.5);
      ctx.lineWidth = Math.max(1, s * 0.004);
      ctx.setLineDash([s * 0.02, s * 0.02]);
      ctx.beginPath(); ctx.moveTo(mx0, my0); ctx.lineTo(mx1, my1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = k.font('Poiret One', Math.min(a, l / 2) * 0.45);
      for (let p = 0; p < 2; p++) {
        const [sx, sy] = toScreen(a / 2, p === 0 ? l * 0.25 : l * 0.75);
        ctx.fillStyle = flash && flash.side === p && now < flash.until ? k.GOLD_LIGHT : 'rgba(212,176,106,0.14)';
        ctx.fillText(String(score[p]), sx, sy);
      }
      // paddles in each player's colour
      for (let p = 0; p < 2; p++) {
        const centre = pw / 2 + (a - pw) * pads[p].u;
        const vFrom = p === 0 ? off : l - off - ph;
        const [x0, y0] = toScreen(centre - pw / 2, vFrom + (tall ? ph : 0));
        const color = phase === 'play' && seated[p] ? seated[p].color : k.GOLD;
        ctx.fillStyle = color;
        k.roundRect(ctx, x0, y0, tall ? pw : ph, tall ? ph : pw, ph / 2);
        ctx.fill();
      }
      trail.forEach(([u, v], i) => {
        const [x, y] = toScreen(u, v);
        ctx.fillStyle = k.rgba(k.GOLD, (i + 1) / trail.length * 0.35);
        ctx.beginPath(); ctx.arc(x, y, r * (0.5 + i / trail.length * 0.5), 0, Math.PI * 2); ctx.fill();
      });
      const [bx, by] = toScreen(ball.u, ball.v);
      ctx.fillStyle = k.IVORY;
      k.glow(ctx, '#fff3cf', r * 2, () => { ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill(); });

      const names = [seated[0] ? seated[0].name : 'THE HOUSE', seated[1] ? seated[1].name : 'THE HOUSE'];
      if (phase === 'attract') card(g, area, 'DECO DUEL', ['Two players, one ball. First to 7.', 'Slide on your phone to move your paddle', 'Play alone and the house plays you', ...joinLines(g)], 0.96);
      if (phase === 'over') {
        card(g, area, `${names[winner]} WINS`, [[`${score[0]} – ${score[1]}`, k.GOLD_LIGHT], '', 'Tap Start for a rematch'], 0.96);
        if (now - overAt > 30) phase = 'attract';
      }
      const where = tall ? ['bottom', 'top'] : ['left', 'right'];
      g.report({
        game: 'duel', phase,
        message: phase === 'play' ? `${names[0]} ${score[0]} – ${score[1]} ${names[1]}` : phase === 'over' ? `${names[winner]} wins ${score[0]} – ${score[1]}.` : 'Tap Start to play.',
        seats: seated.map((p, i) => ({ slot: p.slot, side: where[i] })),
      }, t);
      g.flush(t);
    });
    return { stop() { stop(); g.off(); } };
  }

  // ------------------------------------------------------------ serpentine (snake)

  function serpentine(canvas, W, H, opts) {
    const g = setup(canvas, W, H, opts);
    const { ctx, k, s } = g;
    let area = g.frame('SERPENTINE');
    const cell = Math.max(3, Math.round(s / 26));
    const cols = Math.max(8, Math.floor(area.w / cell)), rows = Math.max(8, Math.floor(area.h / cell));
    const ox = () => area.x + Math.floor((area.w - cols * cell) / 2), oy = () => area.y + Math.floor((area.h - rows * cell) / 2);
    const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const snakes = new Map(); // slot -> snake
    let food = [], now = 0, nextStep = 0, best = { name: '', score: 0 };
    const demo = { slot: -1, body: [], dir: 'right', queue: [], alive: false, respawnAt: 0, score: 0 };

    const occupied = (x, y) => [...snakes.values(), demo].some((sn) => sn.alive && sn.body.some(([bx, by]) => bx === x && by === y));
    function freeCell() {
      for (let i = 0; i < 200; i++) {
        const x = (Math.random() * cols) | 0, y = (Math.random() * rows) | 0;
        if (!occupied(x, y) && !food.some((f) => f.x === x && f.y === y)) return [x, y];
      }
      return [0, 0];
    }
    function spawn(sn) {
      const [x, y] = freeCell();
      const dir = x < cols / 2 ? 'right' : 'left';
      const [dx] = DIRS[dir];
      sn.body = [[x, y], [x - dx, y], [x - dx * 2, y]].map(([a, b]) => [Math.max(0, Math.min(cols - 1, a)), b]);
      Object.assign(sn, { dir, queue: [], alive: true, score: 0 });
    }
    function topUpFood() {
      while (food.filter((f) => !f.coin).length < 3) { const [x, y] = freeCell(); food.push({ x, y, coin: false }); }
      if (!food.some((f) => f.coin) && Math.random() < 0.004) { const [x, y] = freeCell(); food.push({ x, y, coin: true, until: now + 8 }); }
      food = food.filter((f) => !f.coin || f.until > now);
    }
    function steer(sn, dir) {
      const last = sn.queue.length ? sn.queue[sn.queue.length - 1] : sn.dir;
      const [lx, ly] = DIRS[last], [dx, dy] = DIRS[dir];
      if (lx + dx === 0 && ly + dy === 0) return;
      if (sn.queue.length < 3) sn.queue.push(dir);
    }
    function demoBrain() {
      if (!demo.alive) return;
      const [hx, hy] = demo.body[0];
      const target = food[0] || { x: cols / 2, y: rows / 2 };
      const options = Object.keys(DIRS).filter((d) => {
        const [dx, dy] = DIRS[d], [cx, cy] = DIRS[demo.dir];
        if (dx + cx === 0 && dy + cy === 0) return false;
        const nx = hx + dx, ny = hy + dy;
        return nx >= 0 && ny >= 0 && nx < cols && ny < rows && !occupied(nx, ny);
      });
      options.sort((a, b) => {
        const d = (dir) => Math.abs(hx + DIRS[dir][0] - target.x) + Math.abs(hy + DIRS[dir][1] - target.y);
        return d(a) - d(b);
      });
      if (options.length) demo.dir = options[0];
    }
    function tick() {
      const all = [...snakes.values()].filter((sn) => sn.alive);
      if (!all.length) { if (!demo.alive) spawn(demo); demoBrain(); all.push(demo); } else demo.alive = false;
      for (const sn of all) {
        if (sn.queue.length) sn.dir = sn.queue.shift();
        const [dx, dy] = DIRS[sn.dir];
        const [hx, hy] = sn.body[0];
        sn.next = [hx + dx, hy + dy];
      }
      for (const sn of all) {
        const [nx, ny] = sn.next;
        const crash = nx < 0 || ny < 0 || nx >= cols || ny >= rows || all.some((o) => o.body.some(([bx, by], i) => bx === nx && by === ny && !(o === sn && i === o.body.length - 1)));
        if (crash) { sn.alive = false; sn.respawnAt = now + 3; continue; }
        sn.body.unshift([nx, ny]);
        const meal = food.findIndex((f) => f.x === nx && f.y === ny);
        if (meal >= 0) {
          const f = food.splice(meal, 1)[0];
          const grow = f.coin ? 3 : 1;
          sn.score += grow;
          for (let i = 1; i < grow; i++) sn.body.push(sn.body[sn.body.length - 1]);
          if (sn.slot >= 0 && sn.score > best.score) best = { name: g.name(sn.slot), score: sn.score };
        } else sn.body.pop();
      }
      topUpFood();
    }

    const stop = loop((dt, t) => {
      now = t;
      for (const m of g.drain()) {
        let sn = snakes.get(m.slot);
        if (!sn) { sn = { slot: m.slot, body: [], alive: false, respawnAt: 0, queue: [], score: 0, dir: 'right' }; snakes.set(m.slot, sn); }
        if (!sn.alive && (m.kind === 'start' || m.kind === 'tap' || m.kind === 'dir') && now >= sn.respawnAt) spawn(sn);
        else if (m.kind === 'dir' && DIRS[m.dir]) steer(sn, m.dir);
      }
      for (const slot of [...snakes.keys()]) if (!g.players.some((p) => p.slot === slot)) snakes.delete(slot);
      const longest = Math.max(3, ...[...snakes.values(), demo].map((sn) => sn.body.length));
      if (t >= nextStep) { tick(); nextStep = t + Math.max(0.06, 0.14 - longest * 0.002); }

      const playing = [...snakes.values()];
      area = g.frame(best.score ? `BEST ${best.name} ${best.score}` : 'SERPENTINE');
      const x0 = ox(), y0 = oy();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x0, y0, cols * cell, rows * cell);
      ctx.strokeStyle = k.rgba(k.GOLD, 0.6);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 0.5, y0 - 0.5, cols * cell + 1, rows * cell + 1);
      for (const f of food) {
        const cx = x0 + f.x * cell + cell / 2, cy = y0 + f.y * cell + cell / 2;
        if (f.coin) {
          ctx.fillStyle = k.gold(ctx, cx - cell / 2, cy - cell / 2, cx + cell / 2, cy + cell / 2, (t * 0.5) % 1);
          ctx.beginPath(); ctx.arc(cx, cy, cell * 0.45, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = '#e8173a';
          ctx.beginPath(); ctx.arc(cx, cy + cell * 0.08, cell * 0.36, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#2fd39a';
          ctx.beginPath(); ctx.moveTo(cx, cy - cell * 0.2); ctx.lineTo(cx + cell * 0.25, cy - cell * 0.45); ctx.stroke();
        }
      }
      for (const sn of [...playing, demo]) {
        if (!sn.alive) continue;
        const color = sn.slot >= 0 ? g.color(sn.slot) : k.GOLD;
        sn.body.forEach(([bx, by], i) => {
          ctx.fillStyle = i === 0 ? k.IVORY : color;
          ctx.globalAlpha = i === 0 ? 1 : Math.max(0.45, 1 - i / (sn.body.length + 4));
          ctx.fillRect(x0 + bx * cell + 1, y0 + by * cell + 1, cell - 2, cell - 2);
        });
        ctx.globalAlpha = 1;
      }
      const list = playing.map((sn) => ({ name: g.name(sn.slot), color: g.color(sn.slot), score: sn.alive ? sn.score : `${sn.score} ✕` }));
      if (list.length) scores(g, area, list, area.y);
      if (!playing.length) card(g, area, 'SERPENTINE', ['Everyone gets a snake. Eat cherries to grow.', 'Gold coins are worth three.', "Don't hit the walls or anyone else", ...joinLines(g)], 0.96);
      for (const p of g.players) {
        const sn = snakes.get(p.slot);
        if (sn && !sn.alive && sn.body.length) {
          // nothing extra to draw; the phone shows the respawn prompt
        }
      }
      g.report({
        game: 'snake', phase: playing.some((sn) => sn.alive) ? 'play' : 'attract',
        message: best.score ? `Best so far: ${best.name} with ${best.score}` : 'Tap Start, then steer with the arrows.',
        players: playing.map((sn) => ({ slot: sn.slot, score: sn.score, alive: sn.alive, wait: sn.alive ? 0 : Math.max(0, Math.ceil(sn.respawnAt - now)) })),
      }, t);
      g.flush(t);
    });
    return { stop() { stop(); g.off(); } };
  }

  // ------------------------------------------------------------ quick draw

  // Everyone waits; at a random moment the wall shouts DRAW and the first tap wins the round.
  // Tapping too early is a false start and costs a point. First to five takes it.
  function quickdraw(canvas, W, H, opts) {
    const g = setup(canvas, W, H, opts);
    const { ctx, k, s } = g;
    let area = g.frame('QUICK DRAW');
    let phase = 'attract', now = 0, drawAt = 0, until = 0, result = null, champion = null;
    const points = new Map();
    const TO_WIN = 5;

    function nextRound() { phase = 'ready'; drawAt = now + 2 + Math.random() * 3.5; result = null; }

    const stop = loop((dt, t) => {
      now = t;
      for (const m of g.drain()) {
        if (m.kind === 'start' && (phase === 'attract' || phase === 'over')) { points.clear(); champion = null; nextRound(); continue; }
        if (m.kind !== 'tap') continue;
        if (phase === 'attract' || phase === 'over') { points.clear(); champion = null; nextRound(); continue; }
        if (phase === 'ready') {
          points.set(m.slot, Math.max(0, (points.get(m.slot) || 0) - 1));
          result = { text: 'FALSE START', who: g.name(m.slot), color: g.color(m.slot) };
          phase = 'result';
          until = now + 2;
        } else if (phase === 'draw') {
          const ms = Math.round((now - drawAt) * 1000);
          const total = (points.get(m.slot) || 0) + 1;
          points.set(m.slot, total);
          result = { text: `${ms} MS`, who: g.name(m.slot), color: g.color(m.slot) };
          phase = 'result';
          until = now + 2.5;
          if (total >= TO_WIN) champion = { name: g.name(m.slot), color: g.color(m.slot) };
        }
      }
      if (phase === 'ready' && now >= drawAt) { phase = 'draw'; until = now + 3; }
      if (phase === 'draw' && now >= until) { result = { text: 'TOO SLOW', who: 'NOBODY', color: '#a59a84' }; phase = 'result'; until = now + 2; }
      if (phase === 'result' && now >= until) { if (champion) phase = 'over'; else nextRound(); }

      const flashing = phase === 'draw';
      if (flashing) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        k.sunburst(ctx, W / 2, H / 2, Math.hypot(W, H), 28, k.GOLD, 0.3, t * 0.6);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = k.font('Poiret One', k.fitSize(ctx, 'DRAW!', 'Poiret One', W * 0.85, H * 0.4));
        ctx.fillStyle = k.gold(ctx, 0, H * 0.3, W, H * 0.7, 0.5);
        ctx.fillText('DRAW!', W / 2, H / 2);
      } else {
        area = g.frame('QUICK DRAW');
        const board = g.players.map((p) => ({ name: p.name, color: p.color, score: points.get(p.slot) || 0 }));
        const used = scores(g, area, board, area.y) || 0;
        const mid = { x: area.x, y: area.y + used, w: area.w, h: area.h - used };
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (phase === 'ready') {
          const dots = '.'.repeat(1 + (Math.floor(t * 2) % 3));
          ctx.font = k.font('Poiret One', k.fitSize(ctx, 'STEADY...', 'Poiret One', mid.w * 0.8, mid.h * 0.22));
          ctx.fillStyle = k.IVORY;
          ctx.fillText(`STEADY${dots}`, mid.x + mid.w / 2, mid.y + mid.h / 2);
        }
        if (phase === 'result' && result) {
          ctx.font = k.font('Poiret One', k.fitSize(ctx, result.who, 'Poiret One', mid.w * 0.85, mid.h * 0.2));
          ctx.fillStyle = result.color;
          ctx.fillText(result.who, mid.x + mid.w / 2, mid.y + mid.h * 0.4);
          ctx.font = k.font('Cormorant', k.fitSize(ctx, result.text, 'Cormorant', mid.w * 0.8, mid.h * 0.16));
          ctx.fillStyle = k.GOLD_LIGHT;
          ctx.fillText(result.text, mid.x + mid.w / 2, mid.y + mid.h * 0.62);
        }
        if (phase === 'attract') card(g, area, 'QUICK DRAW', ['Wait for DRAW, then tap first.', 'Too early is a false start.', `First to ${TO_WIN} wins.`, ...joinLines(g)], 0.96);
        if (phase === 'over' && champion) card(g, area, `${champion.name} WINS`, [['FASTEST HANDS IN THE BASEMENT', k.GOLD_LIGHT], '', 'Tap to play again'], 0.96);
      }
      g.report({
        game: 'quickdraw', phase,
        message: phase === 'ready' ? 'Steady… wait for DRAW!' : phase === 'draw' ? 'DRAW! Tap now!' : phase === 'result' && result ? `${result.who}: ${result.text}` : phase === 'over' && champion ? `${champion.name} wins!` : 'Tap to start a match.',
        players: g.players.map((p) => ({ slot: p.slot, score: points.get(p.slot) || 0 })),
      }, t);
      g.flush(t);
    });
    return { stop() { stop(); g.off(); } };
  }

  const GAMES = { breaker, duel, snake: serpentine, quickdraw };

  window.BarGames = {
    create(name, canvas, W, H, opts) {
      canvas.width = W;
      canvas.height = H;
      if (!GAMES[name] && window.BarParty && window.BarParty.has(name)) return window.BarParty.create(name, canvas, W, H, opts);
      return (GAMES[name] || breaker)(canvas, W, H, opts);
    },
  };
})();
