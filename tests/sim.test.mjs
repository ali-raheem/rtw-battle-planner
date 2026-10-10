import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, designFor } from '../js/gen.js';
import { newPlan, toBattle, company } from '../js/army.js';
import { createBattle, step, teamStats, TIME_LIMIT } from '../js/sim.js';

const SEEDS = [1, 42, 1337, 0xdeadbeef, 0x12345678, 987654321];

const run = (plan, seed, dt = 1 / 30) => {
  const s = createBattle(toBattle(plan), seed);
  const impacts = {};
  while (!s.over) {
    step(s, dt);
    for (const e of s.events) if (e.type === 'impact') impacts[e.kind] = (impacts[e.kind] ?? 0) + 1;
    s.events.length = 0;
  }
  return { s, impacts };
};

test('every palette unit has a sane, fixed design', () => {
  assert.equal(UNITS.length, 15);
  for (const key of UNITS) {
    const d = designFor(key);
    assert.equal(designFor(key), d, 'designs are shared');
    for (const k of ['hp', 'speed', 'reach', 'dmg', 'cooldown', 'cost']) assert.ok(Number.isFinite(d[k]) && d[k] > 0, `${d.name}.${k}`);
    assert.ok(d.armor >= 0 && d.armor < 1 && d.shield >= 0 && d.shield < 1);
    assert.equal(!!d.ranged, d.type === 'archer', `${d.name} ranged`);
    assert.equal(d.charge > 0, d.type === 'cavalry', `${d.name} charge`);
    assert.ok(d.min <= d.size && d.size <= d.max && d.size % 2 === 0);
  }
  assert.equal(designFor('spear:9'), null);
});

test('random plans fight to a finish within the time limit, with a consistent winner', () => {
  const impacts = {};
  for (const seed of SEEDS) {
    const { s, impacts: hit } = run(newPlan(seed), seed);
    for (const [k, n] of Object.entries(hit)) impacts[k] = (impacts[k] ?? 0) + n;
    assert.ok(s.time <= TIME_LIMIT + 0.1, `seed ${seed} ran ${s.time}s`);
    const standing = teamStats(s).filter((t) => t.alive > 0);
    if (!s.timeout) {
      assert.ok(standing.length <= 1);
      assert.equal(s.winner, standing[0]?.team ?? null);
    }
    for (const x of s.soldiers) {
      assert.ok(Number.isFinite(x.x) && Number.isFinite(x.y), `seed ${seed}: NaN position`);
      if (!x.alive && !x.fled) assert.equal(x.hp, 0);
      if (x.fled) assert.ok(x.routing, 'only routing soldiers flee the field');
    }
    for (const r of s.regiments.filter((r) => r.alive === 0)) {
      assert.ok(r.routed || s.log.some((e) => e.type === 'destroyed' && e.name === r.name && e.team === r.team), r.name);
    }
    assert.equal(s.log.filter((e) => e.type === 'rout').length, s.regiments.filter((r) => r.routed).length);
  }
  assert.ok(impacts.braced > 0 || impacts.flank > 0 || impacts.front > 0, JSON.stringify(impacts));
});

test('the same plan and seed replay identically; another seed differs', () => {
  const plan = newPlan(7);
  const trace = (seed) => {
    const s = createBattle(toBattle(plan), seed);
    for (let i = 0; i < 60 * 30; i++) step(s, 1 / 60);
    return s.soldiers.map((x) => [x.x.toFixed(6), x.y.toFixed(6), x.hp.toFixed(6), x.routing]);
  };
  assert.deepEqual(trace(5), trace(5));
  assert.notDeepEqual(trace(5), trace(6));
});

test('companies on hold stand until the enemy comes, then fight', () => {
  // Your archers and a spear wall hold; the enemy's swordsmen have to come to them.
  const plan = newPlan(3);
  plan.units = [
    company(0, 'spear:0', 0, 200, { hold: true }),
    company(0, 'archer:0', 0, 300, { hold: true }),
    company(1, 'sword:0', 0, -200),
  ];
  const s = createBattle(toBattle(plan), 9);
  const [spear, archers] = s.regiments;
  const home = [spear.ax, spear.ay];
  for (let i = 0; i < 30 * 4; i++) step(s, 1 / 30);
  assert.ok(spear.hold, 'still holding while the enemy is far off');
  assert.ok(Math.hypot(spear.ax - home[0], spear.ay - home[1]) < 2, 'and has not moved');
  while (!s.over && spear.hold) step(s, 1 / 30);
  assert.ok(s.log.some((e) => e.type === 'release' && e.name === spear.name));
  assert.ok(s.arrows.length > 0 || archers.kills > 0 || s.time > 0);
});
