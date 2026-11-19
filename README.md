# PUERTO FUEGO

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/awalsa/gta6-01/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/awalsa/gta6-01/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

An open-world crime game set in Puerto Fuego, built for the
[Make GTA 6 bounty](https://make.fun/bounty/gta6-01) on make.fun.

## The story

**Dani Reyes** came home to bury his brother — and found the city that
killed him. Starting with nothing but a borrowed car and a grudge, Dani
takes the streets of Puerto Fuego back: one job, one crew, one score at a
time. Work the districts, earn the crews' trust, and stay one step ahead
of the police who own the night.

## The city

Puerto Fuego is a fully explorable 3D open world rendered with three.js:
a downtown of neon and concrete, a sun-bleached beachfront, back-alley
barrios, and the highways that stitch them together. The city lives
around you — traffic flows, pedestrians go about their day, the sky and
weather shift, and the wanted level follows every bad decision you make.

## Systems

- **Driving** — steal and drive cars, bikes and trucks across the city,
  with traffic that reacts to you.
- **On-foot combat** — fists and firearms, with a wanted system and police
  that escalate, chase, and lose you.
- **Missions** — a story chain for Dani plus side jobs from the city's
  crews: getaways, deliveries, and scores that pay.
- **Pedestrians & traffic** — a living street population with its own
  routines, crowds, and chaos when things go loud.
- **Police** — patrols, pursuits, and heat that rises with every crime
  and cools when you lay low.
- **Day/night & weather** — a full sky cycle, sunsets over the bay, rain,
  and the neon hours after dark.
- **Character & progression** — Dani's skills, cash, and reputation grow
  with every job completed.
- **Save system** — progress, cash, and story state persist between
  sessions in the browser.
- **HUD & menus** — health, cash, wanted stars, minimap, mission
  tracker, and a pause menu.
- **Audio** — engine roar, city ambience, radio, and the sounds of a
  score going wrong.

## Controls

| Input | Action |
| --- | --- |
| W / A / S / D | Drive / move |
| Mouse | Look around |
| E | Interact / enter vehicle |
| Space | Handbrake / jump |
| Shift | Sprint |
| M | Map |
| Esc | Pause menu |

## How to run

No build step, no install, no network — the game is plain static files.

```sh
node serve.ts
```

Then open <http://localhost:8080> in a desktop browser.

To hand the entry in (the grader's step), run:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` copies `game/` and `screenshots/` into the output directory and
writes `dossier.json` there.

## Tech

- three.js (vendored under `game/vendor/`, no CDN)
- Plain ES modules, Node 22 standard library only for the tooling
- Runs fully offline — every asset is local
