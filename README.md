# RTW

Draw up two medieval armies company by company, then watch them fight it out. You
pick spearmen, swordsmen, archers and cavalry from a palette, place each company on
your ground, set its frontage and facing, and press Fight. The battle itself is
hands-off, as in its sibling Random Medieval Battles (`../RMB`), whose simulation
and renderer it reuses.

No build step, no dependencies, no network calls. Plain HTML/CSS/JS modules plus a
service worker, so it installs as a PWA and runs fully offline.

## Run it

```bash
python3 -m http.server 8080   # or: npm run serve
```

Open `http://localhost:8080/`. After the first load it works with the network off.

## Planning

The screen shows the whole field: your ground (red, bottom) and the enemy's (blue,
top), with open ground between. The banners at the top pick which army you're
editing and show its points and muster. You start with an empty army facing a random
enemy; you can redraw the enemy too.

- **Recruit:** tap a unit in the palette, then tap the field to place a company (it
  stays armed, so you can place several; tap the card again or press Esc to stop),
  or drag a card straight onto the field.
- **Arrange:** drag a company to move it. Tap one to select it: drag the round handle
  in front of it to turn it, and use the toolbar for men (+/−), frontage (wider or
  deeper), turning in 15° steps, Hold, Duplicate and Dismiss. Companies can't overlap
  or leave their ground; a drop on top of another slides to the nearest gap.
- **Hold:** a company on hold stands its ground (archers still shoot) until an enemy
  comes close, it's drawn into a fight, or it loses 15% of its men. Then it fights
  normally. Good for a spear wall waiting for horse, or archers behind it.
- **Budget:** 150, 300, 500 or 800 points a side, or no limit. Each unit's cost per
  man is in its card; a full company of Spearmen is 32 points, of Knights 49. An army
  can field at most 16 companies and 480 men.
- **Random** drafts a random army for the side you're editing, **Mirror** makes the
  enemy a reflection of your army (a fair test of a deployment), **Clear** dismisses
  every company on the side, and **Share** copies a link to the plan.
- **Settings** also has the ground (season), a new battlefield, and new banners.
- Scroll or pinch to zoom the field, drag empty ground to pan, double-click to reset.

The plan is saved in the browser as you go, and kept in the URL (`#plan=…`).

## Fighting

Fight starts the battle from the plan. The sim's randomness comes from a fresh seed
each time, so **Fight again** can go differently. The seed in the header copies a
link (`#plan=…&seed=…`) that replays exactly that fight. When it ends, the banner
says VICTORY or DEFEAT (from your side's point of view), or NIGHTFALL at 4 minutes.

| Key | Action |
|---|---|
| Space | Pause / resume |
| `+` / `-` | Simulation speed (0.5× – 4×) |
| Enter, `N` | Fight again with a new seed |
| Esc | Back to the plan (or close the open panel) |
| `R` | Army roster |
| `S` | Settings |
| `B` | Strength/morale bars under each banner |
| `H` | Hide the HUD |
| `M` | Sound |
| `F` | Fullscreen |

While planning: `1`/`2` pick your army or the enemy, `Q`/`E` turn, `W`/`D` wider or
deeper, `+`/`-` men, `H` hold, `C` duplicate, Delete dismiss, Enter fight.

## Units

Each palette unit has fixed stats: the middle of RMB's random ranges, with no army
tech modifiers, so a company's points cost means the same thing every time.

| Type | Variants | Role |
|---|---|---|
| Spearmen | Spearmen, Pikemen, Halberdiers, Billmen | Long reach; brace against and wreck cavalry |
| Swordsmen | Swordsmen, Men-at-Arms, Axemen, Huscarls | Shielded, armoured; win the infantry grind against spears |
| Archers | Archers, Longbowmen, Crossbowmen | Arcing volleys; crossbows hit hard and pierce armour |
| Cavalry | Horsemen, Knights, Lancers, Light Horse | Flank, charge, withdraw and charge again; ride down archers |

The battle rules are RMB's: blocks fight as formed lines while they hold together, a
formed and standing spear block stops a charge to its front, cavalry rides for flanks
and rears, shields stop arrows from the front only, and morale breaks companies,
which flee for their own edge of the field.

## Structure

| File | Purpose |
|---|---|
| `js/rng.js` | Seeded PRNG (mulberry32) |
| `js/gen.js` | Unit tables (`UNIT_TYPES`, `BONUS`, `DOCTRINES`), fixed designs (`designFor`), names and banners |
| `js/army.js` | The plan: zones, footprints, overlap, budget, random armies, mirror, `toBattle()`, share-link encoding |
| `js/heraldry.js` | Heraldic divisions as polygons, shared by banners and HUD shields |
| `js/sim.js` | Deterministic, DOM-free simulation (from RMB), plus Hold orders |
| `js/audio.js` | Synthesised Web Audio effects |
| `js/render.js` | Canvas renderer, with a fixed planning camera and an overlay hook |
| `js/app.js` | Planning UI, fixed-timestep battle loop, HUD, controls |
| `tests/army.test.mjs` | Random armies are legal; overlap, spots, mirror, naming; links round-trip and are sanitised |
| `tests/sim.test.mjs` | Designs are sane; battles end; replays are deterministic; Hold works |
| `tests/assets.test.mjs` | Every shipped file is in the service worker's cache list |

## Releasing

```bash
npm test
npm run bump            # patch; or: npm run bump -- minor | major
```
