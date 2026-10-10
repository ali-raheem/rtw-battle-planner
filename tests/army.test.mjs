import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../js/rng.js';
import { designFor } from '../js/gen.js';
import {
  newPlan, randomArmy, zone, company, footprint, overlaps, contains, clampToZone, blocked, findSpot,
  sideCost, sideMen, mirror, toBattle, encode, decode, MAX_MEN,
} from '../js/army.js';

const inZone = (u) => {
  const z = zone(u.side);
  const c = clampToZone({ ...u });
  return Math.abs(c.x - u.x) < 1e-6 && Math.abs(c.y - u.y) < 1e-6 && u.x > z.x0 && u.x < z.x1 && u.y > z.y0 && u.y < z.y1;
};

test('random armies fit their budget, their ground and each other', () => {
  for (let seed = 0; seed < 150; seed++) {
    const plan = newPlan(seed);
    for (const side of [0, 1]) {
      assert.ok(sideCost(plan, side) <= plan.budget + 1e-6, `seed ${seed}: over budget`);
      assert.ok(sideMen(plan, side) <= MAX_MEN);
      assert.ok(plan.units.some((u) => u.side === side), `seed ${seed}: side ${side} empty`);
    }
    for (const u of plan.units) {
      assert.ok(inZone(u), `seed ${seed}: ${u.key} off its ground`);
      const d = designFor(u.key);
      assert.ok(u.n >= d.min && u.n <= d.max && u.c >= 1 && u.c <= u.n);
    }
    const clashes = plan.units.filter((u) => blocked(plan, u)).length;
    assert.ok(clashes === 0, `seed ${seed}: ${clashes} overlapping companies`);
  }
});

test('overlap and hit tests follow the rotated block', () => {
  const a = company(0, 'spear:0', 0, 300); // 32 men, 8 wide: 57.6 × 28.8, facing up
  const { hw, hd } = footprint(a);
  assert.ok(hw > hd);
  assert.ok(contains(a, hw - 1, 300) && !contains(a, hw + 2, 300));
  assert.ok(contains(a, 0, 300 + hd - 1) && !contains(a, 0, 300 + hd + 2));
  const b = { ...a, x: hw * 2 + 10 };
  assert.ok(!overlaps(a, b));
  b.f = 0; // turned side-on, it now reaches into a's block
  b.x = hw + hd + 1;
  assert.ok(overlaps(a, b));
});

test('findSpot finds the nearest free ground, or null when the zone is full', () => {
  const plan = { units: [company(0, 'spear:0', 0, 300)] };
  const u = company(0, 'spear:0', 0, 300);
  const spot = findSpot(plan, u);
  assert.ok(spot);
  [u.x, u.y] = spot;
  assert.ok(!blocked(plan, u) && inZone(u));
  assert.ok(Math.hypot(u.x, u.y - 300) < 60, 'close to where it was dropped');
  // Fill the ground and there's no room left.
  const full = { units: [] };
  for (let x = -500; x <= 500; x += 64) for (let y = 125; y <= 450; y += 34) full.units.push(company(0, 'spear:0', x, y));
  assert.equal(findSpot(full, company(0, 'spear:0', 0, 300)), null);
});

test('plans survive the share link', () => {
  const plan = newPlan(99);
  plan.units[0].hold = true;
  plan.budget = 0;
  const back = decode(encode(plan));
  assert.equal(back.budget, 0);
  assert.equal(back.units.length, plan.units.length);
  assert.equal(back.units[0].hold, true);
  assert.deepEqual(back.sides.map((s) => s.name), plan.sides.map((s) => s.name));
  for (const [i, u] of back.units.entries()) {
    assert.equal(u.key, plan.units[i].key);
    assert.ok(Math.abs(u.x - plan.units[i].x) <= 0.5 && Math.abs(u.f - plan.units[i].f) < 0.001);
  }
  assert.equal(encode(back), encode(decode(encode(back))), 'stable once rounded');
});

test('decode rejects junk and sanitises hostile values', () => {
  for (const junk of ['', 'abc', btoa('{"v":2}'), btoa('[]'), '%%%']) assert.equal(decode(junk), null);
  const evil = btoa(JSON.stringify({
    v: 1, b: 1e9, t: 'lava', s: -5, p: '<img src=x>', a: [['x'.repeat(500), 1, 'nope', 'red']],
    u: [[0, 'spear:0', 1e6, -3, 1e9, -1e9, 99, 1], [0, 'dragon:0', 10, 5, 0, 300, 0, 0], 'oops'],
  }));
  const p = decode(evil);
  assert.ok(p);
  assert.equal(p.terrain, 'meadow');
  assert.equal(p.budget, 5000);
  assert.equal(p.units.length, 1);
  const u = p.units[0];
  assert.equal(u.n, designFor('spear:0').max);
  assert.ok(u.c >= 1 && inZone(u));
  assert.ok(p.sides[0].name.length <= 60);
  assert.match(p.sides[0].metal, /^#[0-9a-f]{6}$/i);
});

test('mirror reflects your army onto the enemy ground', () => {
  const plan = mirror(newPlan(5));
  const mine = plan.units.filter((u) => u.side === 0), theirs = plan.units.filter((u) => u.side === 1);
  assert.equal(mine.length, theirs.length);
  theirs.forEach((u, i) => {
    assert.equal(u.y, -mine[i].y);
    assert.ok(inZone(u));
  });
  assert.equal(sideCost(plan, 0), sideCost(plan, 1));
});

test('toBattle names companies by kind, numbering repeats per side', () => {
  const plan = newPlan(1);
  plan.units = [company(0, 'spear:1', -100, 300), company(0, 'spear:1', 100, 300), company(0, 'cavalry:1', 300, 300), company(1, 'spear:1', 0, -300)];
  const g = toBattle(plan);
  assert.deepEqual(g.regiments.map((r) => r.name), ['1st Pikemen', '2nd Pikemen', 'Knights', 'Pikemen']);
  assert.deepEqual(g.teams.map((t) => t.home), [[0, 1], [0, -1]]);
});

test('randomArmy respects a small budget', () => {
  const units = randomArmy(createRng(4), 1, 60);
  const cost = units.reduce((t, u) => t + u.n * designFor(u.key).cost, 0);
  assert.ok(units.length > 0 && cost <= 60 + 1e-6);
});
