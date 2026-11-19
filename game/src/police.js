// Wanted system for Puerto Fuego.
//
// Dani builds up "heat" by committing crimes. Heat maps onto a star band,
// and each band decides how many cruisers answer and how boldly they drive.
// This module only decides things: it never applies damage itself. When a
// cruiser's shot lands, the hit is reported through `ctx` (or the player's
// own damage hook) and the frame loop decides what armour and health do
// with it — the same split of duties as the combat module.

import * as THREE from 'three';
import { HEAT, RESPONSE } from './config.js';
import { ROAD_LINES } from './city.js';
import { clamp, createRandom, wrapAngle, TAU } from './mathutil.js';

// Heat charged per crime. An unlisted kind is ignored instead of inventing
// a price for it on the spot.
export const CRIMES = {
  assault: 1.0,
  reckless: 0.6,
  theft: 2.0,
  killCivilian: 3.0,
  killPolice: 4.4,
};

// ---- Tunables that live here, not in config -------------------------------
// The ladder itself (HEAT thresholds, RESPONSE rows) belongs to config.js;
// the numbers below are how this module reads that ladder.

const DECAY_PER_SECOND = typeof HEAT.decayPerSecond === 'number' ? HEAT.decayPerSecond : 0.16;
const NEAR_SPAWN = typeof RESPONSE.spawnDistanceMin === 'number' ? RESPONSE.spawnDistanceMin : 58;
const FAR_SPAWN = typeof RESPONSE.spawnDistanceMax === 'number' ? RESPONSE.spawnDistanceMax : 96;
const REINFORCE_GAP = 6.5; // seconds between one cruiser arriving and the next call
const HOLD_RING = 9; // distance at which a unit stops closing and holds position
const SHOOT_RANGE = 26; // how close a unit must be, with Dani on foot, to open fire
const SHOT_SPACING = 1.15; // base seconds between shots at full aggression
const TRACER_POOL = 14;
const TRACER_LIFE = 0.09;

// The ladder's top rung caps heat: past it, crimes only extend the wait.
const HEAT_TOP = HEAT[HEAT.length - 1];

// How many stars a given heat buys. The gaps between thresholds are uneven
// on purpose, so this walks the ladder instead of dividing by a fixed step.
function starsFromHeat(heat) {
  let stars = 0;
  for (let i = 1; i < HEAT.length; i++) {
    if (heat >= HEAT[i]) stars = i;
  }
  return Math.min(stars, RESPONSE.length - 1);
}

function responseRow(stars) {
  return RESPONSE[clamp(stars, 0, RESPONSE.length - 1)] || { units: 0, aggression: 0 };
}

function readPlayerPos(player) {
  const p = player && player.state && player.state.position;
  return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? p : null;
}

function readVehiclePos(vehicle) {
  const s = vehicle && (vehicle.state || vehicle);
  if (!s) return null;
  if (typeof s.x === 'number' && typeof s.z === 'number') return s;
  if (s.position && typeof s.position.x === 'number') return s.position;
  return null;
}

// Push a free point onto the nearest road line, so cruisers roll in from a
// street instead of materialising inside a building. Whichever axis is
// closer to a carriageway wins.
function snapOntoRoad(x, z) {
  if (!ROAD_LINES || ROAD_LINES.length === 0) return { x, z };
  let nearX = ROAD_LINES[0];
  let nearZ = ROAD_LINES[0];
  let gapX = Infinity;
  let gapZ = Infinity;
  for (const line of ROAD_LINES) {
    const dx = Math.abs(x - line);
    const dz = Math.abs(z - line);
    if (dx < gapX) { gapX = dx; nearX = line; }
    if (dz < gapZ) { gapZ = dz; nearZ = line; }
  }
  return gapX <= gapZ ? { x: nearX, z } : { x, z: nearZ };
}

export function createPolice(vehicles, player, scene) {
  const rng = createRandom(0x9e3779b9);

  // `units` entries are { id, vehicleId, mode, fireTimer, stuckTimer,
  // lastDistance, pressure, lostTimer }. Mode is one of
  // 'chase' | 'ram' | 'standoff' | 'stuck'.
  const wanted = {
    heat: 0,
    stars: 0,
    units: [],
    backupTimer: 0,
    lastCrime: null,
    gunfire: 0, // seconds of police gunfire still ringing, for HUD/audio cues
  };

  let nextUnitId = 1;

  // ---- Police tracer pool -------------------------------------------------
  // Cool white-blue streaks, visually distinct from the player's warm muzzle
  // flash, so a firefight reads as two sides even at a glance.
  const tracerGeo = new THREE.BoxGeometry(0.06, 0.06, 1);
  const tracerGroup = new THREE.Group();
  tracerGroup.name = 'police-tracers';
  if (scene) scene.add(tracerGroup);
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xbfd8ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(tracerGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    tracerGroup.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let tracerNext = 0;

  function fireTracer(from, to) {
    const tracer = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % TRACER_POOL;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.4) return;
    tracer.mesh.position.set(from.x + dx * 0.5, from.y + dy * 0.5, from.z + dz * 0.5);
    tracer.mesh.lookAt(to.x, to.y, to.z);
    tracer.mesh.scale.set(1, 1, len);
    tracer.mesh.material.opacity = 0.7;
    tracer.mesh.visible = true;
    tracer.life = TRACER_LIFE;
  }

  function tickTracers(dt) {
    for (const tracer of tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      if (tracer.life <= 0) {
        tracer.mesh.visible = false;
        tracer.mesh.material.opacity = 0;
      } else {
        tracer.mesh.material.opacity = 0.7 * (tracer.life / TRACER_LIFE);
      }
    }
  }

  // ---- Fleet plumbing -----------------------------------------------------
  // The vehicle system owns spawning, stepping and recycling. Police only
  // hands it an input packet each frame, exactly the way traffic does, so a
  // cruiser obeys the same collision and handling as any other car.

  function findVehicle(vehicleId) {
    if (!vehicles) return null;
    if (typeof vehicles.byId === 'function') {
      const found = vehicles.byId(vehicleId);
      if (found) return found;
    }
    const list = vehicles.vehicles;
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (entry && entry.id === vehicleId) return entry;
      }
    }
    return null;
  }

  function pickSpawn(px, pz) {
    const angle = rng() * TAU;
    const dist = NEAR_SPAWN + rng() * (FAR_SPAWN - NEAR_SPAWN);
    // Yaw 0 faces -Z, so the ring is walked as (sin, -cos).
    const snapped = snapOntoRoad(px + Math.sin(angle) * dist, pz - Math.cos(angle) * dist);
    return {
      x: snapped.x,
      z: snapped.z,
      // Nose pointed at Dani on arrival, so the cruiser never drives away
      // from the chase it was called for.
      yaw: Math.atan2(px - snapped.x, -(pz - snapped.z)),
    };
  }

  function spawnUnit(px, pz) {
    if (!vehicles || typeof vehicles.spawn !== 'function') return null;
    const spot = pickSpawn(px, pz);
    let vehicle = null;
    try {
      // `police` fits the light bar; `driver: 'police'` keeps traffic AI
      // from trying to steer the cruiser itself.
      vehicle = vehicles.spawn('cruiser', spot.x, spot.z, spot.yaw, { driver: 'police', police: true });
    } catch {
      vehicle = null;
    }
    if (!vehicle) return null;
    vehicle.autoStep = true;
    const unit = {
      id: nextUnitId++,
      vehicleId: vehicle.id,
      mode: 'chase',
      fireTimer: 0.7 + rng() * 0.9,
      stuckTimer: 0,
      lastDistance: 999,
      pressure: 0, // 0 far away, 1 once a cruiser is close enough to threaten
      lostTimer: 0,
    };
    wanted.units.push(unit);
    wanted.backupTimer = REINFORCE_GAP;
    return unit;
  }

  function retireUnit(unit) {
    if (vehicles && typeof vehicles.despawn === 'function') vehicles.despawn(unit.vehicleId);
    const at = wanted.units.indexOf(unit);
    if (at >= 0) wanted.units.splice(at, 1);
  }

  function shedDownTo(count) {
    // Release the newest cruisers first; the ones already on Dani's tail
    // stay in the fight.
    while (wanted.units.length > count) {
      retireUnit(wanted.units[wanted.units.length - 1]);
    }
  }

  // ---- Public crime API ---------------------------------------------------

  function addCrime(kind, count = 1) {
    const weight = CRIMES[kind];
    if (weight === undefined) return wanted.heat;
    const before = wanted.stars;
    wanted.heat = clamp(wanted.heat + weight * Math.max(1, count), 0, HEAT_TOP);
    wanted.stars = starsFromHeat(wanted.heat);
    wanted.lastCrime = kind;
    if (wanted.stars > before) {
      // A new band wants its extra cruiser now, not at the next backup tick.
      wanted.backupTimer = Math.min(wanted.backupTimer, 0.35);
    }
    return wanted.heat;
  }

  function clearWanted() {
    wanted.heat = 0;
    wanted.stars = 0;
    wanted.backupTimer = 0;
    for (let i = wanted.units.length - 1; i >= 0; i--) retireUnit(wanted.units[i]);
  }

  function starCount() {
    return wanted.stars;
  }

  function cruiserFor(vehicleId) {
    for (const unit of wanted.units) {
      if (unit.vehicleId === vehicleId) return unit;
    }
    return null;
  }

  // ---- Per-unit driving + shooting ----------------------------------------

  function steerUnit(unit, dt, ctx, px, pz) {
    const vehicle = findVehicle(unit.vehicleId);
    const pos = vehicle ? readVehiclePos(vehicle) : null;
    if (!vehicle || !pos) {
      // Recycled under us (traffic churn, a despawn): drop it after a
      // grace period instead of chasing a ghost forever.
      unit.lostTimer += dt;
      if (unit.lostTimer > 1.5) retireUnit(unit);
      return;
    }
    unit.lostTimer = 0;

    const vs = vehicle.state || vehicle;
    const dx = px - pos.x;
    const dz = pz - pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const faceDani = Math.atan2(dx, -dz); // forward is (sin yaw, -cos yaw)
    const { aggression } = responseRow(wanted.stars);
    const onFoot = !(player && player.state && player.state.inVehicle);

    // Mode is recomputed every frame and kept on the unit, so a HUD or a
    // screenshot can read what each cruiser is doing.
    if (dist > HOLD_RING * 3.2) unit.mode = 'chase';
    else if (aggression >= 0.5 && dist > HOLD_RING && onFoot) unit.mode = 'ram';
    else unit.mode = 'standoff';

    const closing = unit.lastDistance - dist;
    unit.lastDistance = dist;
    unit.pressure = clamp(1 - dist / (HOLD_RING * 4), 0, 1);

    // Barely closing while far away means something is in the way.
    if (closing < 1 && dist > 18) unit.stuckTimer += dt;
    else unit.stuckTimer = Math.max(0, unit.stuckTimer - dt * 2);

    const input = vehicle.input || (vehicle.input = { throttle: 0, steer: 0, brake: false, handbrake: false });
    let throttle = 1;
    let aimYaw = faceDani;

    if (unit.mode === 'standoff') {
      // Hold the ring: creep in, reverse out. A parked cruiser with its
      // lights on is the readable "surrounded" state, and it stops the car
      // from shoving Dani through a wall.
      throttle = dist < HOLD_RING * 0.55 ? -0.55 : dist > HOLD_RING * 1.4 ? 0.35 : 0;
    } else if (unit.mode === 'ram') {
      // Aim ahead of a moving Dani so a ram connects instead of following
      // her wake.
      const lead = Math.min(1.2, dist / 26);
      const vx = player?.state?.velocity?.x || 0;
      const vz = player?.state?.velocity?.z || 0;
      aimYaw = Math.atan2(px + vx * lead - pos.x, -(pz + vz * lead - pos.z));
    }

    if (unit.stuckTimer > 1.2) {
      // Reverse out at an angle and re-approach: a cruiser wedged on a kerb
      // never recovers by pushing harder into it.
      unit.mode = 'stuck';
      throttle = -1;
      aimYaw = faceDani + Math.PI * 0.5;
      if (unit.stuckTimer > 2.6) unit.stuckTimer = 0;
    }

    const delta = wrapAngle(aimYaw - (vs.yaw || 0));
    input.steer = clamp(delta * 1.8, -1, 1);
    input.throttle = throttle;
    input.brake = throttle <= 0;
    input.handbrake = false;

    // ---- Shooting: only at Dani on foot, only inside SHOOT_RANGE.
    unit.fireTimer -= dt;
    if (!onFoot || dist >= SHOOT_RANGE || unit.fireTimer > 0) return;
    unit.fireTimer = SHOT_SPACING * (1.9 - aggression);
    wanted.gunfire = 0.25;

    const noseYaw = vs.yaw || 0;
    const from = {
      x: pos.x + Math.sin(noseYaw) * 0.9,
      y: (typeof vs.y === 'number' ? vs.y : 0) + 1.15,
      z: pos.z - Math.cos(noseYaw) * 0.9,
    };
    const target = readPlayerPos(player);
    const to = {
      x: px + (rng() - 0.5) * 0.9,
      y: (target ? target.y : 0) + 1.25,
      z: pz + (rng() - 0.5) * 0.9,
    };
    fireTracer(from, to);

    // Accuracy is the aggression dial: a one-star unit sprays, a five-star
    // one rarely misses.
    if (rng() < 0.32 + aggression * 0.5) {
      const amount = 4 + aggression * 3;
      if (ctx && typeof ctx.damagePlayer === 'function') ctx.damagePlayer(amount, unit);
      else if (player && typeof player.damage === 'function') player.damage(amount);
    }
  }

  // ---- Frame update ---------------------------------------------------------

  function update(dt, ctx = {}) {
    if (!(dt > 0)) return;

    wanted.gunfire = Math.max(0, wanted.gunfire - dt);
    tickTracers(dt);

    const pos = readPlayerPos(player);
    const px = pos ? pos.x : 0;
    const pz = pos ? pos.z : 0;

    // Heat cools off steadily. Dropping a band releases the cruisers that
    // band paid for; reaching zero clears the fleet at once.
    if (wanted.heat > 0) {
      wanted.heat = Math.max(0, wanted.heat - DECAY_PER_SECOND * dt);
      const now = starsFromHeat(wanted.heat);
      if (now < wanted.stars) {
        wanted.stars = now;
        shedDownTo(responseRow(now).units);
      }
    }

    if (wanted.stars > 0) {
      const cap = responseRow(wanted.stars).units;
      if (wanted.units.length < cap) {
        if (wanted.backupTimer > 0) {
          wanted.backupTimer -= dt;
        } else if (!spawnUnit(px, pz)) {
          // A failed spawn retries shortly instead of burning a full delay.
          wanted.backupTimer = 1.2;
        }
      } else {
        wanted.backupTimer = 0;
      }
    } else if (wanted.units.length > 0) {
      for (let i = wanted.units.length - 1; i >= 0; i--) retireUnit(wanted.units[i]);
    }

    for (let i = wanted.units.length - 1; i >= 0; i--) {
      steerUnit(wanted.units[i], dt, ctx, px, pz);
    }
  }

  return {
    state: wanted,
    addCrime,
    commitCrime: addCrime, // blueprint name, kept as an alias
    clearWanted,
    starCount,
    wantedLevel: starCount, // task name for the same reading
    update,
    cruiserFor,
    CRIMES,
  };
}
