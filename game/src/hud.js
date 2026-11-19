// Puerto Fuego — head-up display.
//
// Everything the player needs mid-chase, painted on the #hud 2D canvas that
// floats above the WebGL scene. The canvas is pointer-events: none, so this
// module only ever draws; it never takes input.
//
// Layout, clockwise from the top-left corner:
//   mission card  |  wanted stars (top centre)  |  cash + clock (top right)
//   vitals + radar (bottom left)                 |  speed + weapon (bottom right)
//   toast messages sit bottom-centre, clear of every panel.
//
// Every read from the world object is defensive: a HUD that throws because a
// field is missing would kill the frame loop, so unknown values fall back to
// something that still looks like a working instrument.

import { GRID, PLAYER, WEAPONS, WORLD, HEAT, TIME } from './config.js';
import { clamp } from './mathutil.js';

// ---------------------------------------------------------------------------
// Look and feel
// ---------------------------------------------------------------------------

const UI_FONT = '"Helvetica Neue", Arial, sans-serif';
const DIGIT_FONT = '"Courier New", monospace';

// One palette object so the whole HUD reads as a single instrument.
const PAL = {
  glass: 'rgba(9, 12, 17, 0.62)',
  glassStrong: 'rgba(9, 12, 17, 0.82)',
  edge: 'rgba(255, 255, 255, 0.16)',
  edgeWarm: 'rgba(255, 183, 51, 0.45)',
  trough: 'rgba(0, 0, 0, 0.55)',
  ink: 'rgba(244, 246, 250, 0.94)',
  faint: 'rgba(244, 246, 250, 0.55)',
  ghost: 'rgba(244, 246, 250, 0.30)',
  hp: '#4be08a',
  hpCrit: '#e8503c',
  armour: '#59b7f2',
  cash: '#63e06f',
  gold: '#ffb733',
  goldSoft: 'rgba(255, 183, 51, 0.55)',
  star: '#ffd24a',
  radarInk: 'rgba(8, 24, 20, 0.72)',
  radarRoad: 'rgba(126, 214, 178, 0.42)',
  cop: '#5ea6ff',
  waypoint: '#ffcf3a',
  traffic: 'rgba(235, 240, 245, 0.88)',
};

// Scale is anchored to a 900px-tall viewport and clamped, so the HUD stays
// legible on a small laptop and stops growing on a 4K panel.
const REF_HEIGHT = 900;
// The radar shows this many metres from edge to edge: about three blocks in
// each direction, which is roughly the distance a driver plans a turn from.
const RADAR_SPAN = 118;
// A toast fades in and out over this fraction of its lifetime at each end.
const TOAST_EDGE = 0.18;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function twoDigits(n) {
  return n < 10 ? '0' + n : String(n);
}

function cashStr(value) {
  const v = Math.round(Number(value) || 0);
  return v < 0 ? '-$' + Math.abs(v) : '$' + v;
}

// 24-hour clock. Minutes are taken from the total in one step so a fractional
// hour like 18.999 never floors to the wrong minute.
function clockStr(hour) {
  const h = (((Number(hour) || 0) % 24) + 24) % 24;
  const total = Math.floor(h * 60 + 1e-6);
  return twoDigits(Math.floor(total / 60) % 24) + ':' + twoDigits(total % 60);
}

// Ammo prints two digits so the block never changes width between 9 and 10
// rounds. Fists carry no magazine, which config expresses as Infinity.
function ammoStr(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '\u221E';
  return String(Math.max(0, Math.round(v))).padStart(2, '0');
}

// Rounded-rect path built from arcTo, so it works on canvases that predate
// ctx.roundRect.
function rr(c, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r);
  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);
  c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r);
  c.arcTo(x, y, x + r, y, r);
  c.closePath();
}

// Five-point star path, one point straight up.
function star(c, cx, cy, outerR, innerR) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? outerR : innerR;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
}

// ---------------------------------------------------------------------------
// HUD factory
// ---------------------------------------------------------------------------

export function createHud(canvas, world) {
  const ctx = canvas.getContext('2d');

  let w = 0;
  let h = 0;
  let s = 1; // layout scale, derived from viewport height
  let dpr = 1;

  // Smoothed vitals: a bar that snaps on damage reads as a bug, and a fast
  // drain sells the hit. NaN for the previous timestamp, because the first
  // frame legitimately arrives at t = 0 and a 0 sentinel would restart the
  // delta clock forever and freeze the toast timer.
  let hpShown = 1;
  let armourShown = 0;
  let prevT = NaN;
  let dt = 1 / 60;

  let mission = null;
  let toastMsg = '';
  let toastLeft = 0;
  let toastTotal = 1;

  function resize() {
    const cw = canvas.clientWidth || canvas.width || 1280;
    const ch = canvas.clientHeight || canvas.height || 720;
    w = Math.max(1, cw);
    h = Math.max(1, ch);
    // The backing-store ratio comes from the canvas itself, not from
    // devicePixelRatio: the renderer owns the backing store, so this stays in
    // step with whatever scale it actually chose.
    dpr = clamp(canvas.width ? canvas.width / w : 1, 0.5, 3);
    s = clamp(h / REF_HEIGHT, 0.7, 1.35);
  }

  resize();

  // --- drawing primitives --------------------------------------------------

  // Every solid block on screen is one of these: a translucent pane with a
  // hairline border, so the HUD looks like one machine rather than six.
  function chip(x, y, cw, ch, radius, fill, stroke) {
    rr(ctx, x, y, cw, ch, radius);
    ctx.fillStyle = fill || PAL.glass;
    ctx.fill();
    ctx.lineWidth = 1 / dpr;
    ctx.strokeStyle = stroke || PAL.edge;
    ctx.stroke();
  }

  // Dark trough with a bright leading segment. The segment never shrinks
  // below the bar's own height, so 2% health is still a visible sliver and
  // not a rounding error that vanishes the moment it matters.
  function meter(x, y, cw, ch, frac, colour) {
    const f = clamp(finite(frac, 0), 0, 1);
    rr(ctx, x, y, cw, ch, ch / 2);
    ctx.fillStyle = PAL.trough;
    ctx.fill();
    if (f <= 0.001) return;
    const fillW = Math.max(Math.min(ch, cw), cw * f);
    ctx.save();
    rr(ctx, x, y, fillW, ch, Math.min(ch / 2, fillW / 2));
    ctx.clip();
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, fillW, ch);
    // Bright lip on the leading edge: which way the bar is moving is readable
    // in a single frame, without stopping to parse a number.
    const lip = Math.min(fillW, Math.max(2, cw * 0.05));
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + fillW - lip, y, lip, ch);
    ctx.restore();
  }

  // Truncate by measured width, never by character count: a line of W's and a
  // line of i's must both stop at the same pixel edge.
  function shorten(text, maxW) {
    const str = String(text == null ? '' : text);
    if (maxW <= 0) return '';
    if (ctx.measureText(str).width <= maxW) return str;
    const dots = '...';
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(str.slice(0, mid) + dots).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? str.slice(0, lo) + dots : dots;
  }

  // Letterspaced caps. letterSpacing is still not universal, so set it only
  // when the context supports it and always reset it afterwards.
  function capsLabel(text, x, y, size, spacing, align, colour) {
    ctx.save();
    ctx.font = '700 ' + size + 'px ' + UI_FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = align || 'left';
    if ('letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
    ctx.fillStyle = colour || PAL.ink;
    ctx.fillText(String(text).toUpperCase(), x, y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.restore();
  }

  // --- world reads ---------------------------------------------------------
  // The exact shape of the world bag belongs to gameplay, so each read is
  // tolerant and defaults to something that still looks like a working HUD.

  function player() {
    if (!world) return null;
    if (world.player && world.player.state) return world.player.state;
    return world.player || null;
  }

  function playerXZ(ps) {
    const p = (ps && ps.position) || (world && world.player && world.player.position) || {};
    return { x: finite(p.x, 0), z: finite(p.z, 0) };
  }

  function heading(ps) {
    if (ps && Number.isFinite(ps.yaw)) return ps.yaw;
    const cam = world && world.camera && world.camera.state;
    if (cam && Number.isFinite(cam.yaw)) return cam.yaw;
    return 0;
  }

  // Wanted level. HEAT is a list of thresholds, so the star count is simply
  // how many of them the current heat has reached — the same rule the police
  // response uses, which keeps the HUD from ever disagreeing with the number
  // of cruisers actually on the street.
  function wantedLevel(ps) {
    const heat = finite(world && world.heat, ps && Number.isFinite(ps.heat) ? ps.heat : NaN);
    if (Number.isFinite(heat)) return wantedStars(heat);
    const direct = finite(world && world.stars, ps && ps.stars);
    return Number.isFinite(direct) ? clamp(Math.round(direct), 0, 5) : 0;
  }

  function hourOfDay() {
    if (!world) return TIME ? TIME.startHour : 18.2;
    const t = finite(world.timeOfDay, NaN);
    if (Number.isFinite(t)) return t;
    if (world.clock && Number.isFinite(world.clock.hour)) return world.clock.hour;
    if (world.time && Number.isFinite(world.time.hour)) return world.time.hour;
    // The spawn hour, not 00:00: a stopped clock at midnight looks like a bug.
    return TIME ? TIME.startHour : 18.2;
  }

  // Weapon block data. Specs are keyed by id and labelled with `label`; the
  // magazine size lives on `magazine` and the reserve on `ammo`.
  function weaponData(ps) {
    const id = (ps && ps.weapon) || (world && world.weapon) || 'fists';
    const spec = WEAPONS[id] || WEAPONS.fists;
    const mag = finite(
      ps && ps.ammoInMagazine,
      finite(ps && ps.magazine, finite(world && world.ammoInMagazine, spec.magazine))
    );
    const reserve = finite(
      ps && ps.reserve,
      finite(ps && ps.ammo, finite(world && world.ammoReserve, spec.ammo))
    );
    return { name: spec.label, mag, reserve, size: spec.magazine };
  }

  // Speed in metres per second, from whichever field gameplay publishes.
  // Falls back to the velocity vector's length, then to zero.
  function speedMs(ps) {
    const direct = finite(ps && ps.speed, finite(world && world.speed, NaN));
    if (Number.isFinite(direct)) return Math.max(0, direct);
    const v = (ps && ps.velocity) || (world && world.velocity) || null;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) {
      return Math.hypot(v.x, v.z);
    }
    return 0;
  }

  function inVehicle(ps) {
    if (ps && typeof ps.inVehicle === 'boolean') return ps.inVehicle;
    if (ps && ps.vehicle) return true;
    if (world && typeof world.inVehicle === 'boolean') return world.inVehicle;
    return !!(world && world.vehicle);
  }

  // Everything with a map position, normalised to { x, z, kind }.
  function gatherBlips() {
    const out = [];
    if (!world) return out;
    const collect = (list, kind) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const p = item && item.position ? item.position : item;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        out.push({ x: p.x, z: p.z, kind });
      }
    };
    collect(world.traffic || world.cars || world.vehicles, 'traffic');
    collect(world.police || world.cruisers, 'police');
    collect(world.missions || world.missionMarkers || world.markers, 'mission');
    return out;
  }

  // --- screen elements -----------------------------------------------------

  function drawMissionCard() {
    if (!mission) return;
    const pad = 18 * s;
    const bw = Math.min(w * 0.44, 352 * s, Math.max(150 * s, w / 2 - 96 * s));
    const bh = 80 * s;
    const x = pad;
    const y = pad;

    chip(x, y, bw, bh, 7 * s, 'rgba(12, 14, 20, 0.78)', PAL.edgeWarm);
    // Amber spine: colour finds the panel in peripheral vision before a word
    // of it is read.
    const spine = ctx.createLinearGradient(0, y, 0, y + bh);
    spine.addColorStop(0, PAL.gold);
    spine.addColorStop(1, 'rgba(255, 183, 51, 0.08)');
    ctx.fillStyle = spine;
    ctx.fillRect(x + 1, y + 8 * s, 3 * s, bh - 16 * s);

    const left = x + pad * 0.8;
    const right = x + bw - pad * 0.7;
    const inner = right - left;

    // Title and step share the top row: the step is a qualifier, so it gets
    // the right edge and the remainder of the width.
    ctx.save();
    ctx.font = '700 ' + 11 * s + 'px ' + UI_FONT;
    const stepTxt = mission.step ? String(mission.step).toUpperCase() : '';
    const titleRoom = stepTxt ? inner * 0.62 : inner;
    const titleTxt = shorten(String(mission.title).toUpperCase(), titleRoom);
    ctx.restore();
    capsLabel(titleTxt, left, y + 18 * s, 11 * s, 1.4, 'left', PAL.gold);
    if (stepTxt) {
      ctx.save();
      ctx.font = '700 ' + 9.5 * s + 'px ' + UI_FONT;
      const stepFit = shorten(stepTxt, inner * 0.34);
      ctx.restore();
      capsLabel(stepFit, right, y + 18 * s, 9.5 * s, 1.2, 'right', PAL.goldSoft);
    }

    // The detail (usually the payout) is a fixed share on the right so a
    // wordy destination cannot squeeze the instruction to three letters.
    ctx.save();
    ctx.textBaseline = 'middle';
    let detailW = 0;
    if (mission.detail) {
      ctx.font = '700 ' + 11 * s + 'px ' + UI_FONT;
      const detail = shorten(String(mission.detail).toUpperCase(), inner * 0.45);
      detailW = ctx.measureText(detail).width + 10 * s;
      ctx.textAlign = 'right';
      ctx.fillStyle = PAL.cash;
      ctx.fillText(detail, right, y + 58 * s);
    }

    // The instruction is the biggest text on the card and is clipped inside
    // it, so a long objective can never spill onto the radar.
    ctx.textAlign = 'left';
    ctx.font = '700 ' + 15 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.ink;
    ctx.fillText(shorten(mission.label, Math.max(20, inner - detailW)), left, y + 58 * s);
    ctx.restore();
  }

  function drawVitals() {
    const ps = player();
    const hpFrac = clamp(finite(ps && ps.health, PLAYER.maxHealth) / PLAYER.maxHealth, 0, 1);
    const arFrac = clamp(finite(ps && ps.armour, 0) / PLAYER.maxArmour, 0, 1);

    hpShown += (hpFrac - hpShown) * Math.min(1, dt * 12);
    armourShown += (arFrac - armourShown) * Math.min(1, dt * 12);

    const barW = 184 * s;
    const barH = 9 * s;
    const radarR = 66 * s;
    const x = 24 * s;
    // The stack sits directly on the radar so the left column reads as one
    // object: vitals, then the map they apply to.
    const stackBottom = h - 18 * s - radarR * 2;
    const hpY = stackBottom - 52 * s;
    const arY = hpY + 34 * s;

    chip(x - 12 * s, hpY - 16 * s, barW + 24 * s, 96 * s, 6 * s);

    // Health goes red below a quarter: the bar is small, and colour is what a
    // player registers mid-firefight.
    const hpColour = hpFrac < 0.25 ? PAL.hpCrit : PAL.hp;
    meter(x, hpY, barW, barH, hpShown, hpColour);
    capsLabel('Health', x, hpY - 9 * s, 9 * s, 1.2, 'left', PAL.faint);
    ctx.save();
    ctx.font = '700 ' + 12 * s + 'px ' + DIGIT_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hpColour;
    ctx.fillText(String(Math.round(hpFrac * PLAYER.maxHealth)), x + barW, hpY - 9 * s);
    ctx.restore();

    meter(x, arY, barW, barH, armourShown, PAL.armour);
    capsLabel('Armour', x, arY - 9 * s, 9 * s, 1.2, 'left', arFrac > 0 ? PAL.faint : PAL.ghost);
    ctx.save();
    ctx.font = '700 ' + 12 * s + 'px ' + DIGIT_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PAL.armour;
    ctx.fillText(String(Math.round(arFrac * PLAYER.maxArmour)), x + barW, arY - 9 * s);
    ctx.restore();
  }

  function drawRadar(nowMs) {
    const ps = player();
    const pos = playerXZ(ps);
    const yaw = heading(ps);
    const r = 66 * s;
    const cx = 18 * s + r;
    const cy = h - 18 * s - r;

    // The disc is rotated into the player's frame: forward always points at
    // the top, so the arrow never turns and the reading a driver makes in a
    // quarter-second glance is always the same. Yaw 0 faces north (-Z) and
    // forward is (sin yaw, -cos yaw), right is (cos yaw, sin yaw).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const k = r / RADAR_SPAN;
    const project = (wx, wz) => {
      const dx = wx - pos.x;
      const dz = wz - pos.z;
      return {
        x: cx + (dx * cos + dz * sin) * k,
        y: cy + (-dx * sin + dz * cos) * k,
      };
    };

    ctx.save();
    rr(ctx, cx - r, cy - r, r * 2, r * 2, r);
    // Clip once: streets and blips can then be drawn with wild coordinates
    // and never bleed past the rim.
    ctx.clip();

    ctx.fillStyle = PAL.radarInk;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    // Water and sand bands, so the shoreline reads at a glance and the player
    // can tell which way is inland without a compass.
    const shoreA = project(WORLD.beachStart, pos.z);
    const shoreB = project(WORLD.beachEnd, pos.z);
    ctx.fillStyle = 'rgba(29, 109, 132, 0.30)';
    ctx.fillRect(shoreA.x, cy - r, cx + r - shoreA.x + 2, r * 2);
    ctx.fillStyle = 'rgba(216, 191, 148, 0.16)';
    ctx.fillRect(shoreB.x, cy - r, shoreA.x - shoreB.x, r * 2);

    // Streets. The grid repeats every road + block, so two families of lines
    // at that pitch rebuild the city from two numbers and stay aligned with
    // the roads actually driven.
    const period = GRID.road + GRID.block;
    const cell = period * k;
    const origin = project(0, 0);
    // Start at the first grid line outside the disc rather than the world
    // origin, so a player standing in a far corner still sees their streets.
    const startX = origin.x - Math.ceil((origin.x - (cx - r)) / cell) * cell;
    const startY = origin.y - Math.ceil((origin.y - (cy - r)) / cell) * cell;

    ctx.strokeStyle = PAL.radarRoad;
    ctx.lineWidth = Math.max(1, GRID.road * k * 0.55);
    ctx.beginPath();
    for (let gx = startX; gx <= cx + r; gx += cell) {
      if (gx < cx - r) continue;
      ctx.moveTo(gx, cy - r);
      ctx.lineTo(gx, cy + r);
    }
    for (let gy = startY; gy <= cy + r; gy += cell) {
      if (gy < cy - r) continue;
      ctx.moveTo(cx - r, gy);
      ctx.lineTo(cx + r, gy);
    }
    ctx.stroke();

    // Sweep wedge: marks the disc as a live instrument and costs one
    // gradient per frame.
    const sweep = ((nowMs / 1000) % 2) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(sweep * Math.PI * 2);
    const grad = ctx.createLinearGradient(0, 0, 0, -r);
    grad.addColorStop(0, 'rgba(126, 214, 178, 0)');
    grad.addColorStop(1, 'rgba(126, 214, 178, 0.20)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, -Math.PI / 2 - 0.55, -Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Blips. Shape carries meaning as well as colour: squares for traffic,
    // triangles for police, diamonds for mission markers — legible on a
    // washed-out screen and to a colour-blind eye.
    const edge = r - 5 * s;
    for (const b of gatherBlips()) {
      const p = project(b.x, b.z);
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy);
      let px = p.x;
      let py = p.y;
      let pinned = false;
      if (d > edge) {
        // An overshot target pins to the rim instead of vanishing: a mission
        // behind you must still point the way back.
        const f = edge / (d || 1);
        px = cx + dx * f;
        py = cy + dy * f;
        pinned = true;
      }
      if (b.kind === 'police') {
        ctx.fillStyle = PAL.cop;
        ctx.beginPath();
        ctx.moveTo(px, py - 4.6 * s);
        ctx.lineTo(px + 3.4 * s, py + 3 * s);
        ctx.lineTo(px - 3.4 * s, py + 3 * s);
        ctx.closePath();
        ctx.fill();
      } else if (b.kind === 'mission') {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = PAL.waypoint;
        const sz = 3.4 * s;
        ctx.fillRect(-sz, -sz, sz * 2, sz * 2);
        ctx.restore();
      } else {
        ctx.globalAlpha = pinned ? 0.5 : 1;
        ctx.fillStyle = PAL.traffic;
        const sz = 1.9 * s;
        ctx.fillRect(px - sz, py - sz, sz * 2, sz * 2);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    // Rim and inner ring are drawn unclipped so the border is a crisp circle,
    // not a clipped box.
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
    ctx.lineWidth = 1.3 / dpr + 0.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();

    // North tick. World -Z projected into the rotated frame is (sin, -cos)
    // on screen, so the N rides the rim as the player turns instead of being
    // pinned to a compass rose.
    ctx.fillStyle = PAL.ink;
    ctx.font = '700 ' + 10 * s + 'px ' + UI_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx + sin * (r - 10 * s), cy - cos * (r - 10 * s));

    // Player arrow: dead centre, always up, because the disc is already
    // player-aligned.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7 * s);
    ctx.lineTo(cx + 5 * s, cy + 5 * s);
    ctx.lineTo(cx, cy + 2.5 * s);
    ctx.lineTo(cx - 5 * s, cy + 5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawWanted() {
    const level = wantedLevel(player());
    const outer = 10.5 * s;
    const gap = 26 * s;
    const padX = 10 * s;
    const backW = gap * 5 + padX * 2;
    const backH = 30 * s;
    // Top-centre on its own dark backplate: outlined stars over a bright
    // golden-hour skyline are invisible without a contrast bed.
    const bx = w / 2 - backW / 2;
    const by = 10 * s;

    chip(bx, by, backW, backH, 5 * s, 'rgba(6, 8, 12, 0.72)', 'rgba(255, 255, 255, 0.12)');

    ctx.save();
    ctx.lineJoin = 'round';
    for (let i = 0; i < 5; i++) {
      const cx = bx + padX + gap * i + gap / 2;
      const cy = by + backH / 2;
      star(ctx, cx, cy, outer, outer * 0.46);
      if (i < level) {
        ctx.fillStyle = PAL.star;
        ctx.fill();
        ctx.strokeStyle = 'rgba(110, 62, 0, 0.95)';
      } else {
        // Empty stars are a faint outline: five solid dark stars would read as
        // a full level at a glance, which is the one thing this display must
        // never do.
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.40)';
      }
      ctx.lineWidth = 1.4 / dpr + 0.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMoney() {
    const ps = player();
    const cash = finite(ps && ps.cash, finite(world && world.cash, 0));

    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Monospace and right-aligned so the digits do not shuffle sideways every
    // time the cash changes.
    ctx.font = '700 ' + 24 * s + 'px ' + DIGIT_FONT;
    ctx.fillStyle = cash < 0 ? PAL.hpCrit : PAL.cash;
    ctx.fillText(cashStr(cash), w - 18 * s, 26 * s);
    ctx.font = '700 ' + 15 * s + 'px ' + DIGIT_FONT;
    ctx.fillStyle = PAL.faint;
    ctx.fillText(clockStr(hourOfDay()), w - 18 * s, 52 * s);
    ctx.restore();
  }

  function drawWeapon() {
    const info = weaponData(player());
    const bw = 180 * s;
    const bh = 70 * s;
    const x = w - 18 * s - bw;
    const y = h - 18 * s - bh;

    chip(x, y, bw, bh, 7 * s);

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + 12 * s + 'px ' + UI_FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = PAL.ink;
    ctx.fillText(shorten(info.name, bw - 24 * s), x + 12 * s, y + 16 * s);
    ctx.restore();

    // The magazine decides whether you can shoot right now; the reserve is
    // planning information, so it is smaller, dimmer and sits after a slash.
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '700 ' + 28 * s + 'px ' + DIGIT_FONT;
    const magText = ammoStr(info.mag);
    ctx.fillStyle = Number(info.mag) === 0 ? PAL.hpCrit : PAL.ink;
    ctx.fillText(magText, x + 12 * s, y + 44 * s);
    const magW = ctx.measureText(magText).width;
    ctx.font = '700 ' + 14 * s + 'px ' + DIGIT_FONT;
    ctx.fillStyle = PAL.faint;
    ctx.fillText('/ ' + ammoStr(info.reserve), x + 12 * s + magW + 6 * s, y + 45 * s);
    ctx.restore();

    // A thin magazine gauge under the numbers turns "three rounds left" into
    // a shape the eye catches while aiming, without adding a second number.
    if (Number.isFinite(info.size) && info.size > 0) {
      const frac = clamp(Number(info.mag) / info.size, 0, 1);
      meter(x + 12 * s, y + bh - 9 * s, bw - 24 * s, 3 * s, frac, PAL.gold);
    }
  }

  function drawSpeed() {
    const ps = player();
    const kmh = Math.round(speedMs(ps) * 3.6);
    const driving = inVehicle(ps);
    if (!driving && kmh < 2) return;

    const label = String(kmh);
    ctx.save();
    ctx.font = '700 ' + 30 * s + 'px ' + DIGIT_FONT;
    const numW = ctx.measureText(label).width;
    ctx.font = '700 ' + 11 * s + 'px ' + UI_FONT;
    const unitW = ctx.measureText('KM/H').width;
    const bw = numW + unitW + 34 * s;
    const bh = 44 * s;
    const x = w - 18 * s - bw;
    const y = h - 18 * s - 70 * s - 8 * s - bh;

    chip(x, y, bw, bh, 7 * s);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '700 ' + 30 * s + 'px ' + DIGIT_FONT;
    ctx.fillStyle = PAL.ink;
    ctx.fillText(label, x + 12 * s, y + bh / 2 + 1 * s);
    ctx.font = '700 ' + 11 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.faint;
    ctx.fillText('KM/H', x + 12 * s + numW + 8 * s, y + bh / 2 + 1 * s);
    ctx.restore();
  }

  function drawToast() {
    if (toastLeft <= 0 || !toastMsg) return;
    const life = clamp(toastLeft / toastTotal, 0, 1);
    // Ease in over the first TOAST_EDGE of the life and out over the last, so
    // the message is legible in the middle and never pops on or off.
    const alpha = clamp(Math.min((1 - life) / TOAST_EDGE, life / TOAST_EDGE), 0, 1);
    if (alpha <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '700 ' + 14 * s + 'px ' + UI_FONT;
    const textW = ctx.measureText(toastMsg).width;
    const bw = Math.min(w - 48 * s, textW + 44 * s);
    const bh = 34 * s;
    const x = w / 2 - bw / 2;
    // Cleared above the tallest bottom panel so a long toast can never sit on
    // the weapon block.
    const y = h - 118 * s;
    chip(x, y, bw, bh, 4 * s, 'rgba(14, 18, 24, 0.86)', 'rgba(255, 255, 255, 0.22)');
    // Amber tab echoes the mission card: every transient message looks like it
    // came from the same machine as the mission brief.
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(x + 1, y + 1, 3 * s, bh - 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PAL.ink;
    ctx.fillText(shorten(toastMsg, bw - 30 * s), w / 2, y + bh / 2);
    ctx.restore();
  }

  // --- public API ----------------------------------------------------------

  function draw(time) {
    if (!w || !h) resize();

    // Accept seconds or milliseconds: anything past 1e7 is a millisecond stamp.
    const now = time == null ? performance.now() : time > 1e7 ? time : time * 1000;
    const elapsed = Number.isFinite(prevT) ? Math.max(0, (now - prevT) / 1000) : 1 / 60;
    prevT = now;
    // Smoothing uses a capped step so a long stall cannot make a bar lurch;
    // the toast uses true elapsed time, or a backgrounded tab would pin a
    // stale message on screen.
    dt = Math.min(elapsed, 0.1);
    if (toastLeft > 0) toastLeft = Math.max(0, toastLeft - elapsed);

    // Clear in CSS pixels with the backing-store transform applied, so layout
    // math and the renderer's viewport agree at any dpr.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    drawRadar(now);
    drawVitals();
    drawMissionCard();
    drawWanted();
    drawMoney();
    drawSpeed();
    drawWeapon();
    drawToast();
  }

  function toast(message, seconds) {
    toastMsg = String(message == null ? '' : message);
    toastTotal = Math.max(0.5, Number(seconds) || 2.6);
    toastLeft = toastTotal;
  }

  function setObjective(next) {
    if (!next) {
      mission = null;
      return;
    }
    mission = {
      title: next.title != null ? String(next.title) : 'MISSION',
      step: next.step != null ? String(next.step) : '',
      label: next.label != null ? String(next.label) : '',
      detail: next.detail != null ? String(next.detail) : '',
    };
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', resize);
  }

  return { draw, toast, setObjective, resize };
}

// Heat -> stars, exported so the pause board and any other screen can report
// the wanted level with the same rule the HUD and the police response use,
// instead of each inventing one.
export function wantedStars(heat) {
  const hv = Number(heat) || 0;
  let level = 0;
  for (let i = 0; i < HEAT.length; i++) if (hv >= HEAT[i]) level = i;
  return clamp(level, 0, 5);
}
