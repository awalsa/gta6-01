// Mission director for Puerto Fuego — Dani Reyes, bike courier caught
// between two crews, taking jobs across the waterfront city.
//
// A step is plain data and is only ever finished by observation: standing
// inside a circle, sitting at the wheel, a kill the combat module reports,
// a timer running down. Nothing here scripts an NPC, which is why the same
// job can be replayed from a save and driven by a headless test with a
// fake ctx.

import * as THREE from 'three';
import { ECONOMY } from './config.js';
import { clamp, distance2D } from './mathutil.js';

// 1 world unit is 1 metre, so distances go straight into objective text
// with no conversion factor.
const METRES_PER_UNIT = 1;

// How close each kind of step needs Dani to be. A goto is a doorstep, a
// steal is a car plus a door swing, a survive is "hold this corner", an
// escape is "far enough that the street stops looking for you" — all
// overridable per step through target.radius.
const REACH = {
  goto: 5,
  steal: 12,
  deliver: 7,
  kill: 32,
  survive: 15,
  wait: 9,
  escape: 80,
};

// Seconds a survive/wait step runs when the table forgets to say.
const DEFAULT_HOLD = 12;

// Above this planar speed a `wait` step stops counting: pacing around a
// stakeout is fine, sprinting through it is not.
const WAIT_SPEED_LIMIT = 2.6;

// The job board. Each entry is a small story in four or five beats: long
// enough to have a shape, short enough that a session finishes two of them.
export const MISSIONS = [
  {
    id: 'tamale-run',
    title: 'Tamale Run',
    story: 'Doña Elba pays cash and never asks what else is under the ice.',
    steps: [
      { kind: 'goto', label: 'Pick up the cooler behind the taquería', target: { x: -47, z: 47 }, count: 1, payout: 0 },
      { kind: 'deliver', label: 'Run the cooler down to the pier gate', target: { x: 94, z: -47 }, count: 1, payout: 240 },
      { kind: 'wait', label: 'Wait for the buyer to flash his headlights', target: { x: 94, z: -47 }, count: 6, payout: 180 },
      { kind: 'escape', label: 'Lose the tail before it gets your plate', target: { x: 94, z: -47 }, count: 55, payout: 320 },
    ],
  },
  {
    id: 'vela-job',
    title: 'The Vela Job',
    story: 'Los Tiburones want the pink coupé back, and they want it re-plated by morning.',
    steps: [
      { kind: 'goto', label: 'Meet the crew behind the body shop', target: { x: -94, z: 94 }, count: 1, payout: 0 },
      { kind: 'steal', label: 'Take the Vela out of the marina lot', target: { x: 47, z: -94 }, count: 1, payout: 160 },
      { kind: 'deliver', label: 'Park it in the bay on Calle Hondo', target: { x: -141, z: -47 }, count: 1, payout: 430 },
      { kind: 'survive', label: 'Sit tight while they swap the plates', target: { x: -141, z: -47 }, count: 14, payout: 210 },
    ],
  },
  {
    id: 'feria-shakedown',
    title: 'Feria Shakedown',
    story: 'The collector at the feria has your money in his jacket and two friends behind him.',
    steps: [
      { kind: 'goto', label: 'Find the collector at the feria stalls', target: { x: -141, z: 47 }, count: 1, payout: 0 },
      { kind: 'wait', label: 'Let him finish counting what is yours', target: { x: -141, z: 47 }, count: 4, payout: 0 },
      { kind: 'kill', label: 'Put down the two he brought with him', target: { x: -141, z: 47 }, count: 2, payout: 260 },
      { kind: 'survive', label: 'Hold the stall while the crowd scatters', target: { x: -141, z: 47 }, count: 18, payout: 340 },
      { kind: 'escape', label: 'Get off Calle Verde before the sirens', target: { x: -141, z: 47 }, count: 65, payout: 390 },
    ],
  },
  {
    id: 'coral-room',
    title: 'Coral Room Getaway',
    story: 'The band is loud enough to cover an engine, which is exactly why the client booked them.',
    steps: [
      { kind: 'goto', label: 'Walk up to the club door on the north strip', target: { x: 0, z: -141 }, count: 1, payout: 0 },
      { kind: 'steal', label: 'Take the sedan while the band plays', target: { x: 0, z: -141 }, count: 1, payout: 120 },
      { kind: 'escape', label: 'Break the roadblock at the causeway', target: { x: 0, z: -141 }, count: 85, payout: 300 },
      { kind: 'survive', label: 'Stay moving until the helicopter peels off', target: { x: 47, z: -94 }, count: 16, payout: 360 },
      { kind: 'deliver', label: 'Leave the car at the marina and walk away', target: { x: 104, z: -36 }, count: 1, payout: 520 },
    ],
  },
  {
    id: 'last-call',
    title: 'Last Call',
    story: 'A bar tab, a borrowed ledger, and a doorman who thinks the ledger is his.',
    steps: [
      { kind: 'goto', label: 'Settle the tab at the Salón Bolívar', target: { x: -94, z: -141 }, count: 1, payout: 0 },
      { kind: 'kill', label: 'Deal with the man holding the door', target: { x: -94, z: -141 }, count: 1, payout: 220 },
      { kind: 'survive', label: 'Ride out the shouting in the back room', target: { x: -94, z: -141 }, count: 12, payout: 280 },
      { kind: 'escape', label: 'Walk out before the owner calls it in', target: { x: -94, z: -141 }, count: 45, payout: 350 },
    ],
  },
];

function numOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function reachOf(step) {
  // A designer-written target.radius wins over the per-kind default.
  const declared = step && step.target ? numOr(step.target.radius, NaN) : NaN;
  if (Number.isFinite(declared) && declared > 0) return declared;
  return (step && REACH[step.kind]) || 5;
}

function targetXY(step) {
  if (!step || !step.target) return null;
  const x = numOr(step.target.x, NaN);
  const z = numOr(step.target.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

// One additive material helper for the beacon parts: unlit, see-through,
// drawn after everything else so the destination stays findable even
// behind the bus Dani is stuck behind.
function glowMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

// Objective pillar: a tall beam plus a ground ring. The cylinder is shifted
// up by half its height so the group origin stays the ground contact point
// and the ring can share it.
function buildBeacon() {
  const group = new THREE.Group();
  group.name = 'mission-marker';

  const beamGeo = new THREE.CylinderGeometry(1.9, 1.9, 10, 24, 1, true);
  beamGeo.translate(0, 5, 0);
  const beam = new THREE.Mesh(beamGeo, glowMaterial(0xffa347, 0.13));
  beam.renderOrder = 900;
  beam.frustumCulled = false;

  const ring = new THREE.Mesh(new THREE.RingGeometry(1.55, 2.45, 40), glowMaterial(0xffd08a, 0.6));
  ring.rotation.x = -Math.PI / 2;
  // A few centimetres up: a flat ring at ground level z-fights the asphalt
  // from any camera more than twenty metres away.
  ring.position.y = 0.06;
  ring.renderOrder = 901;
  ring.frustumCulled = false;

  group.add(beam, ring);
  group.visible = false;
  return { group, beam, ring };
}

export function createMissions(scene, handles, player) {
  const beacon = buildBeacon();
  // The director works headless too: no scene just means no pillar.
  if (scene && typeof scene.add === 'function') scene.add(beacon.group);

  const state = {
    active: null, // mission id, which is also what save.js persists
    mission: null, // resolved table entry
    step: 0, // 0-based index into mission.steps
    total: 0,
    timer: 0, // seconds banked on the current survive/wait step
    kills: 0, // kills credited to the current kill step
    distance: 0, // metres to the current target, refreshed every update
    payout: 0, // cash banked during this mission
    completed: 0, // lifetime count, a cheap progress readout
    pulse: 0,
    lastEvent: null, // { type, id, label, payout?, reason? } for HUD and audio
  };

  // The ground handle is optional and may be mid-construction; asking it
  // defensively keeps a beach target from hanging the pillar at sea level.
  function groundY(x, z) {
    if (handles && typeof handles.groundHeight === 'function') {
      try {
        const h = handles.groundHeight(x, z);
        if (Number.isFinite(h)) return h;
      } catch {
        // Fall through to sea level.
      }
    }
    return 0;
  }

  function whereIs(ctx) {
    // ctx.position wins: a replay or a test can drive the director with a
    // point that is not the live player.
    const override = ctx && ctx.position;
    if (override && Number.isFinite(override.x) && Number.isFinite(override.z)) return override;
    const live = player && player.state && player.state.position;
    if (live && Number.isFinite(live.x) && Number.isFinite(live.z)) return live;
    return null;
  }

  function inCar(ctx) {
    if (ctx && typeof ctx.inVehicle === 'boolean') return ctx.inVehicle;
    if (ctx && ctx.vehicle) return true;
    return !!(player && player.state && player.state.inVehicle);
  }

  function isAlive() {
    const ps = player && player.state;
    // `undefined` means a player module without the flag; treat that as
    // alive rather than failing every job on its first frame.
    return !ps || ps.alive !== false;
  }

  // Combat reports kills per frame: a number, or the list of victims from
  // that frame. Anything else is ignored so a stray boolean cannot clear a
  // kill step for free.
  function killsReported(ctx) {
    if (!ctx) return 0;
    const reported = ctx.kills;
    if (Array.isArray(reported)) return reported.length;
    const n = Number(reported);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function currentSpeed() {
    const vel = player && player.state && player.state.velocity;
    if (!vel) return 0;
    return Math.hypot(numOr(vel.x, 0), numOr(vel.z, 0));
  }

  function giveCash(amount) {
    const cash = Math.max(0, Math.round(numOr(amount, 0)));
    if (!cash) return;
    if (player && typeof player.addCash === 'function') {
      player.addCash(cash);
      return;
    }
    const ps = player && player.state;
    // Fallback so a hand-built player object still gets paid.
    if (ps) ps.cash = Math.max(0, numOr(ps.cash, 0) + cash);
  }

  function stepNow() {
    if (!state.mission) return null;
    return state.mission.steps[state.step] || null;
  }

  function hideBeacon() {
    beacon.group.visible = false;
  }

  function moveBeacon(step, dt) {
    const target = targetXY(step);
    // Escape steps point at the trouble being left behind, so a pillar
    // there would invite the player to drive back into it.
    if (!step || !target || step.kind === 'escape') {
      hideBeacon();
      return;
    }
    beacon.group.visible = true;
    beacon.group.position.set(target.x, groundY(target.x, target.z), target.z);

    state.pulse = (state.pulse + numOr(dt, 0)) % (Math.PI * 2);
    const breathe = 0.5 + 0.5 * Math.sin(state.pulse * 2.2);
    beacon.beam.material.opacity = 0.1 + 0.07 * breathe;
    beacon.ring.material.opacity = 0.4 + 0.35 * breathe;
    // The ring breathes on XZ only: scaling Y would lift it off the road.
    const scale = 1 + 0.05 * breathe;
    beacon.ring.scale.set(scale, scale, 1);
  }

  // A step's payout, falling back to the economy table when the step does
  // not carry its own number.
  function stepPayout(step, index) {
    if (step && Number.isFinite(step.payout)) return Math.max(0, Math.round(step.payout));
    const table = ECONOMY && Array.isArray(ECONOMY.jobPayouts) ? ECONOMY.jobPayouts : [];
    const fallback = table[Math.min(Math.max(0, index), table.length - 1)];
    return Number.isFinite(fallback) ? Math.max(0, Math.round(fallback)) : 0;
  }

  function completeStep() {
    const mission = state.mission;
    if (!mission) return;
    const step = mission.steps[state.step];
    if (!step) return;
    const payout = stepPayout(step, state.step);
    giveCash(payout);
    state.payout += payout;
    state.lastEvent = { type: 'step', id: mission.id, label: step.label, payout };
    state.step += 1;
    state.timer = 0;
    state.kills = 0;
    if (state.step >= mission.steps.length) finishMission();
  }

  function finishMission() {
    const mission = state.mission;
    if (!mission) return;
    state.completed += 1;
    state.lastEvent = { type: 'done', id: mission.id, label: mission.title, payout: state.payout };
    state.active = null;
    state.mission = null;
    state.step = 0;
    state.total = 0;
    state.timer = 0;
    state.kills = 0;
    state.distance = 0;
    hideBeacon();
  }

  function abort(reason) {
    const mission = state.mission;
    if (mission) {
      state.lastEvent = { type: 'fail', id: mission.id, label: mission.title, reason: reason || 'Job dropped' };
    }
    state.active = null;
    state.mission = null;
    state.step = 0;
    state.total = 0;
    state.timer = 0;
    state.kills = 0;
    state.distance = 0;
    state.payout = 0;
    hideBeacon();
    return state;
  }

  function startMission(id) {
    const mission = MISSIONS.find((entry) => entry.id === id);
    if (!mission) {
      state.lastEvent = { type: 'fail', id: String(id), reason: 'No such job' };
      return false;
    }
    state.active = mission.id;
    state.mission = mission;
    state.step = 0;
    state.total = mission.steps.length;
    state.timer = 0;
    state.kills = 0;
    state.payout = 0;
    state.distance = 0;
    state.lastEvent = { type: 'start', id: mission.id, label: mission.title };
    moveBeacon(stepNow(), 0);
    return true;
  }

  function currentMission() {
    if (!state.mission) return null;
    return {
      id: state.mission.id,
      title: state.mission.title,
      story: state.mission.story,
      step: state.step,
      total: state.mission.steps.length,
      stepLabel: stepNow() ? stepNow().label : '',
      payout: state.payout,
    };
  }

  // ---- Per-kind step checks -------------------------------------------------
  // Each checker returns true when its step is done. They share one reading
  // of the world (here/target/reach) passed in as `world`, and a `tick`
  // carrying the clamped frame time plus the frame's ctx.

  function checkArrive(world, tick) {
    const { step } = world;
    if (!world.target || !world.here || world.distance > world.reach) return false;
    // Car jobs gate on being at the wheel: a drop-off reached on foot
    // would otherwise clear by walking past the bay.
    if ((step.kind === 'steal' || step.requireVehicle) && !inCar(tick.ctx)) return false;
    return true;
  }

  function checkKill(world, tick) {
    const need = Math.max(1, Math.floor(numOr(world.step.count, 1)));
    // Kills only count near the target: dropping a stranger two blocks
    // away is not the hit this step is asking for.
    if (world.target && world.here && world.distance > world.reach) return false;
    state.kills += killsReported(tick.ctx);
    return state.kills >= need;
  }

  function checkHold(world, tick) {
    const need = Math.max(1, numOr(world.step.count, DEFAULT_HOLD));
    // Leaving pauses the clock instead of resetting it: punishing a dodge
    // with a full restart turns a firefight into a chore.
    if (world.target && world.here && world.distance > world.reach) return false;
    state.timer += tick.dt;
    return state.timer >= need;
  }

  function checkWait(world, tick) {
    const need = Math.max(1, numOr(world.step.count, DEFAULT_HOLD));
    if (world.target && world.here && world.distance > world.reach) return false;
    if (currentSpeed() > WAIT_SPEED_LIMIT) return false;
    state.timer += tick.dt;
    return state.timer >= need;
  }

  function checkEscape(world) {
    if (!world.target || !world.here) return false;
    return world.distance >= world.reach;
  }

  // Dispatch table instead of a switch: adding a step kind means adding
  // one row here, not touching the frame loop.
  const CHECKERS = {
    goto: checkArrive,
    steal: checkArrive,
    deliver: checkArrive,
    kill: checkKill,
    survive: checkHold,
    wait: checkWait,
    escape: checkEscape,
  };

  function update(dt, ctx) {
    // Clamped: a tab hidden for ten seconds must not deliver ten seconds
    // of survive timer in one frame, or every hold step completes on return.
    const stepDt = clamp(numOr(dt, 0), 0, 0.25);
    const step = stepNow();
    if (!step) {
      hideBeacon();
      return state;
    }

    const here = whereIs(ctx);
    const target = targetXY(step);
    const reach = reachOf(step);
    const distance = here && target ? distance2D(here, target) : 0;
    state.distance = distance * METRES_PER_UNIT;

    moveBeacon(step, stepDt);

    // Death ends the job before the per-kind checks run, so a corpse cannot
    // bank the final second of a survive timer.
    if (!isAlive()) {
      abort('You went down before the job was done.');
      return state;
    }

    const checker = CHECKERS[step.kind];
    // Unknown kind: park the job rather than silently paying it out.
    if (!checker) return state;
    if (checker({ step, here, target, reach, distance }, { dt: stepDt, ctx })) {
      completeStep();
    }
    return state;
  }

  // Accepts a step object, a step index, a mission id (for the job-board
  // beacon) or nothing for the live step. The result is plain data so the
  // HUD and the minimap never have to touch a three.js object.
  function markerFor(step) {
    let resolved = step;
    if (resolved === undefined || resolved === null) resolved = stepNow();
    else if (typeof resolved === 'number' && state.mission) resolved = state.mission.steps[resolved];
    else if (typeof resolved === 'string') {
      const mission = MISSIONS.find((entry) => entry.id === resolved);
      resolved = mission ? mission.steps[0] : null;
    }
    if (!resolved || typeof resolved !== 'object') return null;
    const target = targetXY(resolved);
    if (!target || resolved.kind === 'escape') return null;
    return {
      x: target.x,
      y: groundY(target.x, target.z),
      z: target.z,
      radius: reachOf(resolved),
      kind: resolved.kind,
      object: beacon.group,
    };
  }

  function objective() {
    const mission = state.mission;
    const step = stepNow();
    if (!mission || !step) {
      return { title: 'Free roam', step: 0, total: 0, label: 'No job running', detail: '' };
    }
    const here = whereIs(null);
    const target = targetXY(step);
    const distance = here && target ? distance2D(here, target) * METRES_PER_UNIT : 0;
    return {
      title: mission.title,
      step: state.step,
      number: state.step + 1,
      total: mission.steps.length,
      label: step.label,
      // Rounded to whole metres: a HUD that ticks every centimetre is noise.
      detail: here && target ? `${Math.round(distance)} m` : '',
      distance,
      kind: step.kind,
      // Timed steps want a countdown, kill steps want progress; both are
      // free here because the state is already tracked.
      timer: Math.max(0, numOr(step.count, DEFAULT_HOLD) - state.timer),
      kills: state.kills,
      killsNeeded: Math.max(1, Math.floor(numOr(step.count, 1))),
    };
  }

  return {
    state,
    start: startMission, // blueprint name, kept as an alias
    startMission,
    update,
    markerFor,
    objective,
    abort,
    currentMission,
  };
}
