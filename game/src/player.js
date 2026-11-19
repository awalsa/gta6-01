// Dani Reyes on foot: position, velocity, health and the wallet she carries.
// Pure state and arithmetic — no meshes, no scene. The frame loop reads `state`
// and the character module draws it, so a headless test can drive this with a
// fake input object and never touch three.js.

import { PLAYER, WORLD, ECONOMY } from './config.js';
import { clamp, turnToward, damp } from './mathutil.js';

/** The north end of the beach strip, where a run starts. */
const SPAWN = { x: 47, y: WORLD.groundY, z: 54 };

/** How hard she brakes when the stick returns to centre (m/s^2). Faster than her
 *  acceleration on purpose: a GTA-style hero plants her feet, she does not glide. */
const BRAKE = 26;

/** Steering authority while airborne, as a share of ground acceleration. */
const AIR_STEER = 0.35;

/** Below this planar speed her facing is left alone — the last twitch of a
 *  stopping step must not spin her toward a wall. */
const FACE_EPSILON = 0.4;

/** Fallback world for a caller that has no city yet: flat ground, no buildings. */
const FLAT_WORLD = {
  insideBuilding: () => false,
  groundHeight: () => WORLD.groundY,
};

function freshState() {
  return {
    position: { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z },
    velocity: { x: 0, y: 0, z: 0 },
    // Yaw 0 faces north (-Z), increasing clockwise — see config.js.
    yaw: Math.PI,
    health: PLAYER.maxHealth,
    armour: 0,
    cash: ECONOMY.startCash,
    alive: true,
    inVehicle: false,
    weapon: 'fists',
    grounded: true,
    speed: 0,
  };
}

export function createPlayer() {
  const state = freshState();

  /** Move a scalar toward a goal by at most `step`; never overshoots. */
  function easeToward(value, goal, step) {
    const gap = goal - value;
    if (Math.abs(gap) <= step) return goal;
    return value + Math.sign(gap) * step;
  }

  function reset() {
    // Cash and the drawn weapon survive a hospital trip. The fee is charged by
    // whoever kills her; charging it again here would tax death twice.
    const keptCash = state.cash;
    const keptWeapon = state.weapon;
    Object.assign(state, freshState(), { cash: keptCash, weapon: keptWeapon });
  }

  /** Camera-relative steering: stick-up always runs away from the lens. */
  function wantedDirection(axes, cameraYaw) {
    const forwardX = Math.sin(cameraYaw);
    const forwardZ = -Math.cos(cameraYaw);
    const rightX = Math.cos(cameraYaw);
    const rightZ = Math.sin(cameraYaw);

    let x = forwardX * axes.moveZ + rightX * axes.moveX;
    let z = forwardZ * axes.moveZ + rightZ * axes.moveX;
    const len = Math.hypot(x, z);
    if (len > 1e-4) {
      x /= len;
      z /= len;
    }
    return { x, z, active: len > 1e-4 };
  }

  /** Resolve the camera yaw from whichever handle the caller supplied. */
  function resolveCameraYaw(ctx) {
    if (typeof ctx.cameraYaw === 'number') return ctx.cameraYaw;
    if (ctx.rig && ctx.rig.state && typeof ctx.rig.state.yaw === 'number') return ctx.rig.state.yaw;
    if (ctx.camera && ctx.camera.state && typeof ctx.camera.state.yaw === 'number') return ctx.camera.state.yaw;
    return state.yaw;
  }

  function rideVehicle(vehicle) {
    // The car owns the transform while she rides. Values are copied, not aliased,
    // so a physics step mutating its own vector cannot drag the camera mid-frame.
    const pose = vehicle.state;
    state.position.x = pose.position.x;
    state.position.y = pose.position.y;
    state.position.z = pose.position.z;
    if (typeof pose.yaw === 'number') state.yaw = pose.yaw;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.speed = 0;
    state.grounded = true;
  }

  function bleedOut(dt) {
    // A corpse slides to a halt; no input reaches the controls once dead.
    const factor = 1 - damp(BRAKE, dt);
    state.velocity.x *= 1 - factor;
    state.velocity.z *= 1 - factor;
    state.speed = Math.hypot(state.velocity.x, state.velocity.z);
  }

  function stepGround(dt, handles) {
    const ground = handles.groundHeight(state.position.x, state.position.z) ?? WORLD.groundY;
    if (state.grounded) {
      // Kerbs are ~22 cm; snapping is steadier than modelling them as a fall.
      state.position.y = ground;
      state.velocity.y = 0;
      return ground;
    }
    state.velocity.y += PLAYER.gravity * dt;
    state.position.y += state.velocity.y * dt;
    if (state.position.y <= ground) {
      state.position.y = ground;
      state.velocity.y = 0;
      state.grounded = true;
    }
    return ground;
  }

  function update(dt, ctx = {}) {
    if (!(dt > 0)) return;

    const vehicle = ctx.vehicle;
    if (state.inVehicle && vehicle && vehicle.state && vehicle.state.position) {
      rideVehicle(vehicle);
      return;
    }

    if (!state.alive) {
      bleedOut(dt);
      return;
    }

    const input = ctx.input;
    const handles = ctx.handles || FLAT_WORLD;
    const axes = input && input.state ? input.state : { moveX: 0, moveZ: 0 };

    const camYaw = resolveCameraYaw(ctx);
    const wish = wantedDirection(axes, camYaw);

    const aiming = !!axes.aim;
    // Sprint only while pushing forward, never while aiming — a scoped sprint
    // would make the aim-down-sights trade-off free.
    const sprinting = !!axes.sprint && axes.moveZ > 0.5 && !aiming;
    const topSpeed = aiming ? PLAYER.walk * 0.7 : sprinting ? PLAYER.sprint : PLAYER.run;

    const push = (state.grounded ? PLAYER.accel : PLAYER.accel * AIR_STEER) * dt;
    if (wish.active) {
      state.velocity.x = easeToward(state.velocity.x, wish.x * topSpeed, push);
      state.velocity.z = easeToward(state.velocity.z, wish.z * topSpeed, push);
    } else {
      // Approach to zero by a capped step, never a multiplier: `v *= (1 - k)`
      // reverses slightly at long frame times and twitches her backward on stop.
      state.velocity.x = easeToward(state.velocity.x, 0, BRAKE * dt);
      state.velocity.z = easeToward(state.velocity.z, 0, BRAKE * dt);
    }

    // --- collision, one axis at a time, so a diagonal approach slides along a
    // facade instead of stopping dead against it.
    const limit = WORLD.extent - PLAYER.radius;

    const nextX = clamp(state.position.x + state.velocity.x * dt, -limit, limit);
    if (!handles.insideBuilding(nextX, state.position.z, PLAYER.radius)) {
      state.position.x = nextX;
    } else {
      state.velocity.x = 0;
    }

    const nextZ = clamp(state.position.z + state.velocity.z * dt, -limit, limit);
    if (!handles.insideBuilding(state.position.x, nextZ, PLAYER.radius)) {
      state.position.z = nextZ;
    } else {
      state.velocity.z = 0;
    }

    // --- jump: edge-triggered, so holding Space cannot relaunch her the frame
    // she lands.
    const jumpPressed = input
      ? input.wasPressed
        ? input.wasPressed('jump')
        : !!axes.jump
      : false;
    if (state.grounded && jumpPressed) {
      state.velocity.y = PLAYER.jump;
      state.grounded = false;
    }
    stepGround(dt, handles);

    // --- facing follows the direction of travel, not the stick.
    const planar = Math.hypot(state.velocity.x, state.velocity.z);
    state.speed = planar;
    if (planar > FACE_EPSILON) {
      // atan2(x, -z): yaw 0 must face -Z under the config convention.
      const heading = Math.atan2(state.velocity.x, -state.velocity.z);
      state.yaw = turnToward(state.yaw, heading, PLAYER.turnRate * dt);
    }
  }

  /**
   * Armour soaks first; only the overflow reaches health. Returns the amount
   * actually taken, so the HUD can tell a fully plated hit from a wound.
   */
  function damage(amount) {
    if (!state.alive || !(amount > 0)) return 0;

    let left = amount;
    let taken = 0;

    if (state.armour > 0) {
      const absorbed = Math.min(state.armour, left);
      state.armour -= absorbed;
      left -= absorbed;
      taken += absorbed;
    }
    if (left > 0) {
      const lost = Math.min(state.health, left);
      state.health -= lost;
      taken += lost;
    }

    if (state.health <= 0) {
      state.health = 0;
      state.alive = false;
      // Step out of the wreckage on death, or respawn logic would try to move a
      // corpse with the car it just died in.
      state.inVehicle = false;
    }
    return taken;
  }

  function heal(amount) {
    if (!state.alive || !(amount > 0)) return 0;
    const before = state.health;
    state.health = Math.min(PLAYER.maxHealth, state.health + amount);
    return state.health - before;
  }

  function addCash(amount) {
    // Floored at zero: the economy has no debt, and a negative wallet would make
    // every affordability check pass by accident.
    state.cash = Math.max(0, state.cash + Math.round(amount));
    return state.cash;
  }

  return { state, reset, update, damage, heal, addCash };
}
