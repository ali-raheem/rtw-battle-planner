// Unit tables and designs: per-soldier stats for every unit in the palette, the
// melee bonus table, doctrines (for random armies) and banner names.
// Pure data, no DOM.

import { PATTERNS } from './heraldry.js';

// Per-soldier base stats. Variants scale them: `mul` multiplies, `add` adds.
export const UNIT_TYPES = {
  spear: {
    label: 'Spearmen', hp: 150, armor: [0.15, 0.3], shield: 0.3, speed: 28, accel: 70, turn: 5, r: 3.2,
    reach: 12, dmg: [5, 7], cooldown: [1.1, 1.4], cost: 1, size: [24, 40], cols: [6, 9], spacing: 7.2,
    variants: [
      { name: 'Spearmen' },
      { name: 'Pikemen', shield: 0, mul: { reach: 1.45, dmg: 0.9, speed: 0.92, cost: 1.1 } },
      { name: 'Halberdiers', shield: 0.1, add: { armor: 0.06 }, mul: { reach: 0.9, dmg: 1.3, cost: 1.2 } },
      { name: 'Billmen', shield: 0.15, mul: { dmg: 1.1, cost: 0.95 } },
    ],
  },
  sword: {
    label: 'Swordsmen', hp: 180, armor: [0.25, 0.4], shield: 0.55, speed: 30, accel: 80, turn: 6, r: 3.3,
    reach: 7, dmg: [7, 10], cooldown: [0.9, 1.2], cost: 1.4, size: [16, 32], cols: [5, 8], spacing: 7.2,
    variants: [
      { name: 'Swordsmen' },
      { name: 'Men-at-Arms', add: { armor: 0.12 }, mul: { hp: 1.1, speed: 0.9, cost: 1.2 } },
      { name: 'Axemen', shield: 0.35, mul: { dmg: 1.3, cost: 1.05 } },
      { name: 'Huscarls', mul: { hp: 1.25, dmg: 1.1, cost: 1.3, discipline: 1.2 } },
    ],
  },
  archer: {
    label: 'Archers', hp: 110, armor: [0.05, 0.18], shield: 0, speed: 32, accel: 80, turn: 6, r: 3,
    reach: 6, dmg: [2, 4], cooldown: [1.2, 1.6], cost: 1.2, size: [16, 32], cols: [8, 12], spacing: 7.5,
    ranged: { dmg: [7, 11], range: [270, 340], cooldown: [3.6, 4.8], speed: [240, 280], spread: 0.09 },
    variants: [
      { name: 'Archers' },
      { name: 'Longbowmen', mul: { range: 1.2, rdmg: 1.05, cost: 1.15 } },
      { name: 'Crossbowmen', bolt: true, pierce: 0.5, shield: 0.35, add: { armor: 0.1 },
        mul: { rdmg: 1.6, rcooldown: 1.7, range: 0.85, spread: 0.6, rspeed: 1.5 } },
    ],
  },
  cavalry: {
    label: 'Cavalry', hp: 300, armor: [0.2, 0.35], shield: 0.2, speed: 80, accel: 60, turn: 2.6, r: 5,
    reach: 9, dmg: [8, 11], cooldown: [1.2, 1.6], cost: 2.8, size: [8, 18], cols: [4, 6], spacing: 12, charge: 12, discipline: 1.5,
    variants: [
      { name: 'Horsemen' },
      { name: 'Knights', lance: true, add: { armor: 0.12 }, mul: { hp: 1.2, speed: 0.9, charge: 1.2, cost: 1.25 } },
      { name: 'Lancers', lance: true, mul: { charge: 1.35, cost: 1.1 } },
      { name: 'Light Horse', shield: 0, add: { armor: -0.12 }, mul: { hp: 0.75, speed: 1.2, dmg: 0.85, cost: 0.75 } },
    ],
  },
};
export const TYPE_ORDER = Object.keys(UNIT_TYPES);

// Melee damage multiplier, attacker type → defender type.
export const BONUS = {
  spear:   { spear: 1,   sword: 1,   archer: 1.1, cavalry: 2.4 },
  sword:   { spear: 1.5, sword: 1,   archer: 1.3, cavalry: 0.9 },
  archer:  { spear: 1,   sword: 0.8, archer: 1,   cavalry: 0.8 },
  cavalry: { spear: 0.6, sword: 1,   archer: 1.8, cavalry: 1 },
};
// Arrows find a horse an easy target.
export const ARROW_BONUS = { spear: 1, sword: 1, archer: 1, cavalry: 1.1 };

export const DOCTRINES = {
  'Shield Wall':   { w: { spear: 3,   sword: 4,   archer: 1,   cavalry: 0.3 } },
  'Longbow':       { w: { spear: 1.5, sword: 1,   archer: 4.5, cavalry: 0.6 } },
  'Chivalry':      { w: { spear: 1,   sword: 1.5, archer: 0.8, cavalry: 4 } },
  'Pike Square':   { w: { spear: 5,   sword: 1,   archer: 1.5, cavalry: 0.5 } },
  'Combined Arms': { w: { spear: 2,   sword: 2,   archer: 2,   cavalry: 1.5 } },
  'Horse Lords':   { w: { spear: 0.4, sword: 0.8, archer: 3,   cavalry: 4.5 } },
  // Cheap, numerous and brittle.
  'Peasant Levy':  { w: { spear: 4,   sword: 1,   archer: 3,   cavalry: 0.3 }, budget: 1.2, armor: 0.7, discipline: 0.75 },
};

const REALM_A = ['Aven', 'Brec', 'Caer', 'Dun', 'Eld', 'Fen', 'Gwyn', 'Hal', 'Isen', 'Kor', 'Lor', 'Mor', 'Nor', 'Ost', 'Rav', 'Sten', 'Thal', 'Val', 'Wes', 'Ash', 'Black', 'Wolf', 'Rook', 'Oak', 'Grey', 'Stag', 'Bram', 'Cul', 'Hart', 'Wyn'];
const REALM_B = ['mark', 'dale', 'mere', 'ford', 'holt', 'wick', 'gard', 'moor', 'haven', 'burg', 'shire', 'fell', 'reach', 'vale', 'stead', 'wood', 'ton', 'by'];
const GIVEN = ['Aldric', 'Bertram', 'Cedric', 'Edmund', 'Godfrey', 'Hugh', 'Leofric', 'Osric', 'Roland', 'Tancred', 'Ulric', 'Walter', 'Baldwin', 'Geoffrey', 'Eustace', 'Rowan', 'Matilda', 'Isolde', 'Eleanor', 'Adela', 'Gwendolyn', 'Beatrice', 'Sibyl', 'Brand', 'Harald', 'Ivo', 'Odo', 'Rainald', 'Theobald', 'Wystan'];
const TITLE = ['King', 'Queen', 'Duke', 'Duchess', 'Earl', 'Count', 'Countess', 'Lord', 'Lady', 'Baron', 'Prince', 'Princess', 'Margrave', 'Warlord'];
const ADJ = ['Black', 'White', 'Red', 'Golden', 'Silver', 'Iron', 'Crimson', 'Grey', 'Green', 'Broken', 'Burning', 'Hollow', 'Last', 'Free'];
const EMBLEM = ['Rose', 'Lion', 'Stag', 'Boar', 'Raven', 'Tower', 'Crown', 'Wolf', 'Dragon', 'Hart', 'Eagle', 'Oak', 'Sword', 'Bear', 'Falcon'];
const FIELD = ['Field', 'Ford', 'Hill', 'Moor', 'Bridge', 'Heath', 'Ridge', 'Meadow', 'Crossing', 'Downs'];
export const TERRAINS = ['meadow', 'spring', 'autumn', 'heath', 'steppe', 'snow'];
// Heraldic metals: or and argent.
export const METALS = ['#e9c85a', '#ece8dc'];

const lerp = ([a, b], t = 0.5) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Global pacing knobs: lower = longer battles.
const MELEE_SCALE = 0.6;
const RANGED_SCALE = 3.75;

// Every unit in the palette, as [type, variant index] keys like 'spear:1'.
export const UNITS = TYPE_ORDER.flatMap((type) => UNIT_TYPES[type].variants.map((_, i) => `${type}:${i}`));

const designs = new Map();
// The fixed design for a palette unit: the middle of every stat range, with no army
// tech, so each company of a kind is identical and its points cost means something.
// Shared objects: the sim and roster only read them.
export function designFor(key) {
  if (designs.has(key)) return designs.get(key);
  const [type, vi] = key.split(':');
  const t = UNIT_TYPES[type];
  const v = t?.variants[Number(vi)];
  if (!v) return null;
  const m = (k) => v.mul?.[k] ?? 1;
  const a = (k) => v.add?.[k] ?? 0;
  const d = {
    key,
    type,
    typeLabel: t.label,
    name: v.name,
    hp: Math.round(t.hp * m('hp')),
    armor: clamp(lerp(t.armor) + a('armor'), 0, 0.7),
    shield: v.shield ?? t.shield,
    speed: t.speed * m('speed'),
    accel: t.accel,
    turn: t.turn,
    r: t.r,
    reach: t.reach * m('reach'),
    dmg: lerp(t.dmg) * m('dmg') * MELEE_SCALE,
    cooldown: lerp(t.cooldown),
    spacing: t.spacing,
    cost: t.cost * m('cost'),
    charge: t.charge ? t.charge * m('charge') : 0,
    lance: !!v.lance,
    discipline: m('discipline') * (t.discipline ?? 1),
    mass: type === 'cavalry' ? 4 : 1,
    ranged: null,
    // Company size limits and the default size dropped from the palette.
    min: type === 'cavalry' ? 4 : 8,
    max: type === 'cavalry' ? 30 : 64,
    size: Math.round(lerp(t.size) / 2) * 2,
    cols: Math.round(lerp(t.cols)),
  };
  if (t.ranged) {
    const r = t.ranged;
    d.ranged = {
      dmg: lerp(r.dmg) * m('rdmg') * RANGED_SCALE,
      range: lerp(r.range) * m('range'),
      cooldown: lerp(r.cooldown) * m('rcooldown'),
      speed: lerp(r.speed) * m('rspeed'),
      spread: r.spread * m('spread'),
      arc: v.bolt ? 0.06 : 0.3, // apex height as a fraction of the distance
      pierce: v.pierce ?? 0,
      bolt: !!v.bolt,
    };
  }
  designs.set(key, d);
  return d;
}

export const makeRealm = (rng) => rng.pick(REALM_A) + rng.pick(REALM_B);

// A random army name, lord and coat of arms for one side.
export function randomBanner(rng) {
  const realm = makeRealm(rng);
  let name;
  switch (rng.int(0, 4)) {
    case 0: name = `Host of ${realm}`; break;
    case 1: name = `${realm} Levy`; break;
    case 2: name = `The ${rng.pick(ADJ)} Company`; break;
    case 3: name = `House ${realm}`; break;
    default: name = `Knights of the ${rng.pick(ADJ)} ${rng.pick(EMBLEM)}`;
  }
  return { name, lord: `${rng.pick(TITLE)} ${rng.pick(GIVEN)} of ${realm}`, pattern: rng.pick(PATTERNS), metal: rng.pick(METALS) };
}

export const randomPlace = (rng) => `${makeRealm(rng)} ${rng.pick(FIELD)}`;
