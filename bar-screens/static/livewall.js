// Basement Live on the Pi: receives the guests' phone cameras (static/live.html) over WebRTC, for
// the live channel in channels.js to draw. One receiver serves every wall on the page, and it only
// runs while a wall is on the channel, so the Pi isn't decoding video nobody sees.
//
// The handshake goes through the Bar Screens server: offers arrive on /api/live/stream, each one
// complete (no trickled ICE), and the answer goes back in one POST. If the display reloads, the
// server asks every live phone for a fresh offer, so the cameras come back by themselves.
(() => {
  'use strict';

  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  let bus = null;

  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function gathered(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, ms);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // A camera's picture plays in a tiny video element behind the walls (the walls are opaque), so
  // Chromium keeps decoding it for the canvas without it ever reaching an LED.
  function camVideo() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', zIndex: '-1', pointerEvents: 'none' });
    document.body.appendChild(v);
    return v;
  }

  function create() {
    const cams = new Map(); // cid -> { cid, name, slot, gen, pc, video, announce, badSince, askedAt }
    let es = null, closed = false, timer = 0;

    function add(cid, name, slot, announce) {
      let c = cams.get(cid);
      if (!c) {
        c = { cid, name, slot, gen: 0, pc: null, video: camVideo(), announce, badSince: 0, askedAt: 0, since: performance.now() };
        cams.set(cid, c);
      }
      c.name = name;
      c.slot = slot;
      return c;
    }

    function drop(cid) {
      const c = cams.get(cid);
      if (!c) return;
      if (c.pc) c.pc.close();
      c.video.srcObject = null;
      c.video.remove();
      cams.delete(cid);
    }

    async function accept(c, gen, sdp) {
      if (c.pc) c.pc.close();
      const pc = c.pc = new RTCPeerConnection({ iceServers: STUN });
      c.gen = gen;
      c.badSince = 0;
      pc.ontrack = (e) => {
        if (e.track.kind !== 'video') return; // the walls have no sound
        c.video.srcObject = new MediaStream([e.track]);
        c.video.play().catch(() => {});
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        for (const t of pc.getTransceivers()) {
          if (t.receiver.track && t.receiver.track.kind === 'audio') t.direction = 'inactive';
        }
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc, 2500);
        if (c.pc !== pc || closed) return;
        await post('/api/live/answer', { cid: c.cid, gen, sdp: pc.localDescription.sdp });
      } catch (e) {}
    }

    function open() {
      es = new EventSource('/api/live/stream');
      es.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'hello') {
          // Whoever is already live was on before this page loaded: no welcome for them.
          const ids = new Set(m.cams.map((c) => c.cid));
          for (const cid of [...cams.keys()]) if (!ids.has(cid)) drop(cid);
          for (const c of m.cams) add(c.cid, c.name, c.slot, false);
        } else if (m.type === 'offer') {
          accept(add(m.cid, m.name, m.slot, true), m.gen, m.sdp);
        } else if (m.type === 'leave') {
          drop(m.cid);
        } else if (m.type === 'standby') {
          for (const cid of [...cams.keys()]) drop(cid); // a newer display took the cameras over
        }
      };
      es.onerror = () => { if (es.readyState === EventSource.CLOSED && !closed) setTimeout(open, 3000); };
    }

    // A connection that fails, or stays broken for a few seconds, gets a fresh start: the server
    // asks that phone for a new offer. If the phone has gone, the server drops it soon after.
    function watch() {
      const now = performance.now();
      for (const c of cams.values()) {
        const state = c.pc ? c.pc.connectionState : 'new';
        const bad = state === 'failed' || state === 'disconnected' || state === 'closed' || (state === 'new' && now - c.since > 15000);
        if (!bad) { c.badSince = 0; continue; }
        if (!c.badSince) c.badSince = now;
        if ((state === 'failed' || now - c.badSince > 6000) && now - c.askedAt > 8000) {
          c.askedAt = now;
          post('/api/live/reoffer', { cid: c.cid }).catch(() => {});
        }
      }
    }

    open();
    timer = setInterval(watch, 2000);
    return {
      refs: 1,
      // The cameras with a picture right now, in the order they joined.
      cams() {
        return [...cams.values()]
          .filter((c) => c.pc && c.pc.connectionState === 'connected' && c.video.videoWidth > 0 && c.video.readyState >= 2)
          .sort((a, b) => a.slot - b.slot);
      },
      release() {
        if (--this.refs > 0) return;
        closed = true;
        clearInterval(timer);
        es.close();
        for (const cid of [...cams.keys()]) drop(cid);
        bus = null;
      },
    };
  }

  window.BarLive = {
    acquire() {
      if (bus) { bus.refs++; return bus; }
      bus = create();
      return bus;
    },
  };
})();
