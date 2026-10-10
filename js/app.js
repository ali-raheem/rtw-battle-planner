// App wiring: the planning screen (palette, placing and arranging companies), the
// fixed-timestep battle loop and its HUD, and offline support.

import { createBattle, step, teamStats, TIME_LIMIT } from './sim.js';
import { createRng, randomSeed } from './rng.js';
import { BONUS, UNIT_TYPES, TYPE_ORDER, TERRAINS, designFor, randomBanner, randomPlace } from './gen.js';
import {
  BUDGETS, MAX_MEN, MAX_COMPANIES, zone, company, footprint, corners, contains, clampToZone, companyCost,
  sideUnits, sideCost, sideMen, blocked, findSpot, newPlan, randomArmy, mirror, toBattle, encode, decode,
} from './army.js';
import { heraldryShapes } from './heraldry.js';
import { Renderer } from './render.js';
import { SoundEngine } from './audio.js';
import { VERSION, BUILT } from './version.js';

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 240;
const SPEEDS = [0.5, 1, 2, 4];
const PLAN_KEY = 'rtw.plan';
const TURN = Math.PI / 12; // 15° per press
const SNAP = Math.PI / 36; // the turning handle snaps to 5°
// The world rectangle the planning camera frames: both deployment zones and a margin.
const PLAN_FRAME = { x0: -445, x1: 445, y0: -480, y1: 480 };

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('view'), hud: $('hud'), teams: $('teams'), battleNo: $('battle-no'), clock: $('clock'),
  meta: $('meta'), seed: $('seed'), feed: $('feed'), banner: $('banner'),
  pause: $('btn-pause'), speed: $('btn-speed'), edit: $('btn-edit'),
  roster: $('roster'), settings: $('settings'),
  sound: $('set-sound'), bars: $('set-bars'), full: $('set-full'), hide: $('set-hide'), install: $('set-install'),
  version: $('version'),
  plan: $('plan'), sides: $('sides'), palette: $('palette'), units: $('units'), budget: $('budget'), hint: $('hint'),
  stage: $('stage'), selbar: $('selbar'), terrain: $('terrain'),
  fight: $('act-fight'),
};
// Side panels: at most one is open at a time, toggled by its button.
const panels = {
  roster: { panel: el.roster, buttons: [$('btn-roster')] },
  settings: { panel: el.settings, buttons: [$('btn-settings'), $('act-settings')] },
};

const useIcon = (button, name) => button.querySelector('use').setAttribute('href', `#i-${name}`);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (seed) => seed.toString(16).padStart(8, '0');
const pts = (n) => Math.round(n);

const renderer = new Renderer(el.canvas);
const sound = new SoundEngine();
let mode = 'plan';
let plan = null;
let preview = null; // a sim state built from the plan, never stepped: it draws the men
let state = null; // the battle being fought
let active = 0; // the side being edited
let selected = null; // a company in plan.units
let armed = null; // a palette unit key waiting to be placed
let hover = null; // [x, y] world point under the mouse, for the placement ghost
let drag = null;
let paused = false;
let speedIndex = 1;
let acc = 0;
let ended = false;
let hudTimer = 0;
let feedSeen = 0;

// --- the plan --------------------------------------------------------------------

const budgetLeft = (side) => (plan.budget ? plan.budget - sideCost(plan, side) : Infinity);
const overBudget = (side) => plan.budget && sideCost(plan, side) > plan.budget + 1e-6;

function savePlan() {
  const code = encode(plan);
  try { localStorage.setItem(PLAN_KEY, code); } catch { /* storage unavailable */ }
  history.replaceState(null, '', mode === 'battle' && state ? `#plan=${code}&seed=${hex(state.seed)}` : `#plan=${code}`);
}

function loadSaved() {
  try {
    const code = localStorage.getItem(PLAN_KEY);
    return code ? decode(code) : null;
  } catch {
    return null;
  }
}

function fromHash(hash = location.hash) {
  const p = hash.match(/plan=([A-Za-z0-9_-]+)/);
  const s = hash.match(/seed=([0-9a-f]+)/i);
  return { plan: p ? decode(p[1]) : null, seed: s ? parseInt(s[1], 16) >>> 0 : null };
}

// Rebuilds the preview from the plan and refreshes everything that shows it.
function changed({ save = true } = {}) {
  if (selected && !plan.units.includes(selected)) selected = null;
  preview = createBattle(toBattle(plan), 1);
  renderer.teams = preview.teams;
  if (save) savePlan();
  renderSides();
  renderPalette();
  renderSelbar();
  renderHint();
}

function setPlan(p) {
  plan = p;
  selected = null;
  armed = null;
  changed();
  renderer.reset(preview);
  renderTerrain();
}

function setActive(side) {
  if (active === side) return;
  active = side;
  if (selected && selected.side !== side) selected = null;
  changed({ save: false });
}

// --- planning UI -----------------------------------------------------------------

// A heraldic shield, drawn from the same shapes as the banners.
function shieldSvg(team, where = 'h') {
  const her = team.heraldry;
  const id = `clip-${where}-${team.index}`;
  const polys = heraldryShapes(her.pattern)
    .map((poly) => `<polygon points="${poly.map(([u, v]) => `${u * 20 + 2},${v * 24 + 2}`).join(' ')}" fill="${her.metal}"/>`)
    .join('');
  const outline = 'M2 2h20v10c0 7-5 11.5-10 14C7 23.5 2 19 2 12z';
  return `<svg class="shield" viewBox="0 0 24 28" aria-hidden="true">
    <clipPath id="${id}"><path d="${outline}"/></clipPath>
    <g clip-path="url(#${id})"><rect width="24" height="28" fill="${her.field}"/>${polys}</g>
    <path d="${outline}" fill="none" stroke="rgba(0,0,0,0.6)" stroke-width="1.2"/></svg>`;
}

function renderSides() {
  el.sides.innerHTML = preview.teams.map((t) => {
    const i = t.index;
    const cost = sideCost(plan, i);
    const over = overBudget(i);
    const n = sideUnits(plan, i).length;
    return `
    <button class="side${over ? ' over' : ''}" role="tab" aria-selected="${i === active}" data-side="${i}" style="--c:${t.color}">
      <span class="name">${shieldSvg(t, `s${i}`)}<span>${escapeHtml(t.name)}</span></span>
      <span class="sub"><span>${i ? 'Enemy' : 'Your army'} · ${n} ${n === 1 ? 'company' : 'companies'}, ${sideMen(plan, i)} men</span>
      <span class="cost">${pts(cost)}${plan.budget ? ` / ${plan.budget}` : ''} pts</span></span>
      <span class="bar"><i style="width:${plan.budget ? Math.min(100, (cost / plan.budget) * 100) : 0}%"></i></span>
    </button>`;
  }).join('');
}

// Short notes on what makes a unit different, from its variant's tweaks.
function unitNotes(key) {
  const [type, vi] = key.split(':');
  const t = UNIT_TYPES[type];
  const v = t.variants[Number(vi)];
  const m = (k) => v.mul?.[k] ?? 1;
  const notes = [];
  if (m('reach') > 1.2) notes.push('long reach');
  if (m('dmg') >= 1.2 || m('rdmg') >= 1.2) notes.push('hard-hitting');
  if ((v.add?.armor ?? 0) > 0) notes.push('armoured');
  if ((v.add?.armor ?? 0) < 0) notes.push('unarmoured');
  if (m('hp') > 1.1) notes.push('tough');
  if (m('speed') > 1.1) notes.push('fast');
  if (m('speed') < 0.95) notes.push('slow');
  if (m('range') > 1.1) notes.push('long range');
  if (v.pierce) notes.push('pierces armour');
  if (v.lance) notes.push('lance charge');
  if ((v.shield ?? t.shield) >= 0.5) notes.push('shields');
  if (m('cost') < 1) notes.push('cheap');
  if (!notes.length) notes.push('steady');
  return notes.join(' · ');
}

function strongVs(type) {
  return Object.entries(BONUS[type]).filter(([, m]) => m > 1.25).map(([k]) => UNIT_TYPES[k].label.toLowerCase());
}

let paletteBuilt = false;
function renderPalette() {
  if (!paletteBuilt) {
    el.units.innerHTML = TYPE_ORDER.map((type) => {
      const t = UNIT_TYPES[type];
      const strong = strongVs(type);
      return `
      <div class="group">
        <h3><svg class="icon"><use href="#u-${type}"/></svg>${t.label}${strong.length ? `<small>strong vs ${strong.join(', ')}</small>` : ''}</h3>
        ${t.variants.map((v, i) => {
          const key = `${type}:${i}`;
          const d = designFor(key);
          return `
          <button class="unit" data-key="${key}" title="${escapeHtml(`${v.name}: ${unitNotes(key)}. Drag onto the field, or tap and then tap the field.`)}">
            <svg class="icon"><use href="#u-${type}"/></svg>
            <span class="label"><b>${v.name}</b><small>${unitNotes(key)}</small></span>
            <span class="price">${pts(d.size * d.cost)}<small>${d.size} men</small></span>
          </button>`;
        }).join('')}
      </div>`;
    }).join('');
    paletteBuilt = true;
  }
  const left = budgetLeft(active);
  const men = MAX_MEN - sideMen(plan, active);
  const full = sideUnits(plan, active).length >= MAX_COMPANIES;
  for (const b of el.units.querySelectorAll('.unit')) {
    const d = designFor(b.dataset.key);
    b.disabled = full || men < d.min || left < d.min * d.cost - 1e-6;
    b.setAttribute('aria-pressed', String(armed === b.dataset.key));
  }
  el.palette.style.setProperty('--c', preview.teams[active].color);
  el.budget.value = String(plan.budget);
  const problem = sideUnits(plan, 0).length === 0 || sideUnits(plan, 1).length === 0 || overBudget(0) || overBudget(1);
  el.fight.disabled = !!problem;
}

function renderHint() {
  let text;
  if (overBudget(0) || overBudget(1)) text = `Over budget: dismiss some companies, or raise the budget.`;
  else if (!sideUnits(plan, active).length) text = `${active ? 'The enemy has' : 'You have'} no companies yet. Pick one and place it in the shaded ground.`;
  else if (!sideUnits(plan, 1 - active).length) text = `Now draw up ${active ? 'your army' : 'the enemy'} too (switch with the banner above).`;
  else if (armed) text = `Tap the field to place ${designFor(armed).name}. Tap the card again to stop.`;
  else if (selected) text = 'Drag to move, drag the handle to turn. Holding companies stand until the enemy is close.';
  else text = 'Drag companies to move them, tap one to change it, then Fight.';
  el.hint.textContent = text;
}

function renderSelbar() {
  const u = selected;
  el.selbar.hidden = !u;
  el.plan.classList.toggle('selecting', !!u);
  if (!u) return;
  const d = designFor(u.key);
  const reg = preview.regiments[plan.units.indexOf(u)];
  el.selbar.style.setProperty('--c', preview.teams[u.side].color);
  el.selbar.querySelector('.sel-title use').setAttribute('href', `#u-${d.type}`);
  el.selbar.querySelector('.sel-title b').textContent = reg.name;
  const ranks = Math.ceil(u.n / Math.min(u.c, u.n));
  el.selbar.querySelector('.sel-title span').textContent = `${pts(companyCost(u))} pts · ${Math.min(u.c, u.n)} wide, ${ranks} deep`;
  el.selbar.querySelector('.men').textContent = `${u.n} men`;
  const tool = (act) => el.selbar.querySelector(`[data-act="${act}"]`);
  tool('fewer').disabled = u.n <= d.min;
  tool('more').disabled = u.n >= d.max || budgetLeft(u.side) < sizeStep(d) * d.cost - 1e-6 || sideMen(plan, u.side) + sizeStep(d) > MAX_MEN;
  tool('wider').disabled = u.c >= u.n;
  tool('deeper').disabled = u.c <= 2;
  tool('hold').setAttribute('aria-pressed', String(u.hold));
  tool('copy').disabled = sideUnits(plan, u.side).length >= MAX_COMPANIES || budgetLeft(u.side) < companyCost(u) - 1e-6 || sideMen(plan, u.side) + u.n > MAX_MEN;
}

const sizeStep = (d) => (d.type === 'cavalry' ? 2 : 4);

function renderTerrain() {
  el.terrain.innerHTML = TERRAINS.map((t) => `<option value="${t}">${t[0].toUpperCase()}${t.slice(1)}</option>`).join('');
  el.terrain.value = plan.terrain;
}

el.budget.innerHTML = [...BUDGETS.map((b) => `<option value="${b}">${b} pts</option>`), '<option value="0">No limit</option>'].join('');

// --- editing ---------------------------------------------------------------------

// Tries an edit on a company; if it ends up off its ground or on top of another, it
// moves to the nearest free spot, and if there's none the edit is undone.
function edit(u, fn) {
  const before = { ...u };
  fn(u);
  clampToZone(u);
  if (blocked(plan, u)) {
    const spot = findSpot(plan, u);
    if (spot) [u.x, u.y] = spot;
    else Object.assign(u, before);
  }
  changed();
}

function place(key, x, y) {
  const side = y > 0 ? 0 : 1;
  setActive(side);
  const d = designFor(key);
  const left = budgetLeft(side);
  const room = MAX_MEN - sideMen(plan, side);
  if (sideUnits(plan, side).length >= MAX_COMPANIES) return flash(`An army can field at most ${MAX_COMPANIES} companies.`);
  // A smaller company when the full one won't fit the budget or the muster.
  let n = Math.min(d.size, room, Math.floor((left + 1e-6) / d.cost));
  n -= n % 2;
  if (n < d.min) return flash(`Not enough ${plan.budget ? 'points' : 'room'} left for ${d.name}.`);
  const u = clampToZone(company(side, key, x, y, { n, c: Math.min(n, d.cols) }));
  const spot = blocked(plan, u) ? findSpot(plan, u) : [u.x, u.y];
  if (!spot) return flash('No room left on that ground.');
  [u.x, u.y] = spot;
  plan.units.push(u);
  selected = u;
  changed();
}

function act(name) {
  const u = selected;
  if (!u) return;
  const d = designFor(u.key);
  switch (name) {
    case 'fewer': edit(u, (v) => { v.n = Math.max(d.min, v.n - sizeStep(d)); v.c = Math.min(v.c, v.n); }); break;
    case 'more':
      if (el.selbar.querySelector('[data-act="more"]').disabled) return;
      edit(u, (v) => { v.n = Math.min(d.max, v.n + sizeStep(d)); });
      break;
    case 'wider': edit(u, (v) => { v.c = Math.min(v.n, v.c + 1); }); break;
    case 'deeper': edit(u, (v) => { v.c = Math.max(2, Math.min(v.c, v.n) - 1); }); break;
    case 'left': edit(u, (v) => { v.f -= TURN; }); break;
    case 'right': edit(u, (v) => { v.f += TURN; }); break;
    case 'hold': u.hold = !u.hold; changed(); break;
    case 'copy': {
      if (el.selbar.querySelector('[data-act="copy"]').disabled) return;
      const { hw } = footprint(u);
      const c = { ...u, x: u.x - Math.sin(u.f) * (hw * 2 + 14), y: u.y + Math.cos(u.f) * (hw * 2 + 14) };
      clampToZone(c);
      const spot = findSpot(plan, c);
      if (!spot) return flash('No room left on that ground.');
      [c.x, c.y] = spot;
      plan.units.push(c);
      selected = c;
      changed();
      break;
    }
    case 'delete':
      plan.units.splice(plan.units.indexOf(u), 1);
      selected = null;
      changed();
      break;
    case 'close':
      selected = null;
      changed({ save: false });
      break;
  }
}

let flashTimer = null;
function flash(text) {
  el.hint.textContent = text;
  el.hint.classList.add('warn');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.hint.classList.remove('warn');
    renderHint();
  }, 2200);
}

el.selbar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) act(b.dataset.act);
});
el.sides.addEventListener('click', (e) => {
  const b = e.target.closest('[data-side]');
  if (b) setActive(Number(b.dataset.side));
});
el.budget.addEventListener('change', () => {
  plan.budget = Number(el.budget.value);
  changed();
});
el.terrain.addEventListener('change', () => {
  plan.terrain = el.terrain.value;
  changed();
  renderer.reset(preview);
});
$('set-field').addEventListener('click', () => {
  const rng = createRng(randomSeed());
  plan.field = randomSeed();
  plan.place = randomPlace(rng);
  plan.terrain = rng.pick(TERRAINS);
  changed();
  renderer.reset(preview);
  renderTerrain();
});
$('set-banners').addEventListener('click', () => {
  const rng = createRng(randomSeed());
  plan.sides = plan.sides.map((s) => ({ ...randomBanner(rng), hue: s.hue }));
  changed();
});
$('act-random').addEventListener('click', () => {
  const rng = createRng(randomSeed());
  plan.units = [...plan.units.filter((u) => u.side !== active), ...randomArmy(rng, active, plan.budget || 500)];
  selected = null;
  changed();
});
$('act-mirror').addEventListener('click', () => {
  if (!sideUnits(plan, 0).length) return flash('Draw up your army first: the enemy will copy it.');
  mirror(plan);
  selected = null;
  changed();
  flash('The enemy now mirrors your army.');
});
$('act-clear').addEventListener('click', () => {
  plan.units = plan.units.filter((u) => u.side !== active);
  selected = null;
  changed();
});
$('act-share').addEventListener('click', (e) => copyText(e.currentTarget, `${location.origin}${location.pathname}#plan=${encode(plan)}`));
el.fight.addEventListener('click', () => fight());

// --- palette: tap to arm, or drag a card onto the field ------------------------------

let press = null;
el.units.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.unit');
  if (!b || b.disabled || e.button > 0) return;
  press = { key: b.dataset.key, id: e.pointerId, x: e.clientX, y: e.clientY, out: false };
});
window.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  // Dragging starts once the pointer leaves the palette, so the list still scrolls.
  const r = el.palette.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside && !press.out) {
    press.out = true;
    drag = { kind: 'new', key: press.key, id: e.pointerId };
  }
  if (drag?.kind === 'new') hover = renderer.toWorld(e.clientX, e.clientY);
});
window.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  press = null;
  if (drag?.kind === 'new') {
    drag = null;
    const r = el.stage.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      const [x, y] = renderer.toWorld(e.clientX, e.clientY);
      place(p.key, x, y);
    }
    hover = null;
  }
});
window.addEventListener('pointercancel', (e) => {
  if (press && e.pointerId === press.id && drag?.kind !== 'new') press = null;
});
el.units.addEventListener('click', (e) => {
  const b = e.target.closest('.unit');
  if (!b || b.disabled) return;
  armed = armed === b.dataset.key ? null : b.dataset.key;
  if (armed) selected = null;
  renderPalette();
  renderSelbar();
  renderHint();
});

// --- the field: select, move, turn, place, pan and zoom ---------------------------------

const pointers = new Map();
let pinch = null;

const handlePos = (u) => {
  const { hd } = footprint(u);
  const k = hd + 26 / renderer.cam.zoom;
  return [u.x + Math.cos(u.f) * k, u.y + Math.sin(u.f) * k];
};

function companyAt(x, y) {
  const pad = 10 / renderer.cam.zoom;
  // Prefer the side being edited, then the most recently placed.
  const list = [...plan.units].reverse().sort((a, b) => (b.side === active) - (a.side === active));
  return list.find((u) => contains(u, x, y)) ?? list.find((u) => contains(u, x, y, pad)) ?? null;
}

el.canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'plan') return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  el.canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    // A second finger turns whatever the first was doing into a pinch.
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: view.zoom, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], x: view.x, y: view.y };
    return;
  }
  const [x, y] = renderer.toWorld(e.clientX, e.clientY);
  // The turning handle, unless the press is squarely on another company.
  if (selected && !plan.units.some((o) => o !== selected && contains(o, x, y))) {
    const [hx, hy] = handlePos(selected);
    if (Math.hypot(x - hx, y - hy) < 16 / renderer.cam.zoom) {
      drag = { kind: 'turn', unit: selected, id: e.pointerId, before: { ...selected } };
      return;
    }
  }
  const u = companyAt(x, y);
  if (u) {
    if (armed) armed = null;
    selected = u;
    setActive(u.side);
    drag = { kind: 'move', unit: u, id: e.pointerId, dx: u.x - x, dy: u.y - y, before: { ...u }, sx: e.clientX, sy: e.clientY, moved: false };
    changed({ save: false });
    return;
  }
  drag = { kind: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false };
});

el.canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'plan') return;
  if (e.pointerType === 'mouse') hover = renderer.toWorld(e.clientX, e.clientY);
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    zoomAt(pinch.zoom * (d / pinch.d), pinch.mid[0], pinch.mid[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    view.x -= (mid[0] - pinch.mid[0]) / renderer.cam.zoom;
    view.y -= (mid[1] - pinch.mid[1]) / renderer.cam.zoom;
    pinch.mid = mid;
    pinch.x = view.x;
    pinch.y = view.y;
    pinch.zoom = view.zoom;
    pinch.d = d;
    return;
  }
  if (!drag || drag.id !== e.pointerId) return;
  const [x, y] = renderer.toWorld(e.clientX, e.clientY);
  if (drag.kind === 'move') {
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    drag.moved = true;
    drag.unit.x = x + drag.dx;
    drag.unit.y = y + drag.dy;
    clampToZone(drag.unit);
    changed({ save: false });
  } else if (drag.kind === 'turn') {
    const u = drag.unit;
    u.f = Math.round(Math.atan2(y - u.y, x - u.x) / SNAP) * SNAP;
    clampToZone(u);
    changed({ save: false });
  } else if (drag.kind === 'pan') {
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
    drag.moved = true;
    if (view.zoom > 1) {
      view.x = drag.x - (e.clientX - drag.sx) / renderer.cam.zoom;
      view.y = drag.y - (e.clientY - drag.sy) / renderer.cam.zoom;
      clampView();
    }
  }
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    return;
  }
  if (!drag || drag.id !== e.pointerId) return;
  const d = drag;
  drag = null;
  if (d.kind === 'move' || d.kind === 'turn') {
    // Dropped on top of another company: find the nearest gap, or go back.
    if (blocked(plan, d.unit)) {
      const spot = findSpot(plan, d.unit);
      if (spot) [d.unit.x, d.unit.y] = spot;
      else Object.assign(d.unit, d.before);
    }
    changed();
  } else if (d.kind === 'pan' && !d.moved && e.type === 'pointerup') {
    const [x, y] = renderer.toWorld(e.clientX, e.clientY);
    if (armed) place(armed, x, y);
    else if (selected) act('close');
  }
}
el.canvas.addEventListener('pointerup', endPointer);
el.canvas.addEventListener('pointercancel', endPointer);
el.canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover = null; });

// Planning camera: framed on the whole field, with optional zoom and pan.
const view = { zoom: 1, x: 0, y: 0 };
function clampView() {
  const hw = (PLAN_FRAME.x1 - PLAN_FRAME.x0) / 2, hh = (PLAN_FRAME.y1 - PLAN_FRAME.y0) / 2;
  const k = 1 - 1 / view.zoom;
  view.x = Math.max(-hw * k, Math.min(hw * k, view.x));
  view.y = Math.max(-hh * k, Math.min(hh * k, view.y));
}
function zoomAt(z, sx, sy) {
  const [wx, wy] = renderer.toWorld(sx, sy);
  view.zoom = Math.max(1, Math.min(4, z));
  applyView();
  renderer.fitCamera(preview, 0);
  // Keep the world point under the fingers (or cursor) where it was.
  const [nx, ny] = renderer.toWorld(sx, sy);
  view.x += wx - nx;
  view.y += wy - ny;
  clampView();
  applyView();
}
function applyView() {
  const hw = (PLAN_FRAME.x1 - PLAN_FRAME.x0) / 2 / view.zoom, hh = (PLAN_FRAME.y1 - PLAN_FRAME.y0) / 2 / view.zoom;
  renderer.frame = { x0: view.x - hw, x1: view.x + hw, y0: view.y - hh, y1: view.y + hh };
}
el.canvas.addEventListener('wheel', (e) => {
  if (mode !== 'plan') return;
  e.preventDefault();
  zoomAt(view.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });
el.canvas.addEventListener('dblclick', () => {
  if (mode !== 'plan') return;
  view.zoom = 1;
  view.x = view.y = 0;
  applyView();
});

// The planning marks drawn over the field: deployment ground, company outlines, the
// selected company's turning handle and, for archers, their range.
function drawPlan(ctx, px) {
  const teams = preview.teams;
  for (const side of [0, 1]) {
    const z = zone(side);
    const on = side === active;
    ctx.fillStyle = on ? `hsl(${teams[side].hue} 70% 55% / 0.1)` : 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
    ctx.setLineDash([6 * px, 5 * px]);
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = on ? `hsl(${teams[side].hue} 75% 72% / 0.75)` : 'rgba(255, 255, 255, 0.18)';
    ctx.strokeRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
  }
  ctx.setLineDash([]);
  const outline = (u, pad) => {
    ctx.beginPath();
    corners(u, pad).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };
  for (const u of plan.units) {
    const sel = u === selected;
    outline(u, 3);
    if (drag && drag.unit === u && blocked(plan, u)) {
      ctx.fillStyle = 'rgba(220, 60, 40, 0.3)';
      ctx.fill();
    }
    ctx.lineWidth = (sel ? 2 : 1) * px;
    ctx.strokeStyle = sel ? '#e8c26a' : u.side === active ? 'rgba(255, 240, 210, 0.35)' : 'rgba(255, 240, 210, 0.12)';
    ctx.stroke();
    if (u.hold) {
      // A small stake and pennant behind the block.
      const { hd } = footprint(u);
      const bx = u.x - Math.cos(u.f) * (hd + 8 * px), by = u.y - Math.sin(u.f) * (hd + 8 * px);
      ctx.strokeStyle = '#e8c26a';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.moveTo(bx, by + 5 * px);
      ctx.lineTo(bx, by - 7 * px);
      ctx.lineTo(bx + 6 * px, by - 4.5 * px);
      ctx.lineTo(bx, by - 2 * px);
      ctx.stroke();
    }
  }
  if (selected) {
    const u = selected;
    const d = designFor(u.key);
    if (d.ranged) {
      ctx.setLineDash([3 * px, 6 * px]);
      ctx.strokeStyle = 'rgba(232, 194, 106, 0.45)';
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath();
      ctx.arc(u.x, u.y, d.ranged.range, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const { hd } = footprint(u);
    const fx = u.x + Math.cos(u.f) * hd, fy = u.y + Math.sin(u.f) * hd;
    const [hx, hy] = handlePos(u);
    ctx.strokeStyle = '#e8c26a';
    ctx.lineWidth = 1.6 * px;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = drag?.kind === 'turn' ? '#fff3c4' : '#e8c26a';
    ctx.beginPath();
    ctx.arc(hx, hy, 7 * px, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.stroke();
  }
  // Where a company would go: dragged from the palette, or armed and under the mouse.
  const ghostKey = drag?.kind === 'new' ? drag.key : armed && !drag ? armed : null;
  if (ghostKey && hover) {
    const side = hover[1] > 0 ? 0 : 1;
    const g = clampToZone(company(side, ghostKey, hover[0], hover[1]));
    outline(g, 0);
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.strokeStyle = teams[side].light;
    ctx.lineWidth = 1.5 * px;
    ctx.fillStyle = `hsl(${teams[side].hue} 70% 55% / 0.18)`;
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// --- battle --------------------------------------------------------------------------

function fight(seed = randomSeed()) {
  if (el.fight.disabled) return;
  state = createBattle(toBattle(plan), seed);
  mode = 'battle';
  document.body.dataset.mode = mode;
  selected = null;
  armed = null;
  drag = null;
  hover = null;
  acc = 0;
  ended = false;
  feedSeen = 0;
  renderer.frame = null;
  renderer.setInsets(null);
  renderer.reset(state);
  savePlan();
  el.battleNo.textContent = `Battle of ${state.place}`;
  el.seed.textContent = `fight ${hex(seed)}`;
  el.feed.replaceChildren();
  el.banner.hidden = true;
  showPanel(null);
  setPaused(false);
  buildTeams();
  buildRoster();
  updateHud();
  placePanels();
  wakeHud();
}

function backToPlan() {
  mode = 'plan';
  document.body.dataset.mode = mode;
  state = null;
  el.banner.hidden = true;
  showPanel(null);
  el.hud.classList.remove('idle', 'hidden');
  sound.setPaused(false);
  changed();
  layoutPlan();
  renderer.reset(preview);
  applyView();
}

// Panels open just below the header, whose height depends on the mode and width.
function placePanels() {
  const top = mode === 'plan' ? el.sides.getBoundingClientRect().bottom : el.meta.getBoundingClientRect().bottom;
  el.hud.style.setProperty('--hud-top', `${Math.ceil(top) + 10}px`);
}

// The planning camera fills the stage: the space the planning UI leaves free.
function layoutPlan() {
  const r = el.stage.getBoundingClientRect();
  renderer.setInsets({ top: r.top, bottom: innerHeight - r.bottom, left: r.left, right: innerWidth - r.right });
  applyView();
  placePanels();
}

function buildTeams() {
  el.teams.innerHTML = state.teams.map((t) => `
    <div class="team" style="--c:${t.color}" data-team="${t.index}">
      <div class="name" title="${escapeHtml(t.name)}">${shieldSvg(t)}<span>${escapeHtml(t.name)}</span></div>
      <div class="sub"><span>${escapeHtml(t.doctrine)}</span><span class="count"></span></div>
      <div class="bar"><i></i></div>
    </div>`).join('');
}

function updateHud() {
  const stats = teamStats(state);
  for (const s of stats) {
    const node = el.teams.querySelector(`[data-team="${s.team.index}"]`);
    node.querySelector('.count').textContent = `${s.alive}/${s.total} men`;
    node.querySelector('.bar > i').style.width = `${(s.strength * 100).toFixed(1)}%`;
    node.classList.toggle('out', s.alive === 0);
  }
  const t = Math.floor(state.time);
  const left = Math.max(0, TIME_LIMIT - t);
  el.clock.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` +
    (left < 30 && !state.over ? ` (nightfall in ${left}s)` : '');

  while (feedSeen < state.log.length) {
    const e = state.log[feedSeen++];
    const team = state.teams[e.team];
    const li = document.createElement('li');
    li.style.setProperty('--c', team.color);
    const name = `<span class="v">${escapeHtml(e.name)}</span>`;
    if (e.type === 'charge') {
      li.style.setProperty('--kc', state.teams[e.targetTeam].color);
      li.innerHTML = `${name} <span class="w">charge</span> <span class="k">${escapeHtml(e.target)}</span>`;
    } else if (e.type === 'rout') {
      li.innerHTML = `${name} <span class="w">break and flee</span>`;
    } else if (e.type === 'release') {
      li.innerHTML = `${name} <span class="w">leave their ground</span>`;
    } else {
      li.innerHTML = `${name} <span class="w">cut down to the last</span>`;
    }
    el.feed.append(li);
    while (el.feed.children.length > 6) el.feed.firstElementChild.remove();
  }
}

function showBanner() {
  const w = state.winner;
  const fallen = state.soldiers.filter((s) => !s.alive && !s.fled).length;
  const best = state.regiments.reduce((b, r) => (r.kills > (b?.kills ?? 0) ? r : b), null);
  const parts = [];
  if (w) parts.push(`${state.soldiers.filter((s) => s.alive && !s.routing && s.team === w.index).length} men stand`);
  parts.push(`${fallen} fallen in ${Math.round(state.endT)}s`);
  if (best) parts.push(`bravest: ${best.name} (${best.kills} slain)`);
  el.banner.style.setProperty('--c', w?.color ?? '#f0e6d0');
  el.banner.querySelector('.kicker').textContent = state.timeout ? 'NIGHTFALL' : w ? (w.index === 0 ? 'VICTORY' : 'DEFEAT') : 'NO VICTOR';
  el.banner.querySelector('.title').textContent = w ? w.name : 'The field is empty';
  el.banner.querySelector('.sub').textContent = parts.join(' · ');
  el.banner.hidden = false;
}

async function copyText(button, text) {
  const target = button.querySelector('span') ?? button;
  const label = target.textContent;
  try {
    await navigator.clipboard.writeText(text);
    target.textContent = 'Link copied';
  } catch {
    target.textContent = 'Copy failed';
  }
  setTimeout(() => (target.textContent = label), 1200);
}

function fmt(n) {
  return n >= 10 ? Math.round(n) : n.toFixed(1);
}

function buildRoster() {
  el.roster.innerHTML = state.teams.map((t) => {
    const regs = state.regiments.filter((r) => r.team === t.index);
    const designs = Object.values(t.designs).map((d) => {
      const mine = regs.filter((r) => r.design === d);
      if (!mine.length) return '';
      const men = mine.reduce((n, r) => n + r.count, 0);
      const r = d.ranged;
      const notes = [
        ...strongVs(d.type).map((k) => `strong vs ${k}`),
        d.charge ? `charge ×${fmt(d.charge)}` : '',
        d.shield >= 0.4 ? 'shielded' : '',
        r?.pierce ? 'armour-piercing' : '',
      ].filter(Boolean);
      return `
      <div class="design">
        <b>${escapeHtml(d.name)}</b> <span class="kind">${escapeHtml(d.typeLabel)}</span> · ${mine.length} ${mine.length === 1 ? 'company' : 'companies'}, ${men} men
        <div class="stats">HP ${d.hp} · armour ${Math.round(d.armor * 100)}% · ${Math.round(d.speed)} paces/s · ${fmt(d.cost)} pts a man</div>
        <ul>
          <li><span class="wn">${d.type === 'cavalry' ? (d.lance ? 'Lance' : 'Sword') : d.type === 'spear' ? 'Spear' : d.type === 'sword' ? 'Blade' : 'Knife'}</span> — ${fmt(d.dmg)} dmg · ${fmt(d.reach)} reach · ${d.cooldown.toFixed(1)}s</li>
          ${r ? `<li><span class="wn">${r.bolt ? 'Crossbow' : 'Bow'}</span> — ${fmt(r.dmg)} dmg · ${Math.round(r.range)} range · volley every ${r.cooldown.toFixed(1)}s</li>` : ''}
          ${notes.length ? `<li>${notes.join(' · ')}</li>` : ''}
        </ul>
        <div class="regs">${mine.map((x) => escapeHtml(x.name)).join(' · ')}</div>
      </div>`;
    }).join('');
    return `
      <section style="--c:${t.color}">
        <h2>${shieldSvg(t, 'r')}${escapeHtml(t.name)}</h2>
        <div class="tech">Led by ${escapeHtml(t.lord)} · ${escapeHtml(t.doctrine)}</div>
        ${designs}
      </section>`;
  }).join('');
}

// --- loop ------------------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (mode === 'plan') {
    renderer.update(preview, 0, realDt);
    renderer.draw(preview, drawPlan);
  } else {
    let simDt = 0;
    if (!paused) {
      acc += realDt * SPEEDS[speedIndex];
      let steps = 0;
      while (acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
        step(state, STEP);
        sound.ingest(state.events, renderer);
        renderer.ingest(state.events);
        acc -= STEP;
        simDt += STEP;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;
      if (state.over && !ended) {
        ended = true;
        showBanner();
        sound.fanfare(state.winner?.index === 0);
      }
    }
    renderer.update(state, simDt, realDt);
    renderer.draw(state);
    hudTimer -= realDt;
    if (hudTimer <= 0) {
      updateHud();
      hudTimer = 0.2;
    }
  }
  requestAnimationFrame(frame);
}

// --- controls --------------------------------------------------------------------

function setPaused(p) {
  paused = p;
  sound.setPaused(p);
  useIcon(el.pause, paused ? 'play' : 'pause');
  el.pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  el.pause.setAttribute('aria-pressed', String(paused));
}
function changeSpeed(delta) {
  speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, speedIndex + delta));
  el.speed.textContent = `${SPEEDS[speedIndex]}×`;
}
function cycleSpeed() {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  changeSpeed(0);
}
// Opens the named panel and closes the rest; null closes them all.
function showPanel(name) {
  for (const [key, p] of Object.entries(panels)) {
    p.panel.hidden = key !== name;
    for (const b of p.buttons) b.setAttribute('aria-pressed', String(key === name));
  }
  if (name) placePanels();
}
const togglePanel = (name) => showPanel(panels[name].panel.hidden ? name : null);
const anyPanelOpen = () => Object.values(panels).some((p) => !p.panel.hidden);

function setSwitch(row, on) {
  row.setAttribute('aria-checked', String(on));
}
function toggleBars() {
  renderer.showBars = !renderer.showBars;
  setSwitch(el.bars, renderer.showBars);
}
function renderSound() {
  setSwitch(el.sound, sound.enabled);
  useIcon(el.sound, sound.enabled ? 'sound' : 'sound-off');
}
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  renderSound();
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
function setHudHidden(hidden) {
  el.hud.classList.toggle('hidden', hidden);
}

el.pause.addEventListener('click', () => setPaused(!paused));
el.speed.addEventListener('click', cycleSpeed);
el.edit.addEventListener('click', backToPlan);
$('ban-again').addEventListener('click', () => fight());
$('ban-edit').addEventListener('click', backToPlan);
for (const [name, p] of Object.entries(panels)) for (const b of p.buttons) b.addEventListener('click', () => togglePanel(name));
el.sound.addEventListener('click', toggleSound);
el.bars.addEventListener('click', toggleBars);
el.full.addEventListener('click', toggleFullscreen);
el.hide.addEventListener('click', () => {
  showPanel(null);
  setHudHidden(true);
});
el.seed.addEventListener('click', () => copyText(el.seed, `${location.origin}${location.pathname}#plan=${encode(plan)}&seed=${hex(state.seed)}`));
document.addEventListener('fullscreenchange', () => setSwitch(el.full, !!document.fullscreenElement));
// iPhone Safari has no element fullscreen; "Add to Home Screen" is the way there.
el.full.hidden = !document.documentElement.requestFullscreen;
renderSound();
setSwitch(el.bars, renderer.showBars);
setSwitch(el.full, false);
el.version.textContent = `v${VERSION} · built ${new Date(BUILT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
el.version.title = BUILT;

// Install: Chromium browsers hand us a deferred prompt; iOS Safari has no install API,
// so there the row explains Share → Add to Home Screen instead. Elsewhere (Firefox
// desktop) there's no way to install, so the row stays hidden, as it does once the
// app is running installed.
let installPrompt = null;
const runningInstalled = navigator.standalone === true ||
  matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function renderInstall() {
  const hint = el.install.querySelector('small');
  if (installPrompt) hint.textContent = 'adds it to your home screen or desktop; works offline';
  else if (isIOS) hint.textContent = 'in Safari, tap Share, then Add to Home Screen';
  el.install.hidden = runningInstalled || (!installPrompt && !isIOS);
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  el.install.hidden = true;
});
el.install.addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null; // a prompt can only be shown once
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'accepted') el.install.hidden = true;
  else renderInstall();
});
renderInstall();

function planKey(e) {
  switch (e.key) {
    case '1': setActive(0); break;
    case '2': setActive(1); break;
    case 'q': case 'Q': act('left'); break;
    case 'e': case 'E': act('right'); break;
    case 'w': case 'W': act('wider'); break;
    case 'd': case 'D': act('deeper'); break;
    case '+': case '=': act('more'); break;
    case '-': case '_': act('fewer'); break;
    case 'h': case 'H': act('hold'); break;
    case 'c': case 'C': act('copy'); break;
    case 'Delete': case 'Backspace': act('delete'); break;
    case 'Enter': fight(); break;
    case 's': case 'S': togglePanel('settings'); break;
    case 'm': case 'M': toggleSound(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'Escape':
      if (anyPanelOpen()) showPanel(null);
      else if (armed) { armed = null; renderPalette(); renderHint(); }
      else if (selected) act('close');
      else return false;
      break;
    default: return false;
  }
  return true;
}

function battleKey(e) {
  switch (e.key) {
    case ' ': setPaused(!paused); break;
    case 'Enter': case 'n': case 'N': fight(); break;
    case '+': case '=': changeSpeed(1); break;
    case '-': case '_': changeSpeed(-1); break;
    case 'r': case 'R': togglePanel('roster'); break;
    case 's': case 'S': togglePanel('settings'); break;
    case 'b': case 'B': toggleBars(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'm': case 'M': toggleSound(); break;
    case 'h': case 'H': setHudHidden(!el.hud.classList.contains('hidden')); break;
    case 'Escape': if (anyPanelOpen()) showPanel(null); else backToPlan(); break;
    default: return false;
  }
  return true;
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('select, input')) return;
  if (!(mode === 'plan' ? planKey(e) : battleKey(e))) return;
  e.preventDefault();
  wakeHud();
});

// In battle the controls fade after a few idle seconds. A tap while they're hidden
// only brings them back; it must not press the invisible button underneath, so the
// click that follows it is swallowed.
let idleTimer = null;
let swallowClick = false;
function wakeHud() {
  el.hud.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (mode === 'battle' && !anyPanelOpen() && el.banner.hidden) el.hud.classList.add('idle');
  }, 4000);
}
window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wakeHud(); });
window.addEventListener('pointerdown', () => {
  if (mode !== 'battle') return;
  swallowClick = el.hud.classList.contains('idle') || el.hud.classList.contains('hidden');
  setHudHidden(false);
  wakeHud();
}, { capture: true });
window.addEventListener('click', (e) => {
  if (swallowClick) {
    e.preventDefault();
    e.stopPropagation();
  }
  swallowClick = false;
}, { capture: true });

// Audio can only start after a user gesture; the first click/tap/key unlocks it.
for (const type of ['pointerdown', 'keydown', 'touchend']) {
  window.addEventListener(type, () => sound.unlock(), { capture: true });
}

window.addEventListener('resize', () => {
  renderer.resize();
  if (mode === 'plan') layoutPlan();
  placePanels();
});
// The stage also changes size when the company toolbar comes and goes on phones.
new ResizeObserver(() => { if (mode === 'plan') layoutPlan(); }).observe(el.stage);
window.addEventListener('hashchange', () => {
  const h = fromHash();
  if (!h.plan || encode(h.plan) === encode(plan)) return;
  if (mode === 'battle') backToPlan();
  setPlan(h.plan);
  if (h.seed !== null) fight(h.seed);
});

// Keep the screen awake while the tab is visible.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* not allowed; fine */ }
}
document.addEventListener('visibilitychange', () => {
  sound.setPaused(document.visibilityState !== 'visible' || (mode === 'battle' && paused));
  if (document.visibilityState === 'visible') {
    last = performance.now();
    if (!wakeLock || wakeLock.released) requestWakeLock();
  }
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register(`./sw.js?v=${VERSION}`).catch(() => {});
}

// A shared link wins over the saved plan; a link with a fight seed replays that fight.
const start = fromHash();
setPlan(start.plan ?? loadSaved() ?? newPlan(randomSeed(), { yours: false }));
layoutPlan();
if (start.plan && start.seed !== null) fight(start.seed);
requestWakeLock();
requestAnimationFrame(frame);
