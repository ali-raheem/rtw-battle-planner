// Battle simulation: regiment AI, formations, melee, archery, morale and routing.
// Deterministic for a given battle plan, seed and fixed timestep, and free of DOM access so it
// runs under node:test.
//
// The sim pushes cosmetic events (clashes, deaths, volleys) onto state.events; the
// renderer drains them. It never reads anything back from the renderer.

import { createRng } from './rng.js';
import { BONUS, ARROW_BONUS } from './gen.js';

export const TIME_LIMIT = 240;
const BREAK_MORALE = 0.22;
const ARMY_BROKEN = 0.35; // fraction of an army still fighting below which morale drains
const CELL = 24;
// Formations: a block whose cohesion (share of men in their slots) is above FORM_MIN
// fights as a line; below it, every man fights for himself.
const FORM_MIN = 0.45;
const BRACE_MIN = 0.6; // cohesion a spear block needs to brace against a charge
const FRONT_ARC = 1.0; // half-angle a man in the line can strike into
const BREAK_RANKS = 3; // seconds a man hit from the flank fights on his own
// Companies ordered to hold their ground stand (archers still shoot) until an enemy
// comes this close, they're drawn into a fight, or they've lost this share of men.
const HOLD_RELEASE = { spear: 150, sword: 150, archer: 110, cavalry: 260 };
const HOLD_LOSSES = 0.15;

// Regiment targeting preference, lower = preferred (multiplies distance).
const PREF = {
  spear:   { spear: 1,   sword: 1,   archer: 1.1,  cavalry: 0.55 },
  sword:   { spear: 0.7, sword: 1,   archer: 0.8,  cavalry: 1.3 },
  archer:  { spear: 1,   sword: 1,   archer: 1,    cavalry: 0.9 },
  cavalry: { spear: 2.2, sword: 1,   archer: 0.45, cavalry: 0.9 },
};

const TAU = Math.PI * 2;
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// `gen` is the battle description from army.js toBattle(); `seed` drives the sim's
// own randomness, so one plan can be fought again with a different outcome.
export function createBattle(gen, seed) {
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0);
  const regiments = [];
  const soldiers = [];
  let id = 0;
  gen.regiments.forEach((g, ri) => {
    const d = g.design;
    const reg = {
      id: ri,
      team: g.team,
      design: d,
      type: d.type,
      name: g.name,
      count: g.count,
      cols: g.cols,
      alive: g.count,
      ax: g.x, ay: g.y, // formation anchor (centre)
      cx: g.x, cy: g.y, // centroid of the living
      facing: g.facing,
      soldiers: [],
      morale: 1,
      routed: false,
      gone: false,
      engaged: 0,
      target: null,
      retarget: rng.range(0.5, 1.5),
      reslot: 1,
      phase: d.type === 'cavalry' ? 'flank' : 'advance',
      hold: !!g.hold,
      phaseT: 0,
      meleeFor: rng.range(5, 8),
      side: rng.chance(0.5) ? 1 : -1,
      volley: rng.range(0.5, 2),
      cohesion: 1,
      pace: 0, // how fast the anchor actually moved last step, as a fraction of speed
      threat: null, // an enemy regiment that hit us from the flank or rear
      approach: 0, // cavalry: 1 / -1 = target's left / right, 0 = its rear
      kills: 0,
      losses: 0,
      fled: 0,
    };
    regiments.push(reg);
    for (let i = 0; i < g.count; i++) {
      const s = {
        id: id++,
        team: g.team,
        reg,
        d,
        x: 0, y: 0, vx: 0, vy: 0,
        angle: g.facing,
        r: d.r,
        hp: d.hp,
        maxHp: d.hp,
        alive: true,
        routing: false,
        fled: false,
        deathT: 0,
        slot: i,
        foe: null,
        foeT: rng.next() * 0.3,
        fighting: false,
        cd: rng.range(0, d.cooldown),
        charged: true,
        shot: -1,
        aim: null,
        hitT: -9,
        strikeT: -9,
        inLine: false,
        looseUntil: -9,
        slotDx: 0,
        slotDy: 0,
        kills: 0,
      };
      const [x, y] = slotPos(reg, i);
      s.x = x + rng.gauss() * 1.5;
      s.y = y + rng.gauss() * 1.5;
      reg.soldiers.push(s);
      soldiers.push(s);
    }
  });
  return {
    seed,
    field: gen.field,
    rng,
    time: 0,
    teams: gen.teams,
    place: gen.place,
    terrain: gen.terrain,
    arenaRadius: gen.arenaRadius,
    regiments,
    soldiers,
    arrows: [],
    events: [],
    log: [],
    broken: gen.teams.map(() => false),
    over: false,
    winner: null,
    timeout: false,
    grid: new Map(),
  };
}

// World position of formation slot i: rows behind each other, centred on the anchor.
export function slotPos(reg, i) {
  const n = Math.max(1, reg.alive);
  const cols = Math.min(reg.cols, n);
  const rows = Math.ceil(n / cols);
  const row = Math.floor(i / cols), col = i % cols;
  // The last, partial row is centred too.
  const inRow = row === rows - 1 ? n - row * cols : cols;
  const sp = reg.design.spacing;
  const along = ((rows - 1) / 2 - row) * sp;
  const lateral = (col - (inRow - 1) / 2) * sp;
  const c = Math.cos(reg.facing), s = Math.sin(reg.facing);
  return [reg.ax + along * c - lateral * s, reg.ay + along * s + lateral * c];
}

export function teamStats(state) {
  const stats = state.teams.map((team) => ({ team, alive: 0, total: 0, fallen: 0, fled: 0, hp: 0, maxHp: 0, strength: 0 }));
  for (const s of state.soldiers) {
    const t = stats[s.team];
    t.total++;
    t.maxHp += s.maxHp;
    if (s.fled) t.fled++;
    else if (!s.alive) t.fallen++;
    else if (!s.routing) {
      t.alive++;
      t.hp += s.hp;
    }
  }
  for (const t of stats) t.strength = t.maxHp ? t.hp / t.maxHp : 0;
  return stats;
}

// --- spatial grid ----------------------------------------------------------------

const key = (gx, gy) => (gx + 4096) * 8192 + (gy + 4096);

function buildGrid(state) {
  const g = state.grid;
  for (const cell of g.values()) cell.length = 0;
  for (const s of state.soldiers) {
    if (!s.alive) continue;
    const k = key(Math.floor(s.x / CELL), Math.floor(s.y / CELL));
    let cell = g.get(k);
    if (!cell) g.set(k, (cell = []));
    cell.push(s);
  }
}

const nearBuf = [];
// Soldiers in the cells overlapping a square around (x, y). Reuses one buffer.
function near(state, x, y, rad) {
  nearBuf.length = 0;
  const x0 = Math.floor((x - rad) / CELL), x1 = Math.floor((x + rad) / CELL);
  const y0 = Math.floor((y - rad) / CELL), y1 = Math.floor((y + rad) / CELL);
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const cell = state.grid.get(key(gx, gy));
      if (cell) for (const o of cell) nearBuf.push(o);
    }
  }
  return nearBuf;
}

function nearestEnemy(state, s, rad) {
  let best = null, bestD = rad * rad;
  for (const o of near(state, s.x, s.y, rad)) {
    if (o.team === s.team || !o.alive) continue;
    const d = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

// --- regiments -------------------------------------------------------------------

function pickTarget(state, reg) {
  let best = null, bestScore = Infinity;
  for (const e of state.regiments) {
    if (e.team === reg.team || e.alive === 0) continue;
    let pref = PREF[reg.type][e.type];
    // Pikes pinned by a fight to their front can't turn to face horsemen.
    if (reg.type === 'cavalry' && e.type === 'spear' && e.engaged > 0.3) pref = 0.8;
    let score = Math.hypot(e.cx - reg.cx, e.cy - reg.cy) * pref * (0.85 + 0.3 * state.rng.next());
    if (e.routed) score *= 4;
    if (e === reg.target) score *= 0.75;
    // Spread out: a target that friends are already engaging is less attractive.
    for (const f of state.regiments) if (f !== reg && f.target === e && f.team === reg.team && f.alive && !f.routed) score *= 1.3;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function setPhase(state, reg, phase) {
  reg.phase = phase;
  reg.phaseT = 0;
  if (phase === 'charge') {
    for (const s of reg.soldiers) s.charged = false;
    const t = reg.target;
    state.events.push({ type: 'charge', x: reg.cx, y: reg.cy, team: reg.team });
    if (t) state.log.push({ t: state.time, type: 'charge', name: reg.name, team: reg.team, target: t.name, targetTeam: t.team });
  }
}

function rout(state, reg) {
  reg.routed = true;
  reg.phase = 'rout';
  for (const s of reg.soldiers) {
    if (!s.alive) continue;
    s.routing = true;
    s.foe = null;
    s.shot = -1;
  }
  state.events.push({ type: 'rout', x: reg.cx, y: reg.cy, team: reg.team });
  state.log.push({ t: state.time, type: 'rout', name: reg.name, team: reg.team });
  // Panic spreads to nearby friends.
  const shock = 0.06 * Math.min(1.5, reg.count / 25);
  for (const o of state.regiments) {
    if (o === reg || o.team !== reg.team || o.routed || o.alive === 0) continue;
    if (Math.hypot(o.cx - reg.cx, o.cy - reg.cy) < 220) o.morale -= shock;
  }
}

function releaseHold(state, reg) {
  let free = reg.engaged > 0 || reg.losses >= reg.count * HOLD_LOSSES;
  for (const e of state.regiments) {
    if (free) break;
    if (e.team === reg.team || e.alive === 0 || e.routed) continue;
    free = Math.hypot(e.cx - reg.cx, e.cy - reg.cy) < HOLD_RELEASE[reg.type];
  }
  if (!free) return;
  reg.hold = false;
  reg.phaseT = 0;
  state.log.push({ t: state.time, type: 'release', name: reg.name, team: reg.team });
}

function updateRegiment(state, reg, dt) {
  let n = 0, sx = 0, sy = 0, fighting = 0, ox = 0, oy = 0;
  for (const s of reg.soldiers) {
    if (!s.alive) continue;
    n++;
    sx += s.x;
    sy += s.y;
    if (s.fighting) fighting++;
    const [px, py] = slotPos(reg, s.slot);
    s.slotDx = s.x - px;
    s.slotDy = s.y - py;
    ox += s.slotDx;
    oy += s.slotDy;
  }
  // Shape, not position: a block pressed back as a whole is still in order, so
  // measure each man against the block's average offset from its slots.
  let placed = 0;
  if (n) {
    ox /= n;
    oy /= n;
    const tol = reg.design.spacing * 1.1;
    for (const s of reg.soldiers) {
      if (s.alive && (s.slotDx - ox) ** 2 + (s.slotDy - oy) ** 2 < tol * tol) placed++;
    }
  }
  reg.alive = n;
  if (!n) {
    if (!reg.gone) {
      reg.gone = true;
      if (!reg.routed) state.log.push({ t: state.time, type: 'destroyed', name: reg.name, team: reg.team });
    }
    return;
  }
  reg.cx = sx / n;
  reg.cy = sy / n;
  reg.engaged = fighting / n;
  // Cohesion follows how many men are actually in their places, so wheeling, running
  // and men breaking ranks all disorder the block without any special rule.
  if (n) reg.cohesion = Math.max(0, reg.cohesion + (placed / n - reg.cohesion) * Math.min(1, dt * 1.5));
  if (reg.routed) return;

  // Morale: recovers out of contact, drains once the whole army is breaking.
  if (reg.engaged === 0 && reg.morale < 1) reg.morale = Math.min(1, reg.morale + 0.015 * dt);
  if (state.broken[reg.team]) reg.morale -= 0.05 * dt;
  if (reg.morale < BREAK_MORALE || n <= Math.max(2, reg.count * 0.12)) {
    rout(state, reg);
    return;
  }

  const d = reg.design;
  const rng = state.rng;
  reg.retarget -= dt;
  if (!reg.target || reg.target.alive === 0 || reg.retarget <= 0) {
    const prev = reg.target;
    reg.target = pickTarget(state, reg);
    reg.retarget = 3 + rng.next() * 2;
    // A cavalry charge that lost its target lines up again on the new one.
    if (reg.type === 'cavalry' && prev && prev !== reg.target && reg.phase === 'charge') reg.phase = 'melee';
  }
  // Hit in the flank while not fighting to the front: turn to meet it.
  const threat = reg.threat;
  reg.threat = null;
  if (threat && threat !== reg.target && threat.alive && !threat.routed && reg.engaged < 0.15 && reg.type !== 'cavalry') {
    reg.target = threat;
    reg.retarget = 3 + rng.next() * 2;
  }
  if (reg.hold) releaseHold(state, reg);
  const t = reg.target;
  let gx = reg.ax, gy = reg.ay, face = reg.facing, pace = 0;

  if (t) {
    const dx = t.cx - reg.cx, dy = t.cy - reg.cy;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    face = Math.atan2(dy, dx);
    if (reg.type === 'spear' || reg.type === 'sword') {
      gx = t.cx;
      gy = t.cy;
      pace = dist > 160 ? 0.75 : 1;
      // Spears plant and brace against an oncoming charge.
      if (reg.type === 'spear' && t.type === 'cavalry' && dist < 140 && !t.routed) pace = 0.15;
      if (reg.type === 'spear') {
        // Horsemen coming for us take priority: wheel to face them and stand.
        for (const e of state.regiments) {
          if (e.team === reg.team || e.type !== 'cavalry' || e.target !== reg || e.routed || e.alive === 0) continue;
          if (e.phase !== 'charge' && e.phase !== 'flank') continue;
          if (Math.hypot(e.cx - reg.cx, e.cy - reg.cy) > 220) continue;
          face = Math.atan2(e.cy - reg.cy, e.cx - reg.cx);
          gx = reg.ax;
          gy = reg.ay;
          pace = 0.1;
          break;
        }
      }
    } else if (reg.type === 'archer') {
      const range = d.ranged.range;
      if (dist > range * 0.88) {
        gx = t.cx;
        gy = t.cy;
        pace = 0.8;
      } else if (dist < range * 0.35 && t.type !== 'archer' && !t.routed) {
        gx = reg.cx - ux * 80;
        gy = reg.cy - uy * 80;
        pace = 0.7;
      }
      reg.volley -= dt;
      if (reg.volley <= 0) {
        let aim = dist <= range + 15 ? t : null;
        if (!aim) {
          for (const e of state.regiments) {
            if (e.team === reg.team || e.alive === 0) continue;
            if (Math.hypot(e.cx - reg.cx, e.cy - reg.cy) <= range) { aim = e; break; }
          }
        }
        if (aim) {
          for (const s of reg.soldiers) {
            if (!s.alive || s.fighting) continue;
            s.shot = rng.next() * 0.7;
            s.aim = aim;
          }
          reg.volley = d.ranged.cooldown * (0.9 + 0.2 * rng.next());
        } else {
          reg.volley = 0.3;
        }
      }
    } else if (!reg.hold) {
      reg.phaseT += dt;
      if (reg.phase === 'flank' || reg.phase === 'advance') {
        // Ride for the target's side or rear (relative to the way it faces), then charge.
        const fx = Math.cos(t.facing), fy = Math.sin(t.facing);
        const R = 150;
        const point = (side) => side === 0
          ? [t.cx - fx * R, t.cy - fy * R]
          : [t.cx - fy * side * R - fx * 30, t.cy + fx * side * R - fy * 30];
        if (reg.phaseT === dt) {
          // Pick the nearest approach on entering the phase, then stick with it.
          let bestD = Infinity;
          for (const side of [1, -1, 0]) {
            const [px, py] = point(side);
            const pd = Math.hypot(px - reg.cx, py - reg.cy);
            if (pd < bestD) { bestD = pd; reg.approach = side; }
          }
        }
        const [px, py] = point(reg.approach);
        const fromFront = Math.abs(wrap(Math.atan2(reg.cy - t.cy, reg.cx - t.cx) - t.facing)) < FRONT_ARC;
        const open = t.type === 'archer' || t.routed || t.cohesion < FORM_MIN;
        if ((open && dist < 230) || Math.hypot(px - reg.cx, py - reg.cy) < 50 || (dist < 160 && !fromFront) || reg.phaseT > 16) {
          setPhase(state, reg, 'charge');
        } else {
          gx = px;
          gy = py;
          face = Math.atan2(gy - reg.cy, gx - reg.cx);
          pace = 1;
        }
      }
      if (reg.phase === 'charge') {
        gx = t.cx + ux * 40;
        gy = t.cy + uy * 40;
        pace = 1;
        if (reg.engaged > 0.25 || reg.phaseT > 12) setPhase(state, reg, 'melee');
      } else if (reg.phase === 'melee') {
        gx = t.cx;
        gy = t.cy;
        pace = 0.8;
        if (reg.phaseT > reg.meleeFor && !t.routed) setPhase(state, reg, 'withdraw');
      } else if (reg.phase === 'withdraw') {
        gx = reg.cx - ux * 200;
        gy = reg.cy - uy * 200;
        face = Math.atan2(-uy, -ux);
        pace = 1;
        if (reg.phaseT > 3.5) {
          reg.target = pickTarget(state, reg);
          reg.meleeFor = rng.range(5, 8);
          setPhase(state, reg, 'flank');
        }
      }
    }
  }

  // Holding: stand fast, only turning to face an enemy that's already close.
  if (reg.hold) {
    gx = reg.ax;
    gy = reg.ay;
    pace = 0;
    if (!t || Math.hypot(t.cx - reg.cx, t.cy - reg.cy) > 260) face = reg.facing;
  }

  // Keep inside the field.
  const rc = Math.hypot(gx, gy);
  const lim = state.arenaRadius - 40;
  if (rc > lim) {
    gx *= lim / rc;
    gy *= lim / rc;
  }

  const ad = Math.hypot(gx - reg.ax, gy - reg.ay);
  const stepLen = d.speed * pace * dt;
  reg.pace = 0;
  if (ad > 0.5 && stepLen > 0) {
    const k = Math.min(1, stepLen / ad);
    reg.ax += (gx - reg.ax) * k;
    reg.ay += (gy - reg.ay) * k;
    reg.pace = (ad * k) / (d.speed * dt);
  }
  // The anchor can't run away from the men: it stays near their centroid. Once the
  // block is in contact it only leans in, or the rear ranks would crush into the front.
  const lag = Math.hypot(reg.ax - reg.cx, reg.ay - reg.cy);
  const maxLag = reg.engaged > 0.05 && reg.type !== 'cavalry' ? 4 : 16 + d.spacing * 2;
  if (lag > maxLag) {
    reg.ax = reg.cx + ((reg.ax - reg.cx) * maxLag) / lag;
    reg.ay = reg.cy + ((reg.ay - reg.cy) * maxLag) / lag;
  }
  // Friendly blocks keep their own ground instead of merging into one crowd.
  const half = (reg.cols * d.spacing) / 2;
  for (const o of state.regiments) {
    if (o === reg || o.team !== reg.team || o.routed || o.alive === 0) continue;
    const dx = reg.ax - o.ax, dy = reg.ay - o.ay;
    const dist = Math.hypot(dx, dy) || 0.01;
    const minD = half + (o.cols * o.design.spacing) / 2 + 8;
    if (dist < minD) {
      const push = Math.min(minD - dist, 25 * dt);
      reg.ax += (dx / dist) * push;
      reg.ay += (dy / dist) * push;
    }
  }
  const turn = reg.type === 'cavalry' ? 1.6 : 0.8;
  reg.facing = wrap(reg.facing + clamp(wrap(face - reg.facing), -turn * dt, turn * dt));

  // Close ranks: renumber the living so the block shrinks instead of thinning out.
  reg.reslot -= dt;
  if (reg.reslot <= 0) {
    reg.reslot = 1;
    let i = 0;
    for (const s of reg.soldiers) if (s.alive) s.slot = i++;
  }
}

// --- soldiers --------------------------------------------------------------------

function strike(state, att, def) {
  const d = att.d;
  const rng = state.rng;
  const dreg = def.reg;
  let mult = BONUS[d.type][def.d.type] * (0.8 + 0.4 * rng.next());
  // Where the blow comes from, relative to the way the defender faces.
  const rel = Math.abs(wrap(Math.atan2(att.y - def.y, att.x - def.x) - def.angle));
  const front = rel <= FRONT_ARC;
  if (d.charge && !att.charged) {
    att.charged = true;
    if (Math.hypot(att.vx, att.vy) > d.speed * 0.55) {
      const braced = def.d.type === 'spear' && def.inLine && front &&
        dreg.cohesion > BRACE_MIN && dreg.pace < 0.4;
      state.events.push({ type: 'impact', x: def.x, y: def.y, kind: braced ? 'braced' : front ? 'front' : 'flank' });
      if (braced) {
        // Riding onto a planted hedge of spears: no charge bonus, and the horse is impaled.
        mult *= 0.5;
        hurt(state, att, def.d.dmg * BONUS.spear.cavalry * 2 * (1 - d.armor), def, false);
      } else {
        mult *= d.charge * (def.inLine && front ? 0.6 : 1);
        dreg.morale -= front ? 0.006 : 0.015;
        dreg.cohesion = Math.max(0, dreg.cohesion - (front ? 0.02 : 0.05));
      }
    }
  }
  if (rel > 2) {
    // Blows from behind land harder and shake the line.
    mult *= 1.5;
    dreg.morale -= 0.003;
  } else if (!front) {
    mult *= 1.2;
  }
  if (def.inLine) {
    if (front) {
      // Shields locked and ranks behind: the line shrugs off blows from the front.
      mult *= 1 - 0.3 * dreg.cohesion;
    } else {
      // Hit from the side, the man turns to fight on his own and the block wavers.
      def.looseUntil = state.time + BREAK_RANKS;
      dreg.cohesion = Math.max(0, dreg.cohesion - 0.01);
      dreg.threat = att.reg;
    }
  }
  if (att.inLine) mult *= 1 + 0.25 * att.reg.cohesion;
  att.cd = d.cooldown * (0.85 + 0.3 * rng.next());
  att.strikeT = state.time;
  if (def.alive) hurt(state, def, d.dmg * mult * (1 - def.d.armor), att.alive ? att : null, false);
}

function hurt(state, s, dmg, att, ranged) {
  s.hp -= dmg;
  s.hitT = state.time;
  state.events.push({ type: ranged ? 'arrowhit' : 'clash', x: s.x, y: s.y, amount: dmg, horse: s.d.type === 'cavalry' });
  if (s.hp <= 0) kill(state, s, att);
}

function kill(state, s, att) {
  s.alive = false;
  s.hp = 0;
  s.deathT = state.time;
  const reg = s.reg;
  reg.losses++;
  if (!reg.routed) reg.morale -= 1.35 / (reg.count * s.d.discipline);
  if (att) {
    att.kills++;
    att.reg.kills++;
  }
  state.events.push({ type: 'death', x: s.x, y: s.y, angle: s.angle, soldier: s });
}

function loose(state, s) {
  const aim = s.aim;
  s.aim = null;
  if (!aim || aim.alive === 0) return;
  const rng = state.rng;
  let tgt = null;
  for (let k = 0; k < 4 && !tgt; k++) {
    const c = aim.soldiers[Math.floor(rng.next() * aim.soldiers.length)];
    if (c.alive) tgt = c;
  }
  if (!tgt) return;
  const r = s.d.ranged;
  const dist = Math.hypot(tgt.x - s.x, tgt.y - s.y);
  if (dist > r.range * 1.1) return;
  const time = dist / r.speed;
  const err = dist * r.spread;
  s.angle = Math.atan2(tgt.y - s.y, tgt.x - s.x);
  state.arrows.push({
    x0: s.x, y0: s.y,
    x1: tgt.x + tgt.vx * time + rng.gauss() * err,
    y1: tgt.y + tgt.vy * time + rng.gauss() * err,
    t: 0,
    dur: Math.max(0.2, time),
    h: dist * r.arc,
    dmg: r.dmg,
    pierce: r.pierce,
    bolt: r.bolt,
    team: s.team,
    owner: s,
  });
  state.events.push({ type: 'loose', bolt: r.bolt, x: s.x, y: s.y });
}

function move(s, dt, dirX, dirY, speed, faceA) {
  const d = s.d;
  if (d.type === 'cavalry') {
    // Horses go where they face: turn toward the goal, then gallop.
    let diff = 0;
    if (dirX || dirY) {
      diff = wrap(Math.atan2(dirY, dirX) - s.angle);
      s.angle = wrap(s.angle + clamp(diff, -d.turn * dt, d.turn * dt));
    } else if (faceA !== null) {
      s.angle = wrap(s.angle + clamp(wrap(faceA - s.angle), -d.turn * dt, d.turn * dt));
    }
    const want = speed * Math.max(0.15, Math.cos(diff));
    const cur = Math.hypot(s.vx, s.vy);
    const next = cur + clamp(want - cur, -d.accel * 2 * dt, d.accel * dt);
    s.vx = Math.cos(s.angle) * next;
    s.vy = Math.sin(s.angle) * next;
  } else {
    const tvx = dirX * speed, tvy = dirY * speed;
    let ddx = tvx - s.vx, ddy = tvy - s.vy;
    const dm = Math.hypot(ddx, ddy);
    const max = d.accel * dt;
    if (dm > max) {
      ddx *= max / dm;
      ddy *= max / dm;
    }
    s.vx += ddx;
    s.vy += ddy;
    const v = Math.hypot(s.vx, s.vy);
    const want = faceA ?? (v > 4 ? Math.atan2(s.vy, s.vx) : s.reg.facing);
    s.angle = wrap(s.angle + clamp(wrap(want - s.angle), -d.turn * dt, d.turn * dt));
  }
  s.x += s.vx * dt;
  s.y += s.vy * dt;
}

function flee(state, s, dt) {
  const [hx, hy] = state.teams[s.team].home;
  let dx = hx, dy = hy;
  const e = nearestEnemy(state, s, 50);
  if (e) {
    const ex = s.x - e.x, ey = s.y - e.y;
    const ed = Math.hypot(ex, ey) || 1;
    dx += (ex / ed) * 1.2;
    dy += (ey / ed) * 1.2;
  }
  const len = Math.hypot(dx, dy) || 1;
  move(s, dt, dx / len, dy / len, s.d.speed * 1.1, null);
  if (Math.hypot(s.x, s.y) > state.arenaRadius + 200) {
    s.alive = false;
    s.fled = true;
    s.reg.fled++;
  }
}

function updateSoldier(state, s, dt) {
  const d = s.d;
  const reg = s.reg;
  if (s.cd > 0) s.cd -= dt;
  s.fighting = false;
  if (s.routing) {
    flee(state, s, dt);
    return;
  }

  const withdrawing = reg.phase === 'withdraw';
  s.inLine = (d.type === 'spear' || d.type === 'sword') && reg.cohesion > FORM_MIN && state.time > s.looseUntil;
  if (s.inLine) {
    holdLine(state, s, dt);
    return;
  }
  const sense = d.type === 'cavalry' ? (reg.phase === 'charge' ? 70 : 45) : d.type === 'archer' ? 28 : reg.engaged > 0.1 ? 50 : 34;
  s.foeT -= dt;
  if (withdrawing) s.foe = null;
  else if (s.foeT <= 0 || !s.foe?.alive) {
    s.foe = nearestEnemy(state, s, sense);
    s.foeT = 0.25 + state.rng.next() * 0.25;
  }

  let dirX = 0, dirY = 0, speed = 0, faceA = null;
  const foe = s.foe;
  if (foe?.alive) {
    const dx = foe.x - s.x, dy = foe.y - s.y;
    const dist = Math.hypot(dx, dy) || 0.01;
    const reach = d.reach + s.r + foe.r;
    if (dist > sense * 1.6) {
      s.foe = null;
    } else {
      s.fighting = dist < reach + 12;
      faceA = Math.atan2(dy, dx);
      if (dist > reach * 0.85) {
        dirX = dx / dist;
        dirY = dy / dist;
        speed = d.speed;
      } else if (d.type === 'cavalry' && !s.charged) {
        // Ride on through.
        dirX = dx / dist;
        dirY = dy / dist;
        speed = d.speed;
      }
      if (dist <= reach && s.cd <= 0 && Math.abs(wrap(faceA - s.angle)) < 1.2) strike(state, s, foe);
    }
  }
  if (!s.foe) {
    const [tx, ty] = slotPos(reg, s.slot);
    const dx = tx - s.x, dy = ty - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      dirX = dx / dist;
      dirY = dy / dist;
      speed = Math.min(d.speed * 1.15, dist * 3);
    }
    if (dist < 6) faceA = reg.facing;
  }

  if (s.shot >= 0) {
    if (s.fighting) s.shot = -1;
    else {
      s.shot -= dt;
      if (s.shot < 0) loose(state, s);
    }
  }
  move(s, dt, dirX, dirY, speed, faceA);
}

// A man in a formed block keeps his place, faces with the block and only strikes
// into his front arc: the front ranks fight, and pikes reach past the first rank.
function holdLine(state, s, dt) {
  const d = s.d;
  const reg = s.reg;
  s.foe = null;
  const reach = d.reach + s.r;
  let best = null, bestD = Infinity, nearestD = Infinity;
  for (const o of near(state, s.x, s.y, reach + 18)) {
    if (o.team === s.team || !o.alive) continue;
    const dist = Math.hypot(o.x - s.x, o.y - s.y);
    if (dist < nearestD) nearestD = dist;
    if (dist > reach + o.r || dist >= bestD) continue;
    if (Math.abs(wrap(Math.atan2(o.y - s.y, o.x - s.x) - s.angle)) < FRONT_ARC) {
      best = o;
      bestD = dist;
    }
  }
  s.fighting = nearestD < reach + 12;
  if (best && s.cd <= 0) strike(state, s, best);

  const [tx, ty] = slotPos(reg, s.slot);
  const dx = tx - s.x, dy = ty - s.y;
  const dist = Math.hypot(dx, dy);
  let dirX = 0, dirY = 0, speed = 0;
  if (dist > 0.5) {
    dirX = dx / dist;
    dirY = dy / dist;
    speed = Math.min(d.speed * 1.15, dist * 3);
  }
  move(s, dt, dirX, dirY, speed, reg.facing);
}

// Bodies don't overlap: shove apart, with horses much heavier than men.
function separate(state) {
  for (const s of state.soldiers) {
    if (!s.alive) continue;
    for (const o of near(state, s.x, s.y, s.r + 6)) {
      if (o.id <= s.id || !o.alive) continue;
      let dx = o.x - s.x, dy = o.y - s.y;
      const min = s.r + o.r + 0.6;
      const dd = dx * dx + dy * dy;
      if (dd >= min * min) continue;
      let dist = Math.sqrt(dd);
      if (dist < 0.01) {
        dx = 0.01 * (s.id % 2 ? 1 : -1);
        dy = 0.01;
        dist = Math.hypot(dx, dy);
      }
      const push = (min - dist) / dist;
      const ms = s.d.mass, mo = o.d.mass;
      const ks = mo / (ms + mo), ko = ms / (ms + mo);
      s.x -= dx * push * ks;
      s.y -= dy * push * ks;
      o.x += dx * push * ko;
      o.y += dy * push * ko;
    }
  }
}

function updateArrows(state, dt) {
  for (const a of state.arrows) {
    a.t += dt;
    if (a.t < a.dur) continue;
    let best = null, bestD = Infinity;
    for (const o of near(state, a.x1, a.y1, 8)) {
      if (o.team === a.team || !o.alive) continue;
      const d = Math.hypot(o.x - a.x1, o.y - a.y1);
      if (d < o.r * 0.9 + 0.5 && d < bestD) { bestD = d; best = o; }
    }
    if (best) {
      let dmg = a.dmg * ARROW_BONUS[best.d.type] * (1 - best.d.armor * (1 - a.pierce));
      // Shields only help against arrows coming from the front.
      const from = wrap(Math.atan2(a.y0 - best.y, a.x0 - best.x) - best.angle);
      if (best.d.shield && Math.abs(from) < 1.6) dmg *= 1 - best.d.shield;
      hurt(state, best, dmg, a.owner, true);
    } else {
      state.events.push({ type: 'miss', x: a.x1, y: a.y1, angle: Math.atan2(a.y1 - a.y0, a.x1 - a.x0), bolt: a.bolt });
    }
    a.done = true;
  }
  state.arrows = state.arrows.filter((a) => !a.done);
}

function checkEnd(state) {
  const stats = teamStats(state);
  for (const t of stats) state.broken[t.team.index] = t.alive < t.total * ARMY_BROKEN;
  if (state.over) return;
  const standing = stats.filter((t) => t.alive > 0);
  if (standing.length <= 1) {
    state.over = true;
    state.winner = standing[0]?.team ?? null;
    state.endT = state.time;
  } else if (state.time >= TIME_LIMIT) {
    standing.sort((a, b) => b.strength - a.strength);
    state.over = true;
    state.timeout = true;
    state.winner = standing[0].team;
    state.endT = state.time;
  }
}

export function step(state, dt) {
  state.time += dt;
  buildGrid(state);
  for (const reg of state.regiments) updateRegiment(state, reg, dt);
  for (const s of state.soldiers) if (s.alive) updateSoldier(state, s, dt);
  separate(state);
  updateArrows(state, dt);
  checkEnd(state);
}
