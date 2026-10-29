'use strict';
// Plays pet animations converted by game/tools/build_anims.py.
// Each frame is a list of [piece, ux, uy, vx, vy, ox, oy, alpha, mode]; the piece rect from the
// atlas is mapped onto the parallelogram (o, o+u, o+v) — units are px×10 at 100 px/world unit.
// mode: 0 normal, 1 additive, 2 mask shape, 3 masked, 4 masked additive; [-1] ends a mask.

const AnimCache = {};

function loadAnim(id) {
  if (!AnimCache[id]) {
    AnimCache[id] = (async () => {
      const [data, img] = await Promise.all([
        fetch(`anim/${id}.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = `anim/${id}.webp`; }),
      ]);
      data.img = img;
      return data;
    })();
    AnimCache[id].catch(() => delete AnimCache[id]);
  }
  return AnimCache[id];
}

class PetAnim {
  // home: where the standby pose sits, as fractions of the canvas {x, y (feet), w, h}
  constructor(canvas, data, { flip = false, home = { x: .5, y: .98, w: .92, h: .92 } } = {}) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.data = data; this.flip = flip; this.home = home;
    this.seq = 'standby'; this.frame = 0; this.acc = 0;
    this.pending = null; this.alpha = 1; this.tint = null;
    this.running = true;
    this.last = performance.now();
    this.fit();
    const tick = t => {
      if (!this.running) return;
      this.step(t - this.last); this.last = t;
      this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  fit() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = this.cv.getBoundingClientRect();
    this.cv.width = Math.max(1, r.width * dpr); this.cv.height = Math.max(1, r.height * dpr);
    const [x0, y0, x1, y1] = this.data.bounds;
    const { x, y, w, h } = this.home, W = this.cv.width, H = this.cv.height;
    const s = Math.min(W * w / (x1 - x0), H * h / (y1 - y0));
    this.scale = s;
    // flipping mirrors around the canvas centre, so aim the unflipped pose at the mirrored spot
    this.cx = W * (this.flip ? 1 - x : x) - (x0 + x1) / 2 * s;
    this.cy = H * y - y1 * s;
  }

  has(seq) { return !!this.data.seqs[seq]; }

  // Plays a one-shot sequence; resolves when it ends. onHit fires at the "action_hit" label.
  play(seq, onHit) {
    if (!this.has(seq)) { onHit && onHit(); return Promise.resolve(); }
    if (this.pending) this.pending.resolve();
    return new Promise(resolve => {
      this.seq = seq; this.frame = 0; this.acc = 0;
      this.pending = { resolve, onHit, hitFired: false };
    });
  }

  step(dt) {
    const s = this.data.seqs[this.seq];
    this.acc += dt;
    const spf = 1000 / this.data.fps;
    while (this.acc >= spf) {
      this.acc -= spf;
      this.frame++;
      const p = this.pending;
      if (p && !p.hitFired && s.labels.action_hit !== undefined && this.frame >= s.labels.action_hit) {
        p.hitFired = true; p.onHit && p.onHit();
      }
      const end = s.labels.action_end !== undefined ? s.labels.action_end + 1 : s.frames.length;
      if (this.frame >= Math.min(end, s.frames.length)) {
        if (p) {
          if (!p.hitFired && p.onHit) p.onHit();
          this.pending = null; this.seq = 'standby'; this.frame = 0; p.resolve();
          return;
        }
        this.frame = 0;
      }
    }
  }

  draw() {
    const { ctx, data, cv } = this;
    const frames = data.seqs[this.seq].frames;
    const quads = frames[Math.min(this.frame, frames.length - 1)];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    let mask = [], content = [];
    const flush = () => {
      if (content.length && mask.length) {
        const off = this.off || (this.off = document.createElement('canvas'));
        if (off.width !== cv.width || off.height !== cv.height) { off.width = cv.width; off.height = cv.height; }
        const o = off.getContext('2d');
        o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, off.width, off.height);
        for (const q of content) this.quad(o, q);
        o.globalCompositeOperation = 'destination-in';
        for (const q of mask) this.quad(o, q, true);
        o.globalCompositeOperation = 'source-over';
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = this.alpha;
        ctx.drawImage(off, 0, 0);
      }
      mask = []; content = [];
    };
    for (const q of quads) {
      const mode = q[0] < 0 ? -1 : q[8];
      if (mode === -1) { flush(); continue; }
      if (mode === 2) { if (content.length) flush(); mask.push(q); continue; }
      if (mode >= 3) { content.push(q); continue; }
      if (mask.length) flush();
      this.quad(ctx, q);
    }
    flush();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (this.tint) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = this.tint; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  quad(c, [pi, ux, uy, vx, vy, ox, oy, a, mode], isMask) {
    const [px, py, pw, ph] = this.data.pieces[pi];
    const s = this.scale / 10, f = this.flip ? -1 : 1;
    const bx = this.flip ? this.cv.width - this.cx : this.cx;
    c.globalAlpha = isMask ? 1 : a / 100 * this.alpha;
    if (!isMask) c.globalCompositeOperation = mode === 1 || mode === 4 ? 'lighter' : 'source-over';
    c.setTransform(f * ux * s / pw, uy * s / pw, f * vx * s / ph, vy * s / ph, bx + f * ox * s, this.cy + oy * s);
    c.drawImage(this.data.img, px, py, pw, ph, 0, 0, pw, ph);
  }

  destroy() { this.running = false; if (this.pending) this.pending.resolve(); }
}
