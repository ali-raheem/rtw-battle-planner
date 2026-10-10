# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

RTW: a medieval battle planner. You draw up two armies company by company from a palette (spearmen, swordsmen, archers and cavalry, 15 variants), place and arrange them on the field, then watch the battle play out. It's a fork of Random Medieval Battles (`../RMB`): the simulation, renderer, audio and app shell come from there, and the random generator was replaced by a hand-edited plan. There is no build step and there are no dependencies; plain ES modules load straight from `index.html`. `README.md` describes the user-facing features.

(The parent `../CLAUDE.md` describes the shoryuken.me workspace and its shared-origin rules; the one above that, `~/Workspace/CLAUDE.md`, is an unrelated Rust/Fallout project. Ignore that one here.)

## Commands

```bash
npm test                                   # node --test tests/*.test.mjs (~30 s: runs whole battles)
node --test tests/army.test.mjs            # single test file
node --test --test-name-pattern="hold" tests/*.test.mjs  # single test by name
npm run serve                              # python3 -m http.server 8080 → http://localhost:8080/
npm run bump                               # bump js/version.js patch + BUILT timestamp (-- minor|major)
```

The page must be served over HTTP, not `file://`.

## Architecture

The data flows one way: **plan → `toBattle()` → `createBattle(gen, seed)` → `step()` → (events) → render + audio**, with `app.js` wiring everything together.

- `js/gen.js`: the unit tables (`UNIT_TYPES`, `BONUS`, `ARROW_BONUS`, `DOCTRINES`, `MELEE_SCALE`, `RANGED_SCALE`) and `designFor('type:variant')`, which returns a **fixed, shared** design for each palette unit (the midpoint of RMB's random ranges, no army tech), plus its company-size limits (`min`, `max`, default `size`, `cols`). It also has the random names, banners and place names. `UNITS` lists the 15 palette keys.
- `js/army.js`: the plan, DOM-free.
  - A plan is `{ v, budget (0 = no limit), terrain, field (ground seed), place, sides: [{ name, lord, pattern, metal, hue }], units: [{ side, key, n, c, x, y, f, hold }] }`. `n` is men, `c` columns (frontage), `f` facing in radians. Side 0 is you (bottom, y > 0), side 1 the enemy (top).
  - Geometry: `zone(side)`, `footprint` (`hw` across, `hd` along the facing), `corners`, `overlaps` (separating-axis test on rotated rectangles), `contains`, `clampToZone`, `blocked`, `findSpot` (spiral search for the nearest free ground).
  - `randomArmy(rng, side, budget)` drafts from a doctrine and `deploy()` lays it out (foot centre, archers before or behind, horse on the wings). `newPlan(seed, { yours })` and `mirror(plan)`.
  - `toBattle(plan)` builds what the sim needs: teams (colours, heraldry, `home` direction for routing) and regiments, named by kind and numbered only when a side has several of one kind.
  - `encode`/`decode`: the compact base64url JSON used in `#plan=` links and `localStorage`. `decode` treats its input as hostile: it validates unit keys, terrain, patterns and colours, clamps numbers, enforces the company and men caps, and clamps every company back onto its ground.
- `js/sim.js`: RMB's simulation (see `../RMB/CLAUDE.md` for regiments, formations, cohesion, `strike()`, morale and routing). Changes here: `createBattle(gen, seed)` takes the battle description, `state.field` carries the ground seed for the renderer, and **Hold orders**: a regiment with `hold` keeps its anchor (archers still volley; cavalry skips its phase machine) until `releaseHold()` frees it when an enemy is within `HOLD_RELEASE[type]`, it's engaged, or it has lost `HOLD_LOSSES` of its men. Release logs a `release` event for the feed.
- `js/render.js`: RMB's renderer, plus `setInsets()` (the screen area to frame), `frame` (a fixed world rectangle for the planning camera, instead of following the fighting), `toWorld()` and `worldTransform()`, and `draw(state, overlay)`, which calls `overlay(ctx, px)` in world space above the armies. The ground is seeded from `state.field`, so the planning preview and the battle share the same field.
- `js/app.js`:
  - **Plan mode** (`body[data-mode="plan"]`): `preview` is a sim state built from the plan and never stepped; it exists so the renderer draws the real men in their blocks. `changed()` rebuilds it and re-renders the side tabs, palette, toolbar and hint after every edit. `edit()` applies a change and slides the company to free ground or undoes it. Pointer handling covers placing (tap a card then the field, or drag a card out of the palette), moving, the turning handle, pan and pinch/wheel zoom (`view`, applied through `renderer.frame`). `drawPlan()` is the overlay. The stage element `#stage` defines where the field is framed; a ResizeObserver re-runs `layoutPlan()` when it changes.
  - **Battle mode**: RMB's fixed-timestep loop and HUD. No rotation: the banner offers Fight again (new seed) or Change the plan. VICTORY/DEFEAT is from side 0's point of view.
  - The plan is saved to `localStorage` (`rtw.plan`) and mirrored in the URL (`#plan=…`, plus `&seed=…` during a battle). A link with a seed opens straight into that fight.

### Determinism

A battle is determined by its plan and seed: the `#plan=…&seed=…` link must replay the same fight, and the tests check this. The sim's rng is `createRng(seed ^ 0x9e3779b9)`; any gameplay randomness must use it, never `Math.random`. The planning UI and renderer may use `Math.random` for cosmetics only. Keep loops in array order and the step fixed-dt (tests step at 1/30).

## Conventions and gotchas

- **Adding or renaming a file:** add it to `ASSETS` in `sw.js` (`tests/assets.test.mjs` fails otherwise), then `npm run bump`.
- **Changing the plan format:** links are shared, so keep `decode` accepting old plans; bump `PLAN_VERSION` only with a migration.
- **Unit balance** lives in `gen.js` as in RMB. Because designs are fixed, a unit's `cost` multiplier is its price per man; check balance with a scratch script that runs random plans (`newPlan(seed)`) and mirror matches. At the time of writing, 50 random plans gave a median battle of about 62 s (p90 about 92 s), no timeouts, and a roughly even win split.
- **Hit-testing in plan mode** prefers the side being edited, then exact hits over padded ones. The turning handle loses to a press that lands squarely on another company.
- **Icons:** the UI uses the inline SVG sprite in `index.html` (`#i-*` for controls, `#u-*` for the four unit types). The PNG app icons are rendered from `icons/icon.svg` with ImageMagick, whose SVG renderer ignores `clipPath` and mishandles `transform="rotate(...)"`, so draw rotated shapes as polygons.
- **Touch:** the battle HUD fades when idle and swallows the waking tap (as in RMB); the planner never fades. On phones the palette is a horizontal strip and the company toolbar takes its place while something is selected.

## Shared origin

Served at `/rtw/`. The manifest `id` is `/rtw/` (never change it once released). localStorage keys are `rtw.plan` and `rtw.sound`. `sw.js` uses cache prefix `rtw-`, handles only requests inside its scope, reads only its own cache (never `caches.match()`), precaches with `cache: 'reload'` and fetches with `cache: 'no-cache'`. See `../CLAUDE.md`.

## Deployment

Live since 2026-10-10 (nginx block in the site config, card on the homepage). To ship an update, after `npm test` and `npm run bump` copy only the served files:

```bash
rsync -a --delete --chmod=D755,F644 index.html manifest.webmanifest sw.js css js icons root@185.163.204.17:/var/www/shoryuken.me/rtw/
```
