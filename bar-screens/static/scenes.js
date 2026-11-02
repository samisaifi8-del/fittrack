// The Visuals channel's two scenes, each drawn at the wall's own pixel size:
//
//   city    a 1930s deco metropolis at night, in depth: a hazy far skyline, towers with lit gold
//           crowns, searchlights, a moon, an airship, an elevated train, rooftops with a neon
//           sign, and a river that reflects all of it.
//   jungle  a deco jungle at night: banana leaves, monstera and palm fronds in deep emerald with
//           gold veins, four layers deep (the back ones soft), birds of paradise, a breeze that
//           runs through in waves, dappled light and gold fireflies.
//
// Everything that doesn't change is drawn once into small canvases (sprites, building layers)
// and only moved, turned or faded each frame, so the Pi has little to do per frame.
(() => {
  'use strict';

  const GOLD = '#b89a63';

  function rng(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function offscreen(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    if (draw) draw(c.getContext('2d'), c.width, c.height);
    return c;
  }

  // A soft round glow, drawn once per size and colour.
  const glows = new Map();
  function glow(r, color, core) {
    const key = `${Math.round(r)}|${color}|${core}`;
    if (!glows.has(key)) {
      glows.set(key, offscreen(r * 2, r * 2, (x) => {
        const g = x.createRadialGradient(r, r, 0, r, r, r);
        g.addColorStop(0, rgba(color, core));
        g.addColorStop(0.35, rgba(color, core * 0.35));
        g.addColorStop(1, rgba(color, 0));
        x.fillStyle = g;
        x.fillRect(0, 0, r * 2, r * 2);
      }));
    }
    return glows.get(key);
  }

  // The gold hairline set in from the edge, as on every channel.
  function frame(ctx, W, H) {
    const s = Math.min(W, H);
    const lw = Math.max(1, Math.round(s * 0.003));
    const inset = Math.max(2, Math.round(s * 0.025)) + lw / 2;
    ctx.strokeStyle = rgba(GOLD, 0.55);
    ctx.lineWidth = lw;
    ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
  }

  // ================================================================ the city

  // One band of skyline, wider than the wall so it can drift past and wrap round. Lit windows are
  // drawn in; the ones that flicker, the beacons and the neon sign are noted so each frame can
  // draw just those.
  function skylineLayer(W, H, base, o) {
    const rand = rng(o.seed);
    const s = Math.min(W, H);
    const Lw = Math.round(W * o.span);
    const meta = { flicker: [], beacons: [], signs: [], lamps: [] };
    const canvas = offscreen(Lw, H, (x) => {
      let bx = rand() * s * 0.04;
      let landmark = 0;
      while (bx < Lw - s * 0.08) {
        const special = o.landmarks && o.landmarks[landmark] && bx > Lw * o.landmarks[landmark].at;
        const kind = special ? o.landmarks[landmark++].kind : null;
        const bw = Math.round(kind ? s * 0.2 : s * (o.minW + rand() * o.addW));
        const bh = Math.round(kind ? H * o.maxH * 1.05 : H * (o.minH + rand() * (o.maxH - o.minH)));
        const top = base - bh;
        x.fillStyle = o.body;
        x.fillRect(Math.round(bx), top, bw, bh + 1);
        // setbacks: narrower tiers stacked on top, deco style
        let tx = bx, tw = bw, ty = top;
        const tiers = kind ? 0 : (rand() * 3) | 0;
        for (let k = 0; k < tiers; k++) {
          const nw = Math.round(tw * (0.55 + rand() * 0.2)), nh = Math.round(bh * (0.05 + rand() * 0.08));
          tx += (tw - nw) / 2; ty -= nh; tw = nw;
          x.fillRect(Math.round(tx), ty, tw, nh + 1);
        }
        if (!kind && rand() < 0.3) { // a mast, sometimes with a red beacon
          const mh = Math.round(bh * 0.14);
          x.fillRect(Math.round(tx + tw / 2) - 1, ty - mh, 2, mh);
          if (o.beacons && rand() < 0.6) meta.beacons.push({ x: Math.round(tx + tw / 2), y: ty - mh, ph: rand() * 3 });
        }
        if (kind) drawLandmark(x, kind, bx, top, bw, bh, s, meta, o);
        // windows: a grid, some lit
        const ws = Math.max(1, Math.round(s * o.win));
        for (let wy = top + ws * 2; wy < base - ws * 2; wy += ws * 3) {
          for (let wx = bx + ws * 1.5; wx < bx + bw - ws * 1.5; wx += ws * 2.4) {
            if (rand() < o.lit) {
              const warm = rand();
              x.fillStyle = warm < 0.75 ? o.windowA : o.windowB;
              x.fillRect(Math.round(wx), Math.round(wy), ws, Math.max(1, Math.round(ws * 1.3)));
              if (o.flicker && rand() < o.flicker) meta.flicker.push({ x: Math.round(wx), y: Math.round(wy), w: ws, h: Math.max(1, Math.round(ws * 1.3)), rate: 0.05 + rand() * 0.2, ph: rand() * 10 });
            }
          }
        }
        if (o.sign && !meta.signs.length && bx > Lw * 0.35 && bh < H * 0.2) meta.signs.push({ x: Math.round(bx + bw / 2), y: top - Math.round(s * 0.04), w: bw });
        bx += bw + (rand() < 0.3 ? Math.round(s * 0.012) : 0);
      }
      if (o.haze) { // atmospheric haze: lighter towards the ground
        const g = x.createLinearGradient(0, base - H * o.maxH, 0, base);
        g.addColorStop(0, 'rgba(40,40,80,0)');
        g.addColorStop(1, o.haze);
        x.globalCompositeOperation = 'source-atop';
        x.fillStyle = g;
        x.fillRect(0, 0, Lw, base);
        x.globalCompositeOperation = 'source-over';
      }
      if (o.embankment) { // the river wall and its lamps
        x.fillStyle = '#050407';
        x.fillRect(0, base - 2, Lw, H - base + 2);
        for (let lx = s * 0.05; lx < Lw; lx += s * 0.11) meta.lamps.push({ x: Math.round(lx), y: base - Math.round(s * 0.03) });
        x.fillStyle = '#0c0a10';
        for (const l of meta.lamps) x.fillRect(l.x, l.y, 1, base - l.y);
      }
    });
    return { canvas, Lw, meta, speed: o.speed };
  }

  // The landmark towers, after the 1930s ones: a crown of stepped sunburst arches lit gold, a
  // tower with setbacks and a mast, and a tower of tall gold fins.
  function drawLandmark(x, kind, bx, top, bw, bh, s, meta, o) {
    const cx = bx + bw / 2;
    if (kind === 'arches') {
      // the shaft narrows into the crown
      const cw = bw * 0.55, ch = bh * 0.2;
      x.fillStyle = o.body;
      x.fillRect(Math.round(cx - cw / 2), Math.round(top - ch), Math.round(cw), Math.round(ch) + 1);
      const halo = x.createRadialGradient(cx, top - ch * 0.4, 0, cx, top - ch * 0.4, bw * 0.9);
      halo.addColorStop(0, 'rgba(240,200,120,0.28)');
      halo.addColorStop(1, 'rgba(240,200,120,0)');
      x.fillStyle = halo;
      x.fillRect(cx - bw, top - ch - bw, bw * 2, bw * 2);
      // five diminishing arches, each a gold line with triangular windows
      for (let k = 0; k < 5; k++) {
        const r = cw * 0.5 * (1 - k * 0.17);
        const ay = top - ch * (0.15 + k * 0.17);
        x.fillStyle = o.body;
        x.beginPath(); x.arc(cx, ay, r, Math.PI, 0); x.closePath(); x.fill();
        x.strokeStyle = k % 2 ? '#f2d58f' : '#d7b166';
        x.lineWidth = 1;
        x.beginPath(); x.arc(cx, ay, r, Math.PI, 0); x.stroke();
        x.fillStyle = '#f6dfa0';
        for (let a = 1; a < 6; a++) {
          const ang = Math.PI + (a / 6) * Math.PI;
          const px = cx + Math.cos(ang) * r * 0.75, py = ay + Math.sin(ang) * r * 0.75;
          x.beginPath(); x.moveTo(px, py - 2); x.lineTo(px - 1.2, py + 1); x.lineTo(px + 1.2, py + 1); x.closePath(); x.fill();
        }
      }
      // the needle
      x.fillStyle = '#cfae6c';
      x.beginPath(); x.moveTo(cx - 1.5, top - ch * 0.95); x.lineTo(cx, top - ch * 0.95 - bh * 0.22); x.lineTo(cx + 1.5, top - ch * 0.95); x.closePath(); x.fill();
    } else if (kind === 'setbacks') {
      let tw = bw, ty = top;
      x.fillStyle = o.body;
      for (let k = 0; k < 4; k++) {
        const nw = tw * 0.72, nh = bh * 0.07;
        ty -= nh; tw = nw;
        x.fillRect(Math.round(cx - tw / 2), Math.round(ty), Math.round(tw), Math.round(nh) + 1);
        // floodlit ledges
        x.fillStyle = 'rgba(240,210,150,0.55)';
        x.fillRect(Math.round(cx - tw / 2), Math.round(ty), Math.round(tw), 1);
        x.fillStyle = o.body;
      }
      const mh = bh * 0.28;
      x.fillRect(Math.round(cx - 1.5), Math.round(ty - mh), 3, Math.round(mh));
      const g = x.createLinearGradient(0, ty - mh, 0, ty);
      g.addColorStop(0, 'rgba(255,230,170,0.0)');
      g.addColorStop(1, 'rgba(255,230,170,0.35)');
      x.fillStyle = g;
      x.fillRect(Math.round(cx - 3), Math.round(ty - mh), 6, Math.round(mh));
      meta.beacons.push({ x: Math.round(cx), y: Math.round(ty - mh), ph: 0, big: true });
    } else if (kind === 'fins') {
      x.fillStyle = o.body;
      x.fillRect(Math.round(bx + bw * 0.1), Math.round(top - bh * 0.1), Math.round(bw * 0.8), Math.round(bh * 0.1) + 1);
      for (let k = 0; k < 5; k++) {
        const fx = bx + bw * (0.18 + k * 0.16);
        const g = x.createLinearGradient(0, top - bh * 0.18, 0, top + bh * 0.5);
        g.addColorStop(0, 'rgba(250,215,140,0.95)');
        g.addColorStop(1, 'rgba(250,215,140,0)');
        x.fillStyle = g;
        x.fillRect(Math.round(fx), Math.round(top - bh * 0.18), 2, Math.round(bh * 0.68));
      }
    }
  }

  // The airship, drawn once: a long hull lit faintly from above, fins, and a gondola with lit windows.
  function airship(len) {
    const h = len * 0.26;
    return offscreen(len * 1.1, h * 1.7, (x) => {
      const cx = len * 0.52, cy = h * 0.6;
      const g = x.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
      g.addColorStop(0, '#3a3c52');
      g.addColorStop(0.35, '#16182a');
      g.addColorStop(1, '#07080f');
      x.fillStyle = g;
      x.beginPath(); x.ellipse(cx, cy, len * 0.48, h / 2, 0, 0, Math.PI * 2); x.fill();
      // panel lines
      x.strokeStyle = 'rgba(120,124,160,0.25)';
      x.lineWidth = 1;
      for (let k = 1; k < 7; k++) {
        const px = cx - len * 0.48 + (len * 0.96 * k) / 7;
        x.beginPath(); x.moveTo(px, cy - h * 0.48 * Math.sqrt(1 - ((px - cx) / (len * 0.48)) ** 2)); x.lineTo(px, cy + h * 0.48 * Math.sqrt(1 - ((px - cx) / (len * 0.48)) ** 2)); x.stroke();
      }
      // tail fins
      x.fillStyle = '#0c0d18';
      const tx = cx + len * 0.4;
      x.beginPath(); x.moveTo(tx - len * 0.06, cy - h * 0.2); x.lineTo(tx + len * 0.1, cy - h * 0.75); x.lineTo(tx + len * 0.1, cy - h * 0.1); x.closePath(); x.fill();
      x.beginPath(); x.moveTo(tx - len * 0.06, cy + h * 0.2); x.lineTo(tx + len * 0.1, cy + h * 0.75); x.lineTo(tx + len * 0.1, cy + h * 0.1); x.closePath(); x.fill();
      // gondola with its windows
      x.fillStyle = '#0a0b14';
      x.fillRect(cx - len * 0.1, cy + h * 0.45, len * 0.2, h * 0.28);
      x.fillStyle = '#f4cf86';
      for (let k = 0; k < 5; k++) x.fillRect(Math.round(cx - len * 0.085 + k * len * 0.036), Math.round(cy + h * 0.53), Math.max(1, Math.round(len * 0.018)), Math.max(1, Math.round(h * 0.1)));
    });
  }

  function city(W, H, opts) {
    const s = Math.min(W, H);
    const rand = rng(W * 31 + H * 17);
    const water = Math.round(H * 0.8);
    const name = String((opts && opts.barName) || 'THE BASEMENT').toUpperCase();
    // with two walls the city runs across both as one panorama: the right wall is the next stretch
    const panX = opts && opts.side === 'right' ? W : 0;

    const sky = offscreen(W, H, (x) => {
      const g = x.createLinearGradient(0, 0, 0, water);
      g.addColorStop(0, '#02030a');
      g.addColorStop(0.45, '#070a1f');
      g.addColorStop(0.75, '#160f2c');
      g.addColorStop(0.92, '#3a1d22');
      g.addColorStop(1, '#5e2c1a');
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
    });
    const stars = Array.from({ length: 110 }, () => ({ x: rand() * W + (panX ? W * 0.37 : 0), y: rand() * water * 0.62, r: rand() < 0.12 ? 2 : 1, ph: rand() * 6, sp: 0.5 + rand() * 1.5 }));
    const moonR = Math.round(s * 0.075), moon = { x: W * 0.72 - panX, y: H * 0.15 };
    const moonImg = offscreen(moonR * 2 + 2, moonR * 2 + 2, (x) => {
      const g = x.createRadialGradient(moonR * 0.75, moonR * 0.7, moonR * 0.1, moonR, moonR, moonR);
      g.addColorStop(0, '#fbf3dc');
      g.addColorStop(1, '#cdbb8c');
      x.fillStyle = g;
      x.beginPath(); x.arc(moonR + 1, moonR + 1, moonR, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(120,100,70,0.16)';
      for (const [u, v, r] of [[0.6, 0.8, 0.22], [1.25, 0.6, 0.16], [1.0, 1.25, 0.26], [0.7, 1.35, 0.12]]) {
        x.beginPath(); x.arc(moonR * u + 1, moonR * v + 1, moonR * r, 0, Math.PI * 2); x.fill();
      }
    });
    const cloudStreaks = Array.from({ length: 4 }, (_, i) => ({
      img: offscreen(W * 0.9, s * 0.08, (x, w, h) => {
        x.filter = `blur(${Math.max(1, Math.round(s * 0.012))}px)`;
        x.fillStyle = 'rgba(28,30,58,0.85)';
        x.beginPath(); x.ellipse(w / 2, h / 2, w * 0.42, h * 0.22, 0, 0, Math.PI * 2); x.fill();
      }),
      y: H * (0.08 + i * 0.07 + rand() * 0.04), x: rand() * W * 2, v: W * (0.004 + rand() * 0.006),
    }));
    const lights = [0.18, 0.5, 0.84, 1.3, 1.7].map((p, i) => ({ x: W * p - panX, speed: 0.1 + i * 0.035, phase: i * 2.3, amp: 0.45 + (i % 3) * 0.05 }))
      .filter((L) => L.x > -W * 0.2 && L.x < W * 1.2);

    const far = skylineLayer(W, H, water - Math.round(H * 0.06), {
      seed: 11, span: 2, minW: 0.08, addW: 0.1, minH: 0.16, maxH: 0.4, body: '#141634', win: 0.006, lit: 0.05,
      windowA: '#4a4466', windowB: '#5a4a52', haze: 'rgba(90,70,110,0.55)', speed: W * 0.0035,
    });
    const mid = skylineLayer(W, H, water - Math.round(H * 0.025), {
      seed: 23, span: 2.5, minW: 0.1, addW: 0.12, minH: 0.12, maxH: 0.4, body: '#080920', win: 0.008, lit: 0.12,
      windowA: '#e9b968', windowB: '#f6dca6', flicker: 0.12, beacons: true, speed: W * 0.007,
      landmarks: [{ at: 0.12, kind: 'arches' }, { at: 0.48, kind: 'setbacks' }, { at: 0.78, kind: 'fins' }],
    });
    const near = skylineLayer(W, H, water, {
      seed: 37, span: 3, minW: 0.14, addW: 0.16, minH: 0.04, maxH: 0.15, body: '#030307', win: 0.009, lit: 0.12,
      windowA: '#d9a35a', windowB: '#f0c98a', flicker: 0.08, sign: true, embankment: true, speed: W * 0.012,
    });
    const ship = airship(s * 0.34);
    const shipLoop = 200;
    const trackY = Math.round(water - H * 0.17);
    const mist = Array.from({ length: 3 }, (_, i) => ({
      img: offscreen(W * 1.4, s * 0.12, (x, w, h) => {
        x.filter = `blur(${Math.max(2, Math.round(s * 0.02))}px)`;
        x.fillStyle = 'rgba(150,120,160,0.22)';
        x.beginPath(); x.ellipse(w / 2, h / 2, w * 0.45, h * 0.2, 0, 0, Math.PI * 2); x.fill();
      }),
      y: water - H * (0.06 + i * 0.045), x: rand() * W, v: W * (0.006 + i * 0.003),
    }));
    const signFont = `400 ${Math.max(7, Math.round(s * 0.034))}px "Poiret One", sans-serif`;

    // Drawn once, so a frame is mostly stamping: a searchlight beam (pointing up from its foot),
    // the neon sign lit and buzzing, the water's shading, and the river's mirror (refilled each
    // frame with one copy of the city above it).
    const beamLen = Math.hypot(W, H) * 1.1, beamW = Math.ceil(beamLen * Math.tan(0.07) * 2) + 2;
    const beam = offscreen(beamW, beamLen, (x, w, h) => {
      for (const [spread, alpha] of [[0.07, 0.07], [0.025, 0.12]]) {
        const g = x.createLinearGradient(0, h, 0, 0);
        g.addColorStop(0, `rgba(255,244,215,${alpha})`);
        g.addColorStop(1, 'rgba(255,244,215,0)');
        x.fillStyle = g;
        const half = Math.tan(spread) * h;
        x.beginPath(); x.moveTo(w / 2 - 1, h); x.lineTo(w / 2 - half, 0); x.lineTo(w / 2 + half, 0); x.lineTo(w / 2 + 1, h); x.closePath(); x.fill();
      }
    });
    const signs = [1, 0.35].map((a) => offscreen(W * 0.8, s * 0.1, (x, w, h) => {
      x.font = signFont;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.shadowColor = 'rgba(255,200,110,0.9)';
      x.shadowBlur = s * 0.02;
      x.fillStyle = `rgba(255,222,150,${a})`;
      x.fillText(name, w / 2, h / 2);
    }));
    let signFontsIn = false;
    const waterShade = offscreen(W, H - water, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(3,4,14,0.28)');
      g.addColorStop(1, 'rgba(3,4,14,0.7)');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
    const mirror = offscreen(W, H - water);
    const mctx = mirror.getContext('2d');
    const mirrorSpan = Math.min(water, Math.round((H - water) * 1.15));

    function drawLayer(ctx, L, t) {
      const off = (t * L.speed + panX) % L.Lw;
      ctx.drawImage(L.canvas, Math.round(-off), 0);
      if (L.Lw - off < W) ctx.drawImage(L.canvas, Math.round(L.Lw - off), 0);
      return off;
    }
    const each = (L, off, list, fn) => {
      for (const it of list) {
        for (const dx of [-off, L.Lw - off]) {
          const x = it.x + dx;
          if (x > -20 && x < W + 20) fn(it, Math.round(x));
        }
      }
    };

    return (ctx, t) => {
      ctx.drawImage(sky, 0, 0);
      // stars, twinkling; the moon with its halo; thin cloud drifting across it
      for (const st of stars) {
        const a = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * st.sp + st.ph));
        ctx.fillStyle = `rgba(236,232,220,${(a * 0.8).toFixed(3)})`;
        ctx.fillRect(Math.round(st.x), Math.round(st.y), st.r, st.r);
      }
      const mx = moon.x + Math.sin(t * 0.01) * s * 0.01;
      const halo = glow(moonR * 4, '#d8cfa8', 0.32);
      ctx.drawImage(halo, Math.round(mx - halo.width / 2), Math.round(moon.y - halo.height / 2));
      ctx.drawImage(moonImg, Math.round(mx - moonR - 1), Math.round(moon.y - moonR - 1));
      for (const c of cloudStreaks) {
        const span = W + c.img.width;
        const x = ((c.x + t * c.v) % span + span) % span - c.img.width;
        ctx.drawImage(c.img, Math.round(x), Math.round(c.y));
      }
      // searchlights sweeping behind the city: the one beam, turned for each light
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const by = water - H * 0.18;
      for (const L of lights) {
        ctx.setTransform(1, 0, 0, 1, L.x, by);
        ctx.rotate(Math.sin(t * L.speed + L.phase) * L.amp);
        ctx.drawImage(beam, -beam.width / 2, -beam.height);
      }
      ctx.restore();

      drawLayer(ctx, far, t);
      // the airship, crossing slowly between the far towers and the near ones
      const u = (t % shipLoop) / shipLoop;
      const sx = W * 2 + ship.width * 0.2 - u * (W * 2 + ship.width * 1.4) - panX, sy = H * 0.3 + Math.sin(t * 0.25) * s * 0.01;
      ctx.drawImage(ship, Math.round(sx), Math.round(sy));
      if (t % 1.6 < 0.18) ctx.drawImage(glow(s * 0.02, '#ff4a3a', 1), Math.round(sx + ship.width * 0.92 - s * 0.02), Math.round(sy + ship.height * 0.35 - s * 0.02));

      const mo = drawLayer(ctx, mid, t);
      each(mid, mo, mid.meta.flicker, (w, x) => {
        if (Math.sin(t * w.rate + w.ph) < -0.2) { ctx.fillStyle = '#080920'; ctx.fillRect(x, w.y, w.w, w.h); }
      });
      each(mid, mo, mid.meta.beacons, (b, x) => {
        const on = ((t + b.ph) % 1.5) < 0.6;
        if (on) { const gl = glow(s * (b.big ? 0.035 : 0.02), '#ff3a2a', 0.9); ctx.drawImage(gl, x - gl.width / 2, b.y - gl.height / 2); }
      });

      // the elevated train, every half minute or so: a ribbon of lit windows with a headlight
      ctx.fillStyle = '#05050b';
      ctx.fillRect(0, trackY, W, 2);
      const trainT = t % 32;
      if (trainT < 14) {
        const tw = s * 0.62, tx = -tw + (trainT / 14) * (W * 2 + tw * 1.4) - panX;
        ctx.fillStyle = '#0b0b16';
        ctx.fillRect(Math.round(tx), trackY - Math.round(s * 0.028), Math.round(tw), Math.round(s * 0.028));
        ctx.fillStyle = '#f2d08c';
        for (let k = 0; k < tw - 4; k += Math.max(3, Math.round(s * 0.016))) {
          if ((k / Math.max(3, Math.round(s * 0.016))) % 8 !== 7) ctx.fillRect(Math.round(tx + 2 + k), trackY - Math.round(s * 0.02), Math.max(1, Math.round(s * 0.009)), Math.max(1, Math.round(s * 0.01)));
        }
        const hl = glow(s * 0.05, '#fff1cc', 0.7);
        ctx.drawImage(hl, Math.round(tx + tw - hl.width * 0.3), Math.round(trackY - s * 0.014 - hl.height / 2));
      }

      // mist along the feet of the towers
      for (const m of mist) {
        const span = W + m.img.width;
        const x = ((m.x + t * m.v) % span + span) % span - m.img.width;
        ctx.drawImage(m.img, Math.round(x), Math.round(m.y - m.img.height / 2));
      }

      const no = drawLayer(ctx, near, t);
      each(near, no, near.meta.flicker, (w, x) => {
        if (Math.sin(t * w.rate + w.ph) < -0.3) { ctx.fillStyle = '#030307'; ctx.fillRect(x, w.y, w.w, w.h); }
      });
      // the riverside lamps
      each(near, no, near.meta.lamps, (l, x) => {
        const gl = glow(s * 0.025, '#ffd38a', 0.85);
        ctx.drawImage(gl, x - gl.width / 2, l.y - gl.height / 2);
      });
      // the bar's name in gold neon on a rooftop, buzzing now and then
      if (!signFontsIn && document.fonts && document.fonts.check(signFont)) {
        // the sign was drawn before Poiret One arrived: draw it again in the right type
        signFontsIn = true;
        signs.forEach((c, i) => {
          const x = c.getContext('2d');
          x.clearRect(0, 0, c.width, c.height);
          x.font = signFont; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.shadowColor = 'rgba(255,200,110,0.9)'; x.shadowBlur = s * 0.02;
          x.fillStyle = `rgba(255,222,150,${i ? 0.35 : 1})`;
          x.fillText(name, c.width / 2, c.height / 2);
        });
      }
      each(near, no, near.meta.signs, (sg, x) => {
        const lit = signs[Math.sin(t * 13) > 0.92 || (t % 11) < 0.12 ? 1 : 0];
        ctx.drawImage(lit, Math.round(x - lit.width / 2), Math.round(sg.y - lit.height / 2));
        ctx.fillStyle = '#030307';
        ctx.fillRect(x - Math.round(sg.w * 0.3), sg.y + Math.round(s * 0.018), 1, Math.round(s * 0.022));
        ctx.fillRect(x + Math.round(sg.w * 0.3), sg.y + Math.round(s * 0.018), 1, Math.round(s * 0.022));
      });

      // the river: the city upside down, rippling, darkened, with the moon's path on it
      // (one copy of the city above the water, flipped into the mirror; then the mirror laid on
      // the water in thin strips, each nudged sideways for the ripple)
      mctx.setTransform(1, 0, 0, -1, 0, mirror.height);
      mctx.clearRect(0, 0, W, mirror.height);
      mctx.drawImage(ctx.canvas, 0, water - mirrorSpan, W, mirrorSpan, 0, 0, W, mirror.height);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const strip = 3;
      for (let d = 0; d < mirror.height; d += strip) {
        const dx = Math.sin((water + d) * 0.55 + t * 2.4) * (0.6 + d * 0.06);
        ctx.drawImage(mirror, 0, d, W, strip, dx, water + d, W, strip);
      }
      ctx.restore();
      ctx.drawImage(waterShade, 0, water);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 9; k++) {
        const y = water + 3 + k * ((H - water) / 9);
        const w = s * (0.05 + 0.02 * Math.sin(t * 1.3 + k));
        ctx.fillStyle = `rgba(240,225,180,${(0.18 - k * 0.012).toFixed(3)})`;
        ctx.fillRect(Math.round(mx - w / 2 + Math.sin(t * 1.7 + k * 1.3) * s * 0.012), Math.round(y), Math.round(w), 1);
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(200,170,110,0.35)';
      ctx.fillRect(0, water, W, 1);
      frame(ctx, W, H);
    };
  }

  // ================================================================ the jungle

  // Leaves are drawn once, each into its own canvas with its base at a known pivot, then only
  // turned about that pivot as they sway. `shade` darkens a leaf for the layers behind.
  function leafSprite(kind, size, shade, blur, seed) {
    const rand = rng(seed);
    const pad = size * 0.15;
    const c = offscreen(size * 1.3 + pad * 2, size * 1.3 + pad * 2);
    const x = c.getContext('2d');
    const px = c.width / 2, py = c.height - pad;
    x.translate(px, py);
    if (kind === 'banana') bananaLeaf(x, size, rand);
    else if (kind === 'monstera') monsteraLeaf(x, size, rand);
    else if (kind === 'palm') palmFrond(x, size, rand);
    else if (kind === 'bird') birdOfParadise(x, size);
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (shade > 0) {
      x.globalCompositeOperation = 'source-atop';
      x.fillStyle = `rgba(1,8,10,${shade})`;
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'source-over';
    }
    if (!blur) return { img: c, px, py };
    const b = offscreen(c.width, c.height, (y) => { y.filter = `blur(${blur}px)`; y.drawImage(c, 0, 0); });
    return { img: b, px, py };
  }

  // A banana leaf pointing up from (0, 0): a stem, then a long blade along a curving midrib,
  // filled light at the rib and dark at the edge, with gold veins and the odd tear.
  function bananaLeaf(x, len, rand) {
    const width = len * (0.13 + rand() * 0.04), bend = (rand() - 0.5) * 0.5, N = 50, start = 0.14;
    const pts = [];
    let px = 0, py = 0;
    for (let i = 0; i <= N; i++) {
      const u = i / N, ang = bend * u * u;
      pts.push({ x: px, y: py, ang, u });
      px += Math.sin(ang) * (len / N);
      py -= Math.cos(ang) * (len / N);
    }
    const tears = Array.from({ length: 2 + ((rand() * 4) | 0) }, () => ({ at: 0.15 + rand() * 0.75, side: rand() < 0.5 ? 1 : -1, depth: 0.5 + rand() * 0.45 }));
    const half = (p, side) => {
      if (p.u < start) return 0;
      const v = (p.u - start) / (1 - start);
      let w = width * Math.pow(Math.sin(Math.PI * Math.min(1, v)), 0.55);
      for (const tr of tears) if (tr.side === side) w *= 1 - tr.depth * Math.exp(-(((v - tr.at) / 0.012) ** 2));
      return w;
    };
    const edge = (p, side) => [p.x + Math.cos(p.ang) * half(p, side) * side, p.y + Math.sin(p.ang) * half(p, side) * side];
    const blade = pts.filter((p) => p.u >= start);
    for (const side of [1, -1]) {
      // each half filled with a gradient across it, so the leaf has a fold down the middle
      const mid = blade[(blade.length / 2) | 0];
      const [ex, ey] = edge(mid, side);
      const g = x.createLinearGradient(mid.x, mid.y, ex, ey);
      g.addColorStop(0, side > 0 ? '#246240' : '#1a4f33');
      g.addColorStop(0.6, side > 0 ? '#0f4029' : '#0b3321');
      g.addColorStop(1, '#051a11');
      x.fillStyle = g;
      x.beginPath();
      blade.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
      for (let i = blade.length - 1; i >= 0; i--) { const [qx, qy] = edge(blade[i], side); x.lineTo(qx, qy); }
      x.closePath();
      x.fill();
    }
    // veins: fine gold lines sweeping out from the rib
    x.lineWidth = 0.7;
    for (let i = 2; i < blade.length - 2; i += 2) {
      const p = blade[i], q = blade[Math.min(blade.length - 1, i + 3)];
      for (const side of [1, -1]) {
        const [qx, qy] = edge(q, side);
        x.strokeStyle = 'rgba(214,180,105,0.28)';
        x.beginPath(); x.moveTo(p.x, p.y); x.lineTo(qx, qy); x.stroke();
      }
    }
    // the gold edge and rib
    x.strokeStyle = 'rgba(222,190,115,0.75)';
    x.lineWidth = 1;
    for (const side of [1, -1]) {
      x.beginPath();
      blade.forEach((p, i) => { const [qx, qy] = edge(p, side); if (i) x.lineTo(qx, qy); else x.moveTo(qx, qy); });
      x.stroke();
    }
    x.strokeStyle = '#e6c983';
    x.lineWidth = 1.6;
    x.beginPath();
    pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
    x.stroke();
  }

  // A monstera leaf on a long stalk: a broad heart, split from the edge towards the rib and
  // pierced with holes, glossy dark green with gold veins.
  function monsteraLeaf(x, size, rand) {
    const R = size * 0.42, stalk = size * 0.5, cy = -stalk - R * 0.85;
    x.strokeStyle = '#1d5a37';
    x.lineWidth = Math.max(2, size * 0.02);
    x.beginPath(); x.moveTo(0, 0); x.quadraticCurveTo(size * 0.04, -stalk * 0.5, 0, -stalk - R * 0.1); x.stroke();
    const blade = offscreen(R * 2.4, R * 2.4);
    const b = blade.getContext('2d');
    const bc = R * 1.2;
    const g = b.createRadialGradient(bc - R * 0.3, bc - R * 0.4, R * 0.1, bc, bc, R * 1.1);
    g.addColorStop(0, '#2a7549');
    g.addColorStop(0.55, '#114a2e');
    g.addColorStop(1, '#05231a');
    b.fillStyle = g;
    // the heart: a pointed tip at the top, two round lobes at the bottom either side of the stalk
    b.beginPath();
    b.moveTo(bc, bc + R * 0.55);
    b.bezierCurveTo(bc - R * 0.35, bc + R * 1.05, bc - R * 1.15, bc + R * 0.55, bc - R * 0.98, bc - R * 0.05);
    b.bezierCurveTo(bc - R * 0.85, bc - R * 0.65, bc - R * 0.35, bc - R * 0.98, bc, bc - R);
    b.bezierCurveTo(bc + R * 0.35, bc - R * 0.98, bc + R * 0.85, bc - R * 0.65, bc + R * 0.98, bc - R * 0.05);
    b.bezierCurveTo(bc + R * 1.15, bc + R * 0.55, bc + R * 0.35, bc + R * 1.05, bc, bc + R * 0.55);
    b.fill();
    b.globalCompositeOperation = 'destination-out';
    // splits from each side's edge in towards the rib (never at the tip or the lobes' foot), and
    // the holes between them
    // Fingers: each side is cut into broad fingers by narrow slits running from the edge in towards
    // the rib, with a small oval window near the rib between each pair of slits. Each finger has
    // a gold vein down its middle.
    const splits = 5;
    const cut = (side, k) => -Math.PI / 2 + side * (0.5 + (k / (splits - 1)) * 1.7);
    const rib = (a) => [bc + Math.cos(a) * R * 0.12, bc + Math.sin(a) * R * 0.12 + R * 0.08];
    for (const side of [1, -1]) {
      for (let k = 0; k < splits; k++) {
        const ang = cut(side, k);
        const inner = R * (0.42 + rand() * 0.12);
        b.lineWidth = Math.max(1.5, R * 0.035);
        b.lineCap = 'butt';
        b.beginPath();
        b.moveTo(bc + Math.cos(ang) * inner, bc + Math.sin(ang) * inner);
        b.lineTo(bc + Math.cos(ang) * R * 1.2, bc + Math.sin(ang) * R * 1.2);
        b.stroke();
        if (k < splits - 1 && rand() < 0.8) {
          const ha = (ang + cut(side, k + 1)) / 2, hr = R * 0.3;
          b.beginPath(); b.ellipse(bc + Math.cos(ha) * hr, bc + Math.sin(ha) * hr, R * 0.08, R * 0.035, ha, 0, Math.PI * 2); b.fill();
        }
      }
    }
    b.globalCompositeOperation = 'source-atop';
    b.strokeStyle = 'rgba(224,192,118,0.5)';
    b.lineWidth = 0.8;
    for (const side of [1, -1]) {
      for (let k = -1; k < splits; k++) {
        // the middle of each finger: between two slits (or beyond the first and last)
        const a = k < 0 ? cut(side, 0) - side * 0.2 : k === splits - 1 ? cut(side, k) + side * 0.2 : (cut(side, k) + cut(side, k + 1)) / 2;
        const [rx, ry] = rib(a);
        b.beginPath(); b.moveTo(rx, ry); b.lineTo(bc + Math.cos(a) * R, bc + Math.sin(a) * R); b.stroke();
      }
    }
    b.strokeStyle = 'rgba(230,200,130,0.8)';
    b.lineWidth = 1.3;
    b.beginPath(); b.moveTo(bc, bc + R * 0.55); b.lineTo(bc, bc - R * 0.95); b.stroke();
    // a sheen, as if the leaf were wet
    const sh = b.createLinearGradient(bc - R, bc - R, bc + R * 0.2, bc + R * 0.2);
    sh.addColorStop(0, 'rgba(255,255,255,0.12)');
    sh.addColorStop(0.4, 'rgba(255,255,255,0)');
    b.fillStyle = sh;
    b.fillRect(0, 0, blade.width, blade.height);
    b.globalCompositeOperation = 'source-over';
    x.save();
    x.translate(0, cy);
    x.rotate((rand() - 0.5) * 0.4);
    x.drawImage(blade, -bc, -bc);
    x.restore();
  }

  // A palm frond: a long arching stem with narrow leaflets down both sides, longest in the middle.
  function palmFrond(x, len, rand) {
    const curl = 0.35 + rand() * 0.25;
    const pts = [];
    let px = 0, py = 0;
    for (let i = 0; i <= 40; i++) {
      const u = i / 40, ang = curl * u * u;
      pts.push({ x: px, y: py, ang, u });
      px += Math.sin(ang) * (len / 40);
      py -= Math.cos(ang) * (len / 40);
    }
    x.strokeStyle = '#d9bb7a';
    x.lineWidth = 1.4;
    x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.stroke();
    for (let i = 4; i < pts.length - 1; i++) {
      const p = pts[i];
      const l = len * 0.32 * Math.sin(Math.PI * Math.min(1, (p.u - 0.08) / 0.95)) * (0.85 + rand() * 0.25);
      for (const side of [1, -1]) {
        const a = p.ang + side * (0.95 - p.u * 0.3) - 0.25;
        const ex = p.x + Math.sin(a) * l, ey = p.y - Math.cos(a) * l + l * 0.18;  // leaflets droop
        const g = x.createLinearGradient(p.x, p.y, ex, ey);
        g.addColorStop(0, '#2a7046');
        g.addColorStop(1, '#0a3020');
        x.strokeStyle = g;
        x.lineWidth = Math.max(1.2, len * 0.016);
        x.lineCap = 'round';
        x.beginPath(); x.moveTo(p.x, p.y); x.quadraticCurveTo((p.x + ex) / 2, (p.y + ey) / 2 - l * 0.12, ex, ey); x.stroke();
        x.strokeStyle = 'rgba(226,194,120,0.4)';
        x.lineWidth = 0.6;
        x.beginPath(); x.moveTo(p.x, p.y); x.quadraticCurveTo((p.x + ex) / 2, (p.y + ey) / 2 - l * 0.12, ex, ey); x.stroke();
      }
    }
  }

  // A bird of paradise flower on its stem: a green-and-purple beak, orange crest petals and the
  // blue tongue. The jungle's colour.
  function birdOfParadise(x, size) {
    const stem = size * 0.62;
    x.strokeStyle = '#2b6a40';
    x.lineWidth = Math.max(2, size * 0.025);
    x.beginPath(); x.moveTo(0, 0); x.lineTo(size * 0.02, -stem); x.stroke();
    x.save();
    x.translate(size * 0.02, -stem);
    x.rotate(-0.25);
    // the beak
    const bg = x.createLinearGradient(-size * 0.05, 0, size * 0.4, 0);
    bg.addColorStop(0, '#2d6a3e');
    bg.addColorStop(0.6, '#5a3a6a');
    bg.addColorStop(1, '#8a3d5a');
    x.fillStyle = bg;
    x.beginPath(); x.moveTo(-size * 0.04, 0); x.quadraticCurveTo(size * 0.2, -size * 0.07, size * 0.42, -size * 0.02); x.quadraticCurveTo(size * 0.2, size * 0.04, -size * 0.04, size * 0.03); x.closePath(); x.fill();
    // orange crest petals fanning up out of it
    for (const [ox, a, l] of [[0.12, -1.25, 0.34], [0.18, -1.0, 0.38], [0.24, -0.75, 0.32]]) {
      x.save();
      x.translate(size * ox, -size * 0.03);
      x.rotate(a);
      const pg = x.createLinearGradient(0, 0, size * l, 0);
      pg.addColorStop(0, '#e8701e');
      pg.addColorStop(1, '#ffb347');
      x.fillStyle = pg;
      x.beginPath(); x.moveTo(0, 0); x.quadraticCurveTo(size * l * 0.5, -size * 0.04, size * l, 0); x.quadraticCurveTo(size * l * 0.5, size * 0.03, 0, 0); x.fill();
      x.restore();
    }
    // the blue tongue
    x.save();
    x.translate(size * 0.2, -size * 0.04);
    x.rotate(-0.55);
    x.fillStyle = '#3a5fd0';
    x.beginPath(); x.moveTo(0, 0); x.lineTo(size * 0.26, -size * 0.02); x.lineTo(size * 0.2, size * 0.02); x.closePath(); x.fill();
    x.restore();
    x.restore();
  }

  function jungle(W, H) {
    const s = Math.min(W, H);
    const rand = rng(W * 13 + H * 7);
    // four layers, back to front: further leaves smaller, darker and softer
    const layers = [
      { n: 8, scale: 0.7, shade: 0.7, blur: 2, sway: 0.03 },
      { n: 7, scale: 0.85, shade: 0.45, blur: 1, sway: 0.04 },
      { n: 6, scale: 0.95, shade: 0.1, blur: 0, sway: 0.05 },
      { n: 2, scale: 1.15, shade: 0.62, blur: 0, sway: 0.065 },
    ];
    const kinds = ['banana', 'monstera', 'banana', 'palm', 'monstera', 'banana', 'palm'];
    const plants = [];
    layers.forEach((L, li) => {
      for (let i = 0; i < L.n; i++) {
        // half rise from the bottom corners, half hang from the top ones, leaving the middle dark
        const fromTop = (i + li) % 3 === 2;
        const left = (i + li) % 2 === 0;
        const kind = li === 3 ? (i === 1 ? 'monstera' : 'banana') : kinds[(i * 3 + li) % kinds.length];
        const size = H * (kind === 'monstera' ? 0.42 : kind === 'palm' ? 0.55 : 0.68) * L.scale * (0.85 + rand() * 0.3);
        const sp = leafSprite(kind, size, L.shade, L.blur, li * 100 + i * 7 + 3);
        // from the corners, growing up and out (or down and in from the top), so the middle stays clear
        const edge = li === 3 ? 0.12 : 0.26;
        const bx = left ? W * (-0.1 + rand() * edge) : W * (1.1 - rand() * edge);
        const by = fromTop ? -H * (0.02 + rand() * 0.05) : H * (1.02 + rand() * 0.05);
        const lean = (left ? 1 : -1) * (-0.1 + rand() * 0.45);
        plants.push({ sp, bx, by, angle: fromTop ? Math.PI - (left ? 1 : -1) * (0.35 + rand() * 0.4) : lean, sway: L.sway, ph: rand() * 6.28, layer: li });
      }
    });
    // the birds of paradise, among the middle layers
    for (const [px, py, lean] of [[0.2, 1.01, 0.18], [0.82, 1.02, -0.22]]) {
      plants.push({ sp: leafSprite('bird', H * 0.46, 0, 0, 911), bx: W * px, by: H * py, angle: lean, sway: 0.04, ph: rand() * 6, layer: 2.5 });
    }
    plants.sort((a, b) => a.layer - b.layer);
    const flies = Array.from({ length: 16 }, () => ({ x: rand(), y: 0.2 + rand() * 0.65, ph: rand() * 6.28, sp: 0.05 + rand() * 0.08, r: 0.6 + rand() * 0.8 }));
    const foliage = offscreen(W, H);
    const fx = foliage.getContext('2d');
    const backdrop = offscreen(W, H, (x) => {
      x.fillStyle = '#000';
      x.fillRect(0, 0, W, H);
      const g = x.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, H * 0.6);
      g.addColorStop(0, '#062018');
      g.addColorStop(1, '#000000');
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
    });
    const fly = glow(Math.max(3, s * 0.022), '#ffd98a', 1);
    const GUST = 14;

    return (ctx, t) => {
      ctx.drawImage(backdrop, 0, 0);
      // a shaft of moonlight from the top, breathing slowly
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const sh = ctx.createLinearGradient(W * 0.2, 0, W * 0.75, H);
      const a = 0.05 + 0.025 * Math.sin(t * 0.2);
      sh.addColorStop(0, `rgba(200,230,210,${a})`);
      sh.addColorStop(1, 'rgba(200,230,210,0)');
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.moveTo(W * 0.3, 0); ctx.lineTo(W * 0.62, 0); ctx.lineTo(W * 0.95, H); ctx.lineTo(W * 0.45, H); ctx.closePath(); ctx.fill();
      ctx.restore();

      // the leaves, each turning about its base: a gentle sway, and a gust that runs across
      // from left to right every so often
      fx.clearRect(0, 0, W, H);
      const g0 = (t % GUST) / GUST;
      for (const p of plants) {
        const along = p.bx / W;
        const gust = Math.exp(-(((g0 * 1.6 - 0.2 - along * 0.6) / 0.08) ** 2)) * 0.09;
        const turn = p.angle + p.sway * Math.sin(t * 0.5 + p.ph) + p.sway * 0.4 * Math.sin(t * 1.3 + p.ph * 2) + gust * (p.layer + 1) / 3;
        fx.save();
        fx.translate(p.bx, p.by);
        fx.rotate(turn);
        fx.drawImage(p.sp.img, -p.sp.px, -p.sp.py);
        fx.restore();
      }
      // dappled light drifting over the leaves (only the leaves catch it)
      fx.save();
      fx.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < 3; k++) {
        const lx = W * (0.5 + 0.45 * Math.sin(t * 0.07 + k * 2.1)), ly = H * (0.5 + 0.42 * Math.sin(t * 0.05 + k * 1.7));
        const lg = fx.createRadialGradient(lx, ly, 0, lx, ly, s * 0.45);
        lg.addColorStop(0, 'rgba(255,236,170,0.22)');
        lg.addColorStop(1, 'rgba(255,236,170,0)');
        fx.fillStyle = lg;
        fx.fillRect(0, 0, W, H);
      }
      fx.restore();
      ctx.drawImage(foliage, 0, 0);

      // gold fireflies wandering through the dark middle, glowing on and off
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const f of flies) {
        const x = W * (f.x + 0.12 * Math.sin(t * f.sp * 2 + f.ph) + 0.05 * Math.sin(t * f.sp * 5.3 + f.ph * 2));
        const y = H * (f.y + 0.06 * Math.sin(t * f.sp * 3 + f.ph * 1.7));
        const on = Math.max(0, Math.sin(t * 0.9 + f.ph * 3));
        if (on <= 0.05) continue;
        ctx.globalAlpha = on * 0.9;
        const r = fly.width * 0.5 * f.r;
        ctx.drawImage(fly, Math.round(x - r), Math.round(y - r), Math.round(r * 2), Math.round(r * 2));
      }
      ctx.restore();
      frame(ctx, W, H);
    };
  }

  window.BarScenes = { city, jungle, leafSprite };  // (leafSprite: for looking at one leaf on its own)
})();
