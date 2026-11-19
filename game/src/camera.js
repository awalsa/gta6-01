// The third-person lens: orbit angles, the spring that trails Dani, and the
// shake that weapons and impacts inject. Kept apart from the player so a script
// can pose the body with no rig attached, and the rig can be swapped for a fixed
// camera without touching movement code.

import * as THREE from 'three';
import { CAMERA, PLAYER } from './config.js';
import { clamp, damp, lerp } from './mathutil.js';

/** Closest the lens ever comes to the player. A couple of frames of interior
 *  view beats the camera passing through a facade, and this floor stops the
 *  boom test collapsing to zero and showing the inside of Dani's head. */
const BOOM_MIN = 0.55;

/** Samples along the eye-to-lens segment. Twelve is ~0.4 m apart at the default
 *  4.6 m boom: fine enough that the lens never visibly pokes through a corner,
 *  cheap enough to run twice per frame. */
const WALL_SAMPLES = 12;

/** Boom recovery rate once clear again. Slow on purpose: creeping back out is
 *  invisible, snapping out of cover reads as a jump cut. */
const BOOM_OUT = 3.2;

/** Boom pull-in rate when a wall appears. Fast on purpose: clipping is worse
 *  than a quick dolly-in. */
const BOOM_IN = 22;

/** Extra boom height while aiming, so the lens clears her shoulder. */
const AIM_LIFT = 0.42;

/** Shake noise frequency, radians per second of the decay clock. */
const SHAKE_HZ = 38;

/** Peak positional shake in metres at full impulse — a few centimetres reads as
 *  an impact; a decimetre would throw the lens through a doorway it was just
 *  clamped out of. */
const SHAKE_MAX = 0.11;

/** Boom-length blend rate for the aim pose; a boolean would pop the zoom. */
const AIM_RATE = 12;

export function createCameraRig(camera) {
  const state = {
    // Orbit angles. Yaw follows config.js: 0 faces -Z, positive turns clockwise.
    yaw: Math.PI,
    pitch: CAMERA.pitch,
    // Live boom length after wall clamping; read by audio and muzzle effects.
    distance: CAMERA.distance,
    // 0..1 blend into the aim pose, so raising the weapon is a move, not a jump.
    aim: 0,
    // Decaying impulse amplitude in metres, capped at 1 by shake().
    shakeAmount: 0,
    shakeClock: 0,
    // Where the lens ended up this frame.
    position: { x: 0, y: 0, z: 0 },
  };

  // Allocated once and reused: update() runs every frame, and handing the
  // garbage collector a handful of short-lived vectors each tick is the classic
  // source of a periodic frame hitch.
  const target = new THREE.Vector3();
  const eased = new THREE.Vector3();
  const lookDir = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  /** Shaken pose, before the final wall test. */
  const shaken = { x: 0, y: 0, z: 0 };

  let placed = false;

  /** Eye point the boom hangs from: her head normally, the seat while driving. */
  function eyePoint(ctx) {
    const body = ctx.player ? ctx.player.state : null;
    if (!body) return { x: 0, y: PLAYER.eyeHeight, z: 0 };

    const car = ctx.vehicle && ctx.vehicle.state;
    if (body.inVehicle && car && car.position) {
      // Seated, the eye rides the car body: foot-plus-eye-height would sink
      // through a low roof.
      return { x: car.position.x, y: car.position.y + 1.25, z: car.position.z };
    }
    return { x: body.position.x, y: body.position.y + PLAYER.eyeHeight, z: body.position.z };
  }

  /**
   * Unit look vector. The y component is -sin(pitch), so a positive pitch drops
   * the nose: pitch up raises the lens and tips the view down at her, which is
   * what the third-person boom wants.
   */
  function lookVector(out) {
    const cp = Math.cos(state.pitch);
    out.set(Math.sin(state.yaw) * cp, -Math.sin(state.pitch), -Math.cos(state.yaw) * cp);
    return out;
  }

  /** Boom pose for a given length: behind the look direction, lifted by height. */
  function boomPose(eye, distance, height) {
    lookVector(lookDir);
    target.set(
      eye.x - lookDir.x * distance,
      eye.y - lookDir.y * distance + height,
      eye.z - lookDir.z * distance
    );
    return target;
  }

  /**
   * Longest boom that stays on this side of the geometry. Marches outward from
   * the player and stops just short of the first blocked sample, so the lens
   * sits in front of a facade rather than inside it.
   */
  function freeBoom(ctx, eye, want) {
    if (!ctx || typeof ctx.blocked !== 'function') return want;
    let clear = BOOM_MIN;
    for (let i = 1; i <= WALL_SAMPLES; i++) {
      const t = (i / WALL_SAMPLES) * want;
      const x = eye.x - lookDir.x * t;
      const z = eye.z - lookDir.z * t;
      if (ctx.blocked(x, z)) break;
      clear = t;
    }
    return Math.max(BOOM_MIN, clear);
  }

  /**
   * Shorten a candidate lens position along the eye ray until it is clear.
   * Returns a shared scratch object — callers must read it before the next call.
   * Marches outward from the eye and stops at the first blocked sample; the
   * direction matters, because a far-to-near scan can land on clear space
   * *behind* a wall (a courtyard, the gap between two blocks) and hand back a
   * lens with the facade still between it and the player.
   */
  const clampedLens = { x: 0, y: 0, z: 0 };
  function pullInside(source, eye, ctx) {
    clampedLens.x = source.x;
    clampedLens.y = source.y;
    clampedLens.z = source.z;
    if (!ctx || typeof ctx.blocked !== 'function') return clampedLens;

    const dx = source.x - eye.x;
    const dy = source.y - eye.y;
    const dz = source.z - eye.z;
    const span = Math.hypot(dx, dy, dz);
    if (span < 1e-4) return clampedLens;

    let clearT = 1;
    for (let i = 1; i <= WALL_SAMPLES; i++) {
      const t = i / WALL_SAMPLES;
      if (ctx.blocked(eye.x + dx * t, eye.z + dz * t)) {
        clearT = (i - 1) / WALL_SAMPLES;
        break;
      }
    }
    if (clearT >= 1) return clampedLens;

    // Scale every axis together so the shot keeps its height and tilt instead
    // of flattening onto the eye line, which is what a per-axis clamp would do.
    clampedLens.x = eye.x + dx * clearT;
    clampedLens.y = eye.y + dy * clearT;
    clampedLens.z = eye.z + dz * clearT;
    return clampedLens;
  }

  function update(dt, ctx = {}) {
    const input = ctx.input ? ctx.input.state : null;

    // -------------------------------------------------------------- orbit angles
    if (input) {
      // lookX/lookZ are already radians (input.js applies sensitivity), so adding
      // them straight in keeps the turn rate identical at 30 and 144 fps.
      state.yaw += input.lookX || 0;
      state.pitch = clamp(state.pitch + (input.lookZ || 0), CAMERA.minPitch, CAMERA.maxPitch);
    }

    // Keep yaw in (-PI, PI] so anything comparing headings never sees it grow unbounded.
    if (state.yaw > Math.PI) state.yaw -= Math.PI * 2;
    else if (state.yaw < -Math.PI) state.yaw += Math.PI * 2;

    const aiming = !!ctx.aiming || (input ? input.aim : false);
    state.aim += ((aiming ? 1 : 0) - state.aim) * damp(AIM_RATE, dt);

    const eye = eyePoint(ctx);

    // Aiming both shortens the boom and lifts it: closer for precision, higher
    // to clear her head.
    const wantDistance = lerp(CAMERA.distance, CAMERA.aimDistance ?? CAMERA.distance, state.aim);
    const wantHeight = lerp(CAMERA.height, CAMERA.height + AIM_LIFT, state.aim);

    // Orient once here so freeBoom can march along the current forward vector.
    lookVector(lookDir);

    // ---------------------------------------------------------------- boom length
    const usable = Math.min(wantDistance, freeBoom(ctx, eye, wantDistance));
    const rate = usable < state.distance ? BOOM_IN : BOOM_OUT;
    state.distance = lerp(state.distance, usable, damp(rate, dt));
    // The boom may never overshoot the wall even while easing, so clamp after the lerp.
    state.distance = Math.min(state.distance, usable);

    boomPose(eye, state.distance, wantHeight);

    // ---------------------------------------------------------------------- spring
    // followLag is an exponential stiffness, so the damp() form makes the trail
    // frame-rate independent; a plain lerp constant would make the camera
    // stiffer at high fps.
    const stiffness = CAMERA.spring ?? CAMERA.followLag ?? 9;
    const k = damp(stiffness, dt);

    if (!placed) {
      // First frame after a spawn or teleport: start on pose instead of sliding
      // in from the origin.
      eased.copy(target);
      placed = true;
    } else {
      eased.x += (target.x - eased.x) * k;
      eased.y += (target.y - eased.y) * k;
      eased.z += (target.z - eased.z) * k;
    }

    // ------------------------------------------------------------------------ shake
    state.shakeAmount = Math.max(0, state.shakeAmount - dt * 2.6);
    state.shakeClock += dt;

    let shakeX = 0;
    let shakeY = 0;
    if (state.shakeAmount > 0.001) {
      // Two incommensurate frequencies, or the wobble reads as mechanical rather
      // than as an impact. Squaring the amplitude makes small shakes fade out
      // instead of buzzing at full depth.
      const amp = state.shakeAmount * state.shakeAmount * SHAKE_MAX;
      shakeX = Math.sin(state.shakeClock * SHAKE_HZ) * amp;
      shakeY = Math.cos(state.shakeClock * SHAKE_HZ * 0.77) * amp * 0.7;
    }

    // ------------------------------------------------------------------- place lens
    // Last line of defence: the spring eases toward the clamped pose, so while
    // the yaw sweeps it can lag behind a wall it was clear of a frame ago.
    // Re-test the pose that is actually drawn and pull it in along the eye ray
    // if needed, otherwise the lag becomes a visible clip through a facade
    // whenever the player spins next to one.
    const lens = pullInside(eased, eye, ctx);

    // Shake is applied after the clamp, then re-clamped: a violent hit must not
    // be able to jolt the lens back through the wall the boom just resolved.
    shaken.x = lens.x + shakeX;
    shaken.y = lens.y + shakeY;
    shaken.z = lens.z;
    const finalLens = pullInside(shaken, eye, ctx);

    camera.position.set(finalLens.x, finalLens.y, finalLens.z);
    state.position.x = camera.position.x;
    state.position.y = camera.position.y;
    state.position.z = camera.position.z;

    // Aim past her head rather than at it; looking at the head would frame her
    // body over the crosshair and hide whatever the player is shooting at.
    lookAt.set(eye.x + shakeX * 0.5, eye.y + 0.12 + shakeY * 0.5, eye.z);
    camera.lookAt(lookAt);

    const fov = lerp(CAMERA.fov, CAMERA.aimFov ?? CAMERA.fov, state.aim);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      // fov only reaches the GPU through the projection matrix; without this the
      // zoom never shows.
      camera.updateProjectionMatrix();
    }
  }

  /** Re-place the lens with no easing, for respawns and screenshot setups. */
  function snap(ctx = {}) {
    const input = ctx.input ? ctx.input.state : null;
    if (input) {
      state.yaw += input.lookX || 0;
      state.pitch = clamp(state.pitch + (input.lookZ || 0), CAMERA.minPitch, CAMERA.maxPitch);
    }

    const eye = eyePoint(ctx);
    const wantDistance = lerp(CAMERA.distance, CAMERA.aimDistance ?? CAMERA.distance, state.aim);
    const wantHeight = lerp(CAMERA.height, CAMERA.height + AIM_LIFT, state.aim);

    lookVector(lookDir);
    state.distance = Math.min(wantDistance, freeBoom(ctx, eye, wantDistance));

    boomPose(eye, state.distance, wantHeight);
    eased.copy(target);
    camera.position.copy(eased);
    camera.lookAt(eye.x, eye.y + 0.12, eye.z);

    state.position.x = eased.x;
    state.position.y = eased.y;
    state.position.z = eased.z;
    state.shakeAmount = 0;
    placed = true;
  }

  /** Add an impact impulse. Repeated hits accumulate up to 1, so a crash
   *  outranks a pistol shot. */
  function shake(amount) {
    state.shakeAmount = clamp(state.shakeAmount + Math.abs(amount), 0, 1);
  }

  /** Unit vector a weapon raycasts along — the same forward the boom hangs off. */
  function direction() {
    return lookVector(new THREE.Vector3()).normalize();
  }

  return { state, update, snap, shake, direction };
}
