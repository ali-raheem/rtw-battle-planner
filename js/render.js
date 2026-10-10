// Canvas renderer: terrain, soldiers, arrows, banners, corpses and particle effects.
// Purely cosmetic randomness here uses Math.random — it never feeds back into the sim.

import { createRng } from './rng.js';
import { heraldryShapes } from './heraldry.js';

const MAX_PARTICLES = 3000;
const GROUND_PX = 2048;
const rand = (a, b) => a + (b - a) * Math.random();
const hsl = ([h, s, l], a = 1) => `hsl(${h} ${s}% ${l}% / ${a})`;

// Palettes per terrain, as [h, s, l].
const TERRAIN = {
  meadow: { base: [96, 34, 33], patch: [[90, 36, 28], [104, 30, 38], [80, 32, 30]], tuft: [100, 40, 22], flowers: ['#f2e27a', '#f4f1e6', '#d98ad0'], tree: [110, 35, 20], dirt: [35, 30, 30] },
  spring: { base: [105, 42, 38], patch: [[100, 46, 32], [115, 38, 44], [90, 40, 34]], tuft: [105, 48, 26], flowers: ['#fff7a8', '#ffffff', '#f7a8c8', '#b8a8ff'], tree: [115, 40, 22], dirt: [35, 28, 34] },
  autumn: { base: [58, 30, 32], patch: [[45, 40, 30], [70, 26, 34], [30, 45, 32]], tuft: [50, 35, 22], flowers: ['#d9772a', '#b8452a', '#e0b040'], tree: [28, 55, 28], dirt: [28, 30, 26] },
  heath: { base: [80, 18, 28], patch: [[290, 18, 30], [75, 22, 24], [60, 20, 32]], tuft: [80, 20, 18], flowers: ['#a070c0', '#c090d8'], tree: [120, 25, 17], dirt: [30, 22, 24] },
  steppe: { base: [46, 32, 44], patch: [[40, 35, 40], [52, 30, 50], [60, 25, 38]], tuft: [45, 30, 32], flowers: [], tree: null, dirt: [32, 28, 34] },
  snow: { base: [210, 14, 86], patch: [[210, 12, 80], [200, 10, 92], [215, 16, 76]], tuft: [210, 8, 64], flowers: [], tree: [150, 25, 18], dirt: [30, 12, 46] },
};
const HORSE = ['#5a3a22', '#3a2618', '#7a5a3a', '#2a2320', '#8a8378', '#6b4128'];
const HEADS = ['#8a6a48', '#c49a72', '#5a4636'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.cam = { x: 0, y: 0, zoom: 1 };
    // While planning, the camera frames this world rectangle instead of the fighting.
    this.frame = null;
    this.showBars = true;
    this.ground = document.createElement('canvas');
    this.ground.width = this.ground.height = GROUND_PX;
    this.gctx = this.ground.getContext('2d');
    this.palette = TERRAIN.meadow;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.vignette = null;
    this.setInsets(this.insets);
  }

  // The part of the screen the battle should fill, as margins in CSS px. By default it
  // stays clear of the army header (top) and controls/feed (bottom).
  setInsets(insets = null) {
    this.insets = insets;
    const { top = this.h > 500 ? 100 : 70, bottom = 60, left = 0, right = 0 } = insets ?? {};
    this.viewW = Math.max(100, this.w - left - right);
    this.viewH = Math.max(100, this.h - top - bottom);
    this.centerX = left + this.viewW / 2;
    this.centerY = top + this.viewH / 2;
  }

  reset(state) {
    this.particles = [];
    this.teams = state.teams;
    this.palette = TERRAIN[state.terrain] ?? TERRAIN.meadow;
    this.makeGround(state);
    this.fitCamera(state, 1, true);
  }

  // --- camera ---------------------------------------------------------------

  fitCamera(state, dt, snap = false) {
    if (this.frame) {
      const f = this.frame;
      this.cam.x = (f.x0 + f.x1) / 2;
      this.cam.y = (f.y0 + f.y1) / 2;
      this.cam.zoom = Math.min(this.viewW / (f.x1 - f.x0), this.viewH / (f.y1 - f.y0));
      return;
    }
    // Frame the fighting men, ignoring the few stragglers furthest out on each axis.
    const xs = [], ys = [];
    for (const s of state.soldiers) {
      if (!s.alive || s.routing) continue;
      xs.push(s.x);
      ys.push(s.y);
    }
    if (!xs.length) {
      for (const s of state.soldiers) {
        if (!s.alive) continue;
        xs.push(s.x);
        ys.push(s.y);
      }
    }
    if (!xs.length) return;
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const cut = Math.floor(xs.length * 0.03);
    const minX = xs[cut], maxX = xs[xs.length - 1 - cut];
    const minY = ys[cut], maxY = ys[ys.length - 1 - cut];
    const pad = 70;
    const bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
    const zoom = Math.min(3, Math.max(0.15, Math.min(this.viewW / bw, this.viewH / bh)));
    const tx = (minX + maxX) / 2, ty = (minY + maxY) / 2;
    const k = snap ? 1 : Math.min(1, dt * 0.8);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.zoom = Math.exp(Math.log(this.cam.zoom) + (Math.log(zoom) - Math.log(this.cam.zoom)) * k);
  }

  // Screen (CSS px) → world coordinates, and the canvas transform for world drawing.
  toWorld(sx, sy) {
    const { cam } = this;
    return [(sx - this.centerX) / cam.zoom + cam.x, (sy - this.centerY) / cam.zoom + cam.y];
  }

  worldTransform() {
    const { ctx, dpr, cam } = this;
    const z = cam.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (this.centerX - cam.x * z), dpr * (this.centerY - cam.y * z));
    return 1 / z;
  }

  // --- the ground: terrain plus everything stamped into it ---------------------

  makeGround(state) {
    const g = this.gctx;
    const pal = this.palette;
    const rng = createRng((state.field * 2654435761) >>> 0);
    const E = (this.extent = state.arenaRadius + 350);
    const k = (this.gk = GROUND_PX / (2 * E));
    const P = GROUND_PX;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = hsl(pal.base);
    g.fillRect(0, 0, P, P);

    for (let i = 0; i < 260; i++) {
      const x = rng.range(0, P), y = rng.range(0, P), r = rng.range(40, 220);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, hsl(rng.pick(pal.patch), rng.range(0.25, 0.5)));
      grad.addColorStop(1, hsl(pal.base, 0));
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // A cart track across the field.
    if (rng.chance(0.6)) {
      const a = rng.range(0, Math.PI);
      const c = Math.cos(a), s = Math.sin(a);
      const off = rng.range(-0.3, 0.3) * E;
      const pts = [];
      for (let t = -1.2; t <= 1.2; t += 0.1) {
        const bend = Math.sin(t * rng.range(1.5, 2.5) + 1) * E * 0.08;
        pts.push([(t * E * c - (off + bend) * s + E) * k, (t * E * s + (off + bend) * c + E) * k]);
      }
      g.lineCap = g.lineJoin = 'round';
      for (const [w, alpha] of [[16, 0.18], [10, 0.3], [3, 0.2]]) {
        g.strokeStyle = hsl(pal.dirt, alpha);
        g.lineWidth = w * k * 2;
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      }
    }

    g.lineWidth = Math.max(1, k * 0.8);
    g.strokeStyle = hsl(pal.tuft, 0.45);
    g.beginPath();
    for (let i = 0; i < 9000; i++) {
      const x = rng.range(0, P), y = rng.range(0, P);
      g.moveTo(x, y);
      g.lineTo(x + rng.range(-2, 2), y - rng.range(2, 5));
    }
    g.stroke();

    for (const color of pal.flowers) {
      g.fillStyle = color;
      for (let i = 0; i < 350; i++) {
        const x = rng.range(0, P), y = rng.range(0, P);
        g.fillRect(x, y, 1.5, 1.5);
      }
    }

    // Stones.
    for (let i = 0; i < 40; i++) {
      const x = rng.range(0, P), y = rng.range(0, P), r = rng.range(1.5, 4.5);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath();
      g.ellipse(x + 1, y + 1, r, r * 0.7, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = `hsl(40 6% ${rng.range(45, 65)}%)`;
      g.beginPath();
      g.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
      g.fill();
    }

    // Woods around the edge of the field.
    if (pal.tree) {
      const clusters = rng.int(5, 10);
      for (let c = 0; c < clusters; c++) {
        const a = rng.range(0, Math.PI * 2), d = rng.range(state.arenaRadius * 0.95, E);
        const cx = (Math.cos(a) * d + E) * k, cy = (Math.sin(a) * d + E) * k;
        const n = rng.int(6, 22);
        const trees = [];
        for (let i = 0; i < n; i++) trees.push([cx + rng.gauss() * 70 * k * 2, cy + rng.gauss() * 70 * k * 2, rng.range(9, 18) * k * 2]);
        g.fillStyle = 'rgba(0,0,0,0.3)';
        for (const [x, y, r] of trees) {
          g.beginPath();
          g.arc(x + r * 0.35, y + r * 0.35, r, 0, Math.PI * 2);
          g.fill();
        }
        for (const [x, y, r] of trees) {
          const [h, s, l] = pal.tree;
          g.fillStyle = hsl([h + rng.range(-8, 8), s, l + rng.range(-4, 4)]);
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = hsl([h, s, l + 10], 0.6);
          g.beginPath();
          g.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }

  // Draw on the ground in world units.
  stamp(x, y, angle, fn) {
    const g = this.gctx, k = this.gk, E = this.extent;
    g.setTransform(k, 0, 0, k, (x + E) * k, (y + E) * k);
    g.rotate(angle);
    fn(g);
  }

  stampCorpse(s) {
    const team = this.teams[s.team];
    const r = s.r;
    this.stamp(s.x, s.y, s.angle + rand(-0.8, 0.8), (g) => {
      g.fillStyle = `rgba(${Math.round(rand(90, 120))}, 12, 10, ${rand(0.35, 0.55)})`;
      g.beginPath();
      g.ellipse(rand(-1, 1), rand(-1, 1), r * rand(1, 1.7), r * rand(0.8, 1.3), rand(0, 3), 0, Math.PI * 2);
      g.fill();
      if (s.d.type === 'cavalry') {
        g.fillStyle = HORSE[s.id % HORSE.length];
        g.beginPath();
        g.ellipse(0, 0, r * 1.15, r * 0.55, 0, 0, Math.PI * 2);
        g.fill();
        g.beginPath();
        g.ellipse(r * 1.1, r * 0.3, r * 0.4, r * 0.2, 0.6, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = team.mid;
        g.beginPath();
        g.ellipse(-r * 0.1, r * 0.95, r * 0.5, r * 0.28, 0, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = team.mid;
        g.beginPath();
        g.ellipse(0, 0, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = HEADS[s.id % 3];
        g.beginPath();
        g.arc(r * 1.05, 0, r * 0.38, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = s.d.type === 'spear' ? '#5a4128' : '#8b8f93';
        g.lineWidth = 0.5;
        g.beginPath();
        g.moveTo(-r, r * rand(0.6, 1.2));
        g.lineTo(r * rand(0.6, 2.2), r * rand(0.8, 1.6));
        g.stroke();
      }
    });
  }

  stampArrow(x, y, angle) {
    this.stamp(x, y, angle, (g) => {
      g.strokeStyle = 'rgba(40, 28, 16, 0.8)';
      g.lineWidth = 0.45;
      g.beginPath();
      g.moveTo(-2.5, 0);
      g.lineTo(1, 0);
      g.stroke();
      g.fillStyle = 'rgba(230, 220, 200, 0.8)';
      g.fillRect(-2.8, -0.4, 0.8, 0.8);
    });
  }

  stampMud(x, y) {
    this.stamp(x + rand(-3, 3), y + rand(-3, 3), 0, (g) => {
      g.fillStyle = hsl(this.palette.dirt, 0.05);
      g.beginPath();
      g.arc(0, 0, rand(3, 6), 0, Math.PI * 2);
      g.fill();
    });
  }

  // --- events -> particles and stamps ---------------------------------------------

  ingest(events) {
    for (const e of events) {
      switch (e.type) {
        case 'clash':
          if (Math.random() < 0.5) this.sparks(e.x, e.y, 3, '#fff1c0');
          if (Math.random() < 0.4) this.blood(e.x, e.y, 2);
          if (Math.random() < 0.3) this.stampMud(e.x, e.y);
          break;
        case 'arrowhit':
          this.blood(e.x, e.y, 2);
          break;
        case 'death':
          this.blood(e.x, e.y, 5);
          this.stampCorpse(e.soldier);
          break;
        case 'miss':
          this.stampArrow(e.x, e.y, e.angle);
          break;
        case 'impact':
          // A charge onto braced spears ends in a burst of splintered shafts.
          if (e.kind === 'braced') this.sparks(e.x, e.y, 8, '#c2a676');
          else this.sparks(e.x, e.y, 6, '#ffe7a0');
          this.dust(e.x, e.y, 4, 1.4);
          break;
      }
    }
    events.length = 0;
  }

  add(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  sparks(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(20, 70);
      this.add({ t: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.08, 0.22), age: 0, size: rand(0.3, 0.6), color });
    }
  }

  blood(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(8, 30);
      this.add({ t: 'blood', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.2, 0.5), age: 0, size: rand(0.4, 0.9), color: '#8a0e0e' });
    }
  }

  dust(x, y, n, size = 1) {
    const c = this.palette.dirt;
    for (let i = 0; i < n; i++) {
      this.add({ t: 'dust', x: x + rand(-2, 2), y: y + rand(-2, 2), vx: rand(-6, 6), vy: rand(-6, 6), life: rand(0.8, 1.8), age: 0, size: rand(2, 4) * size, color: hsl([c[0], c[1], c[2] + 25]) });
    }
  }

  // --- per-frame update ----------------------------------------------------------

  update(state, simDt, realDt) {
    this.fitCamera(state, realDt);
    if (simDt <= 0) return;

    // Hooves kick up dust (not in snow, where it would look odd).
    if (state.terrain !== 'snow') {
      for (const s of state.soldiers) {
        if (!s.alive || s.d.type !== 'cavalry') continue;
        const v = Math.hypot(s.vx, s.vy);
        if (v > 30 && Math.random() < simDt * 6) this.dust(s.x - s.vx * 0.08, s.y - s.vy * 0.08, 1);
      }
    }

    for (const p of this.particles) {
      p.age += simDt;
      p.x += p.vx * simDt;
      p.y += p.vy * simDt;
      const drag = p.t === 'dust' ? 1.2 : 4;
      p.vx *= 1 - Math.min(1, drag * simDt);
      p.vy *= 1 - Math.min(1, drag * simDt);
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
  }

  // --- drawing -------------------------------------------------------------------

  // `overlay(ctx, px)` draws in world space above the armies (the planning marks).
  draw(state, overlay) {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = hsl(this.palette.base);
    ctx.fillRect(0, 0, w, h);

    const px = this.worldTransform(); // one screen pixel in world units
    const E = this.extent;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.ground, -E, -E, 2 * E, 2 * E);

    this.drawParticles(['dust'], px, 'source-over');
    this.drawArrows(state, px, true);
    const t = state.time;
    for (const s of state.soldiers) if (s.alive && s.d.type !== 'cavalry') this.drawSoldier(s, t, px);
    for (const s of state.soldiers) if (s.alive && s.d.type === 'cavalry') this.drawSoldier(s, t, px);
    this.drawParticles(['blood'], px, 'source-over');
    this.drawParticles(['spark'], px, 'lighter');
    this.drawArrows(state, px, false);
    this.drawBanners(state, px);
    if (overlay) {
      ctx.save();
      overlay(ctx, px);
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.drawVignette();
  }

  drawVignette() {
    const { ctx, w, h } = this;
    if (!this.vignette) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(10,6,2,0.55)');
      this.vignette = g;
    }
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, w, h);
  }

  drawSoldier(s, t, px) {
    const { ctx } = this;
    const team = this.teams[s.team];
    const d = s.d;
    const r = s.r;
    const flash = t - s.hitT < 0.1;
    const bodyColor = flash ? '#ffffff' : s.routing ? team.mid : team.color;

    if (r / px < 1.6) {
      // Too small for detail: a coloured speck (a longer one for horsemen).
      ctx.fillStyle = bodyColor;
      const m = Math.max(r * 1.4, 1.3 * px);
      if (d.type === 'cavalry') {
        const c = Math.cos(s.angle), sn = Math.sin(s.angle);
        ctx.fillRect(s.x - m * 0.5 - Math.abs(c) * m * 0.4, s.y - m * 0.5 - Math.abs(sn) * m * 0.4, m + Math.abs(c) * m * 0.8, m + Math.abs(sn) * m * 0.8);
      } else {
        ctx.fillRect(s.x - m / 2, s.y - m / 2, m, m);
      }
      return;
    }

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.lineWidth = Math.max(0.35, px * 0.8);
    ctx.lineCap = 'round';
    const armed = !s.routing;
    const swing = t - s.strikeT < 0.3 ? (t - s.strikeT) / 0.3 : -1;

    if (d.type === 'cavalry') {
      const coat = HORSE[s.id % HORSE.length];
      ctx.fillStyle = coat;
      ctx.beginPath();
      ctx.ellipse(-r * 0.1, 0, r * 1.05, r * 0.46, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r * 1.0, 0, r * 0.42, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = coat;
      ctx.beginPath();
      ctx.moveTo(-r * 1.1, 0);
      ctx.lineTo(-r * 1.5, Math.sin(t * 9 + s.id) * r * 0.15);
      ctx.stroke();
      // Caparison or saddle cloth in the army's colours.
      ctx.fillStyle = team.color;
      ctx.globalAlpha = s.routing ? 0.6 : 0.95;
      ctx.beginPath();
      if (d.lance) ctx.ellipse(-r * 0.1, 0, r * 0.8, r * 0.52, 0, 0, Math.PI * 2);
      else ctx.ellipse(-r * 0.15, 0, r * 0.38, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (armed) {
        if (d.lance) {
          const couched = s.reg.phase === 'charge';
          ctx.strokeStyle = '#c2a676';
          ctx.lineWidth = Math.max(0.45, px * 0.8);
          ctx.beginPath();
          ctx.moveTo(-r * 0.4, r * 0.3);
          ctx.lineTo(couched ? r * 2.6 : r * 0.9, couched ? r * 0.2 : r * 0.35);
          ctx.stroke();
        } else {
          this.drawBlade(r * 0.1, r * 0.4, r * 1.2, swing);
        }
      }
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = team.dark;
      ctx.lineWidth = Math.max(0.3, px * 0.6);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.3, r * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = d.armor > 0.3 ? '#a4a9ad' : HEADS[s.id % 3];
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (armed && d.type === 'spear') {
      const thrust = swing >= 0 ? Math.sin(swing * Math.PI) * 3 : 0;
      const tipX = d.reach * 0.95 + thrust;
      ctx.strokeStyle = '#6b4f32';
      ctx.lineWidth = Math.max(0.4, px * 0.7);
      ctx.beginPath();
      ctx.moveTo(-r * 0.6 + thrust, r * 0.5);
      ctx.lineTo(tipX, r * 0.42);
      ctx.stroke();
      ctx.fillStyle = '#d5d8da';
      ctx.beginPath();
      ctx.moveTo(tipX + 1.6, r * 0.42);
      ctx.lineTo(tipX - 0.4, r * 0.42 - 0.5);
      ctx.lineTo(tipX - 0.4, r * 0.42 + 0.5);
      ctx.fill();
    }
    if (armed && d.type === 'sword') this.drawBlade(r * 0.2, r * 0.65, r * 1.6, swing);

    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = team.dark;
    ctx.lineWidth = Math.max(0.3, px * 0.6);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.6, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (armed && d.shield > 0) {
      const big = d.shield >= 0.4;
      ctx.fillStyle = team.heraldry.metal;
      ctx.beginPath();
      ctx.ellipse(r * 0.45, -r * 0.72, r * (big ? 0.3 : 0.24), r * (big ? 0.66 : 0.45), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (armed && d.type === 'archer') {
      ctx.strokeStyle = '#7a5530';
      ctx.lineWidth = Math.max(0.4, px * 0.8);
      if (d.ranged.bolt) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(r * 1.4, 0);
        ctx.moveTo(r * 1.2, -r * 0.6);
        ctx.lineTo(r * 1.2, r * 0.6);
        ctx.stroke();
      } else {
        const drawn = s.shot >= 0;
        const bx = r * 0.3, br = r * 1.0, a0 = 1.15;
        ctx.beginPath();
        ctx.arc(bx, 0, br, -a0, a0);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(235,225,200,0.7)';
        ctx.lineWidth = Math.max(0.2, px * 0.5);
        ctx.beginPath();
        const ex = bx + Math.cos(a0) * br, ey = Math.sin(a0) * br;
        ctx.moveTo(ex, -ey);
        ctx.lineTo(drawn ? -r * 0.4 : ex, 0);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
    }

    ctx.fillStyle = d.armor > 0.3 ? '#a4a9ad' : HEADS[s.id % 3];
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // A blade held at (x, y) in the soldier's frame; swings through an arc mid-strike.
  drawBlade(x, y, len, swing) {
    const { ctx } = this;
    const a = swing >= 0 ? -1.3 + swing * 2.2 : -0.35;
    ctx.strokeStyle = '#dfe3e6';
    ctx.lineWidth = Math.max(0.45, ctx.lineWidth);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // Arrows fly in an arc: the shadow tracks the ground, the shaft is lifted by height.
  drawArrows(state, px, shadows) {
    const { ctx } = this;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.45, px * 0.9);
    ctx.strokeStyle = shadows ? 'rgba(0,0,0,0.22)' : '#efe4c8';
    ctx.beginPath();
    for (const a of state.arrows) {
      const f = Math.min(1, a.t / a.dur);
      const f0 = Math.max(0, f - 0.03);
      const lift = shadows ? 0 : 0.7;
      const p = (q) => [
        a.x0 + (a.x1 - a.x0) * q,
        a.y0 + (a.y1 - a.y0) * q - 4 * a.h * q * (1 - q) * lift,
      ];
      const [x1, y1] = p(f), [x0, y0] = p(f0);
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const L = a.bolt ? 3 : 4.5;
      ctx.moveTo(x1 - (dx / len) * L, y1 - (dy / len) * L);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  }

  drawBanners(state, px) {
    const { ctx } = this;
    const H = 20 * px, fw = 13 * px, fh = 9 * px;
    for (const reg of state.regiments) {
      if (!reg.alive || reg.routed) continue;
      const team = this.teams[reg.team];
      const bx = reg.cx, by = reg.cy;
      ctx.strokeStyle = '#2b2118';
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - H);
      ctx.stroke();
      drawFlag(ctx, bx, by - H, fw, fh, team.heraldry, state.time + reg.id);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = px;
      ctx.strokeRect(bx, by - H, fw, fh);
      if (this.showBars) {
        const y = by - H + fh + 2 * px;
        const bw = fw;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(bx - px, y - px, bw + 2 * px, 6 * px);
        ctx.fillStyle = team.light;
        ctx.fillRect(bx, y, bw * (reg.alive / reg.count), 2 * px);
        ctx.fillStyle = '#e8c26a';
        ctx.fillRect(bx, y + 3 * px, bw * Math.max(0, reg.morale), 1.6 * px);
      }
    }
  }

  drawParticles(types, px, mode) {
    const { ctx } = this;
    ctx.globalCompositeOperation = mode;
    for (const p of this.particles) {
      if (!types.includes(p.t)) continue;
      const f = p.age / p.life;
      if (p.t === 'spark') {
        ctx.globalAlpha = 1 - f;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(p.size, px * 0.8);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else if (p.t === 'blood') {
        ctx.globalAlpha = 0.9 * (1 - f);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(p.size, px * 0.7), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.t === 'dust') {
        ctx.globalAlpha = 0.28 * (1 - f);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.6 + f * 1.4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

// A banner at (x, y) (top-left, hanging right of the pole), rippling slightly.
function drawFlag(ctx, x, y, w, h, her, t) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = her.field;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = her.metal;
  for (const poly of heraldryShapes(her.pattern)) {
    ctx.beginPath();
    poly.forEach(([u, v], i) => (i ? ctx.lineTo(x + u * w, y + v * h) : ctx.moveTo(x + u * w, y + v * h)));
    ctx.closePath();
    ctx.fill();
  }
  // Ripple shading.
  for (let i = 0; i < 3; i++) {
    const sx = x + ((i + 0.5 + Math.sin(t * 3 + i) * 0.2) / 3) * w;
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(sx, y, w / 9, h);
  }
  ctx.restore();
}
