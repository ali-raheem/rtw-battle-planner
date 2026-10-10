// The battle plan: two sides, each a list of placed companies, plus the field.
// Everything the setup screen edits lives here, and toBattle() turns a plan into the
// description the sim starts from. Pure data, no DOM, so it runs under node:test.

import { createRng } from './rng.js';
import { UNIT_TYPES, TYPE_ORDER, DOCTRINES, TERRAINS, UNITS, designFor, randomBanner, randomPlace } from './gen.js';
import { PATTERNS } from './heraldry.js';

export const PLAN_VERSION = 1;
export const SIDES = 2;
export const HUES = [8, 214]; // you (red, bottom), the enemy (blue, top)
export const BUDGETS = [150, 300, 500, 800];
export const MAX_MEN = 480; // per side, to keep the sim fast on phones
export const MAX_COMPANIES = 16;
// Deployment zones: you hold the bottom of the field, the enemy the top, with open
// ground between. The sim's arena is a circle around them.
export const FIELD = { halfW: 420, near: 110, far: 460 };
export const ARENA_RADIUS = 720;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const forward = (side) => (side === 0 ? -Math.PI / 2 : Math.PI / 2);

export function zone(side) {
  const { halfW, near, far } = FIELD;
  return side === 0 ? { x0: -halfW, x1: halfW, y0: near, y1: far } : { x0: -halfW, x1: halfW, y0: -far, y1: -near };
}

// --- companies -------------------------------------------------------------------

export function company(side, key, x, y, extra = {}) {
  const d = designFor(key);
  return { side, key, n: d.size, c: Math.min(d.size, d.cols), x, y, f: forward(side), hold: false, ...extra };
}

// Half extents of a company's block: `hd` along the way it faces, `hw` across it.
export function footprint(u) {
  const d = designFor(u.key);
  const cols = Math.min(u.c, u.n);
  return { hw: (cols * d.spacing) / 2, hd: (Math.ceil(u.n / cols) * d.spacing) / 2 };
}

// The four corners of a company's block, in world space.
export function corners(u, pad = 0) {
  const { hw, hd } = footprint(u);
  const c = Math.cos(u.f), s = Math.sin(u.f);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => {
    const along = a * (hd + pad), lat = b * (hw + pad);
    return [u.x + along * c - lat * s, u.y + along * s + lat * c];
  });
}

// Separating-axis test on the two rotated rectangles, with a little elbow room.
export function overlaps(a, b, pad = 3) {
  const pa = corners(a, pad), pb = corners(b, pad);
  for (const f of [a.f, a.f + Math.PI / 2, b.f, b.f + Math.PI / 2]) {
    const ax = Math.cos(f), ay = Math.sin(f);
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const [x, y] of pa) { const p = x * ax + y * ay; amin = Math.min(amin, p); amax = Math.max(amax, p); }
    for (const [x, y] of pb) { const p = x * ax + y * ay; bmin = Math.min(bmin, p); bmax = Math.max(bmax, p); }
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

// Point-in-block test, for picking a company under the pointer (`pad` in world units).
export function contains(u, x, y, pad = 0) {
  const { hw, hd } = footprint(u);
  const dx = x - u.x, dy = y - u.y;
  const c = Math.cos(u.f), s = Math.sin(u.f);
  return Math.abs(dx * c + dy * s) <= hd + pad && Math.abs(-dx * s + dy * c) <= hw + pad;
}

// Moves a company's centre so its whole block sits inside its side's zone.
export function clampToZone(u) {
  const z = zone(u.side);
  const { hw, hd } = footprint(u);
  const c = Math.abs(Math.cos(u.f)), s = Math.abs(Math.sin(u.f));
  const ex = c * hd + s * hw, ey = s * hd + c * hw;
  u.x = (z.x1 - z.x0) / 2 > ex ? clamp(u.x, z.x0 + ex, z.x1 - ex) : (z.x0 + z.x1) / 2;
  u.y = (z.y1 - z.y0) / 2 > ey ? clamp(u.y, z.y0 + ey, z.y1 - ey) : (z.y0 + z.y1) / 2;
  return u;
}

export const companyCost = (u) => u.n * designFor(u.key).cost;
export const sideUnits = (plan, side) => plan.units.filter((u) => u.side === side);
export const sideCost = (plan, side) => sideUnits(plan, side).reduce((t, u) => t + companyCost(u), 0);
export const sideMen = (plan, side) => sideUnits(plan, side).reduce((t, u) => t + u.n, 0);

// Whether `u` (already in the plan, or about to be) clashes with another company.
export const blocked = (plan, u) => plan.units.some((o) => o !== u && overlaps(o, u));

// The nearest free spot to (x, y) for `u`, searching outwards on a spiral; null when
// the zone is full.
export function findSpot(plan, u, x = u.x, y = u.y) {
  const probe = { ...u };
  for (let r = 0; r < 600; r += 8) {
    const steps = r ? Math.ceil((TAU * r) / 12) : 1;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * TAU;
      probe.x = x + Math.cos(a) * r;
      probe.y = y + Math.sin(a) * r;
      clampToZone(probe);
      if (!plan.units.some((o) => o !== u && overlaps(o, probe))) return [probe.x, probe.y];
    }
  }
  return null;
}

// --- plans -----------------------------------------------------------------------

// A fresh plan on a random field. `yours: false` leaves your side empty to draw up.
export function newPlan(seed, { yours = true } = {}) {
  const rng = createRng(seed);
  const plan = {
    v: PLAN_VERSION,
    budget: 300,
    terrain: rng.pick(TERRAINS),
    field: rng.int(0, 0xffffffff) >>> 0,
    place: randomPlace(rng),
    sides: HUES.map((hue) => ({ ...randomBanner(rng), hue })),
    units: [],
  };
  for (let side = yours ? 0 : 1; side < SIDES; side++) plan.units.push(...randomArmy(rng, side, plan.budget));
  return plan;
}

// A random army for one side, drafted from a doctrine and deployed in the usual way:
// foot in the centre, archers before or behind them, horse on the wings.
export function randomArmy(rng, side, budget) {
  const doctrine = DOCTRINES[rng.pick(Object.keys(DOCTRINES))];
  const variant = {};
  for (const type of TYPE_ORDER) variant[type] = `${type}:${rng.int(0, UNIT_TYPES[type].variants.length - 1)}`;
  const units = [];
  let left = budget, men = 0;
  for (let guard = 0; guard < 60 && units.length < 12; guard++) {
    const options = TYPE_ORDER
      .filter((t) => designFor(variant[t]).min * designFor(variant[t]).cost <= left)
      .map((t) => [t, doctrine.w[t]]);
    if (!options.length) break;
    const d = designFor(variant[rng.weighted(options)]);
    let n = Math.min(d.max, Math.round((d.size * rng.range(0.75, 1.3)) / 2) * 2);
    n = Math.min(n, Math.floor(left / d.cost), MAX_MEN - men);
    if (n < d.min) break;
    units.push(company(side, d.key, 0, 0, { n, c: Math.min(n, d.cols) }));
    left -= n * d.cost;
    men += n;
  }
  deploy(units, side, rng);
  return units;
}

// Lays companies out in rows across the side's zone, then nudges any that don't fit.
export function deploy(units, side, rng) {
  const z = zone(side);
  const fwd = side === 0 ? -1 : 1; // +y is towards the enemy for side 1
  const frontY = side === 0 ? z.y0 + 70 : z.y1 - 70;
  const width = (u) => footprint(u).hw * 2;
  const depth = (u) => footprint(u).hd * 2;
  const foot = units.filter((u) => u.key.startsWith('spear') || u.key.startsWith('sword'));
  const bows = units.filter((u) => u.key.startsWith('archer'));
  const horse = units.filter((u) => u.key.startsWith('cavalry'));
  const rows = [];
  const lay = (list, y) => {
    // Wrap a row that would be wider than the field.
    let row = [], w = 0;
    const flush = () => {
      if (!row.length) return;
      let x = -w / 2;
      for (const u of row) {
        u.x = x + width(u) / 2;
        u.y = y;
        x += width(u) + 14;
      }
      rows.push(row);
      row = [];
      w = 0;
    };
    for (const u of list) {
      const add = width(u) + (row.length ? 14 : 0);
      if (w + add > z.x1 - z.x0 - 140) {
        flush();
        y -= fwd * (Math.max(...list.map(depth)) + 16);
      }
      row.push(u);
      w += add;
    }
    flush();
    return y;
  };
  const front = foot.length ? foot : bows;
  let y = lay(front, frontY);
  const back = Math.max(0, ...front.map(depth));
  if (front !== bows && bows.length) {
    const ahead = rng.chance(0.35);
    lay(bows, ahead ? frontY + fwd * (back / 2 + 30) : y - fwd * (back / 2 + 34));
  }
  const lineHalf = Math.max(40, ...rows.flat().map((u) => Math.abs(u.x) + width(u) / 2));
  const wing = [lineHalf + 26, lineHalf + 26];
  horse.forEach((u, i) => {
    const k = i % 2, sign = k ? -1 : 1;
    u.x = sign * (wing[k] + width(u) / 2);
    u.y = frontY - fwd * 16;
    wing[k] += width(u) + 18;
  });
  const placed = [];
  for (const u of units) {
    clampToZone(u);
    const plan = { units: placed };
    if (blocked(plan, u)) {
      const spot = findSpot(plan, u);
      if (spot) [u.x, u.y] = spot;
    }
    placed.push(u);
  }
}

// The enemy becomes a reflection of your army across the middle of the field.
export function mirror(plan) {
  const mine = sideUnits(plan, 0).map((u) => ({ ...u, side: 1, y: -u.y, f: -u.f }));
  plan.units = [...sideUnits(plan, 0), ...mine];
  return plan;
}

// --- the sim's starting point ------------------------------------------------------

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

export function toBattle(plan) {
  const teams = plan.sides.map((b, index) => {
    const hue = b.hue;
    return {
      index,
      name: b.name,
      lord: b.lord,
      doctrine: `${Math.round(sideCost(plan, index))} points`,
      hue,
      color: `hsl(${hue} 62% 50%)`,
      light: `hsl(${hue} 75% 72%)`,
      mid: `hsl(${hue} 45% 36%)`,
      dark: `hsl(${hue} 50% 22%)`,
      heraldry: { field: `hsl(${hue} 62% 42%)`, metal: b.metal, pattern: b.pattern },
      home: index === 0 ? [0, 1] : [0, -1],
      designs: {},
    };
  });
  // Name companies by kind, numbering them only where a side fields more than one.
  const total = {}, seen = {};
  for (const u of plan.units) total[`${u.side}/${u.key}`] = (total[`${u.side}/${u.key}`] ?? 0) + 1;
  const regiments = plan.units.map((u) => {
    const d = designFor(u.key);
    const k = `${u.side}/${u.key}`;
    seen[k] = (seen[k] ?? 0) + 1;
    teams[u.side].designs[u.key] = d;
    return {
      team: u.side,
      design: d,
      name: total[k] > 1 ? `${ordinal(seen[k])} ${d.name}` : d.name,
      count: u.n,
      cols: Math.min(u.c, u.n),
      x: u.x,
      y: u.y,
      facing: u.f,
      hold: !!u.hold,
    };
  });
  return { teams, regiments, arenaRadius: ARENA_RADIUS, place: plan.place, terrain: plan.terrain, field: plan.field };
}

// --- saving and sharing ----------------------------------------------------------

// Compact form for links and storage: companies become arrays.
export function encode(plan) {
  const json = JSON.stringify({
    v: plan.v, b: plan.budget, t: plan.terrain, s: plan.field, p: plan.place,
    a: plan.sides.map((b) => [b.name, b.lord, b.pattern, b.metal]),
    u: plan.units.map((u) => [u.side, u.key, u.n, u.c, Math.round(u.x), Math.round(u.y), Math.round(u.f * 1000) / 1000, u.hold ? 1 : 0]),
  });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Parses and sanitises a plan from encode(); returns null for anything unusable.
export function decode(text) {
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (raw.v !== PLAN_VERSION || !Array.isArray(raw.u) || !Array.isArray(raw.a)) return null;
    const str = (v, fallback, max = 60) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : fallback);
    const num = (v, lo, hi, fallback) => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
    const plan = {
      v: PLAN_VERSION,
      budget: raw.b === 0 ? 0 : num(raw.b, 50, 5000, 300), // 0 = no limit
      terrain: TERRAINS.includes(raw.t) ? raw.t : 'meadow',
      field: num(raw.s, 0, 0xffffffff, 1) >>> 0,
      place: str(raw.p, 'the Field'),
      sides: HUES.map((hue, i) => {
        const [name, lord, pattern, metal] = Array.isArray(raw.a[i]) ? raw.a[i] : [];
        return {
          hue,
          name: str(name, i ? 'The Enemy' : 'Your Army'),
          lord: str(lord, 'an unknown lord'),
          pattern: PATTERNS.includes(pattern) ? pattern : PATTERNS[0],
          metal: /^#[0-9a-f]{6}$/i.test(metal) ? metal : '#e9c85a',
        };
      }),
      units: [],
    };
    for (const r of raw.u) {
      if (!Array.isArray(r) || !UNITS.includes(r[1])) continue;
      const side = r[0] === 1 ? 1 : 0;
      if (sideUnits(plan, side).length >= MAX_COMPANIES) continue;
      const d = designFor(r[1]);
      const n = Math.round(num(r[2], d.min, d.max, d.size));
      const u = {
        side, key: r[1], n,
        c: Math.round(num(r[3], 1, n, Math.min(n, d.cols))),
        x: num(r[4], -2000, 2000, 0), y: num(r[5], -2000, 2000, 0),
        f: num(r[6], -10, 10, forward(side)),
        hold: r[7] === 1,
      };
      if (sideMen(plan, side) + n > MAX_MEN) continue;
      plan.units.push(clampToZone(u));
    }
    return plan;
  } catch {
    return null;
  }
}
