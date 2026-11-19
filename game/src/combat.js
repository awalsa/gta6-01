// Weapons, tracers and bullet holes.
//
// Everything here is state plus a little geometry: the frame loop asks `fire()`
// for a result and decides what that result costs a ped or the heat meter.
// Keeping damage out of this module means one shooting path can serve the
// player, the police and the scripted screenshots alike.

import * as THREE from 'three';
import { WEAPONS, PLAYER } from './config.js';
import { TAU } from './mathutil.js';

/**
 * Reload times, in seconds, per weapon. Not in config because they are feel,
 * not balance: a shotgun takes visibly longer than a pistol so the player reads
 * the commitment from the screen.
 */
const RELOAD_SECONDS = { fists: 0, pistol: 1.35, smg: 1.75, shotgun: 2.5 };

/** The muzzle flash lives for three frames at 60 Hz — a spark, not a lamp. */
const FLASH_TIME = 0.05;

/** Tracers fade in ~0.08 s: a streak the eye catches, not a beam hanging in the air. */
const TRACER_LIFE = 0.08;
const TRACER_POOL = 40;

/** Bullet holes linger for a second so a firefight leaves a readable trail, then recycle. */
const HOLE_LIFE = 1.1;
const HOLE_POOL = 40;

/** Smallest step that still catches a 0.5 m wide target without walking a whole
 *  metre at a time. */
const MARCH_STEP = 0.35;

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _point = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _perpA = new THREE.Vector3();
const _perpB = new THREE.Vector3();

/** Anything with a hand, a hitbox or a spawn point can be the origin of a shot. */
function originOf(source) {
  if (!source) return null;
  if (source.state && source.state.position) return source.state.position;
  return source.position || source.pos || null;
}

/** Peds carry x/z on the object itself and y on the group; cars carry a position vector. */
function targetPoint(target) {
  if (!target) return null;
  if (target.position) return target.position;
  if (target.pos) return target.pos;
  if (typeof target.x === 'number') return target;
  return null;
}

/**
 * Tilt `dir` by a random angle inside a cone of half-angle `spread`. Drawn with
 * sqrt so the samples land evenly over the cone's area instead of bunching up
 * on the axis.
 */
function coneSpread(dir, spread) {
  // Any vector not parallel to the shot works as a seed for the perpendicular frame.
  _perpA.copy(Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).cross(dir).normalize();
  _perpB.copy(dir).cross(_perpA).normalize();

  const angle = Math.random() * TAU;
  const radius = spread * Math.sqrt(Math.random());
  dir.addScaledVector(_perpA, Math.cos(angle) * radius);
  dir.addScaledVector(_perpB, Math.sin(angle) * radius);
  dir.normalize();
  return dir;
}

export function createCombat(scene, player, handles) {
  const root = new THREE.Group();
  root.name = 'combat';
  scene.add(root);

  // ------------------------------------------------------------------ scene footprint
  // Tracers are additive so they glow over the dusk sky without a light of their own.
  const tracerGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i++) {
    // Each tracer owns its material: opacity is the fade, and a shared one would
    // fade every tracer on screen at once.
    const material = new THREE.MeshBasicMaterial({
      color: 0xffe4a6,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(tracerGeo, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let tracerNext = 0;

  // Impact marks lie flat against the surface; a tiny normal offset beats
  // polygonOffset here because the quad also has to sit above kerbs and window
  // ledges that are not coplanar.
  const holeGeo = new THREE.PlaneGeometry(0.17, 0.17);
  const impacts = [];
  for (let i = 0; i < HOLE_POOL; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: 0x14100c,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(holeGeo, material);
    mesh.visible = false;
    root.add(mesh);
    impacts.push({ mesh, life: 0 });
  }
  let holeNext = 0;

  // -------------------------------------------------------------------------- state
  const magazine = {};
  const reserve = {};
  for (const key of Object.keys(WEAPONS)) {
    const spec = WEAPONS[key];
    magazine[key] = Number.isFinite(spec.magazine) ? spec.magazine : Infinity;
    reserve[key] = Number.isFinite(spec.ammo) ? spec.ammo : Infinity;
  }

  const startWeapon =
    player && player.state && WEAPONS[player.state.weapon] ? player.state.weapon : 'pistol';

  const state = {
    weapon: startWeapon,
    magazine,
    reserve,
    /** Seconds left before the trigger works again. */
    cooldown: 0,
    reloading: false,
    reloadTimer: 0,
    reloadDuration: 0,
    /** Seconds of muzzle flash remaining; the rig reads this to show the spark. */
    muzzleFlash: 0,
    muzzlePosition: new THREE.Vector3(),
    /** Last shot's outcome, handy for a HUD that reports what was hit. */
    lastHit: null,
    shotsFired: 0,
  };

  /** Weapons that carry ammunition, as opposed to the fists. */
  function hasAmmo(spec) {
    return Number.isFinite(spec.magazine) || Number.isFinite(spec.ammo);
  }

  function specNow() {
    return WEAPONS[state.weapon] || WEAPONS.fists;
  }

  function muzzlePoint() {
    const origin = originOf(player);
    const yaw = (player && player.state && player.state.yaw) || 0;
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);

    if (!origin) return new THREE.Vector3(0, PLAYER.eyeHeight, 0);

    // Right-hand offset so the tracer does not start inside Dani's shoulders,
    // and a little forward so it never appears to come out of the back of her head.
    return new THREE.Vector3(
      origin.x + fx * 0.5 + Math.cos(yaw) * 0.16,
      origin.y + PLAYER.eyeHeight - 0.1,
      origin.z + fz * 0.5 + Math.sin(yaw) * 0.16
    );
  }

  // ------------------------------------------------------------------------ hitscan
  function inBuilding(x, z) {
    if (handles && typeof handles.insideBuilding === 'function') {
      return handles.insideBuilding(x, z, 0) === true;
    }
    return false;
  }

  function obstacleHit(x, z, y) {
    const list = handles && handles.obstacles;
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const box = list[i];
      if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) {
        // Footprints from props carry no minY: they stand on the ground, so 0 is the honest base.
        const base = box.minY ?? 0;
        if (y >= base && y <= base + (box.height ?? 20)) return box;
      }
    }
    return null;
  }

  /**
   * Normal of a wall, found by probing the collision set a little either side of
   * the hit. Cheap, and it works for any facade shape the city generator
   * produced: if the point 0.4 m to the east is solid and the point to the west
   * is not, this is a west-facing wall.
   */
  function wallNormal(x, z, fallback) {
    const e = 0.4;
    const nx = (inBuilding(x + e, z) ? -1 : 0) + (inBuilding(x - e, z) ? 1 : 0);
    const nz = (inBuilding(x, z + e) ? -1 : 0) + (inBuilding(x, z - e) ? 1 : 0);
    if (nx === 0 && nz === 0) return fallback;
    return new THREE.Vector3(nx, 0, nz).normalize();
  }

  /**
   * Walk the ray in MARCH_STEP increments. Marching rather than solving
   * intersections keeps one code path for axis-aligned buildings, rectangular
   * obstacles and capsule-ish people, and at these ranges the cost is a few
   * hundred cheap comparisons per shot.
   */
  function hitscan(origin, direction, maxRange = 40, spread = 0, targets = []) {
    const dir = new THREE.Vector3(direction.x, direction.y, direction.z);
    if (dir.lengthSq() < 1e-8) {
      return { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), target: null, distance: 0 };
    }
    dir.normalize();
    if (spread > 0) coneSpread(dir, spread);

    // Broad phase: only the people and cars inside the weapon's reach can be struck.
    const near = [];
    const reach = maxRange + 2;
    const reachSq = reach * reach;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (!target || target.alive === false || target.dead === true) continue;
      const p = targetPoint(target);
      if (!p) continue;
      const dx = p.x - origin.x;
      const dz = p.z - origin.z;
      if (dx * dx + dz * dz > reachSq) continue;
      near.push({
        target,
        x: p.x,
        y: p.y || 0,
        z: p.z,
        radius: target.radius ?? target.hitRadius ?? 0.5,
        height: target.height ?? 1.8,
      });
    }

    _prev.set(origin.x, origin.y, origin.z);

    for (let travelled = MARCH_STEP; travelled <= maxRange; travelled += MARCH_STEP) {
      _point.copy(dir).multiplyScalar(travelled).add(origin);

      // People first: a body in front of a wall must win, or every shot at a ped
      // standing near a facade would be absorbed by the facade behind them.
      for (let i = 0; i < near.length; i++) {
        const n = near[i];
        const dx = _point.x - n.x;
        const dz = _point.z - n.z;
        if (dx * dx + dz * dz > n.radius * n.radius) continue;
        if (_point.y < n.y - 0.15 || _point.y > n.y + n.height) continue;
        return {
          hit: true,
          point: _point.clone(),
          normal: dir.clone().negate(),
          target: n.target,
          distance: travelled,
          surface: 'body',
        };
      }

      if (inBuilding(_point.x, _point.z) || obstacleHit(_point.x, _point.z, _point.y)) {
        _normal.copy(dir).negate();
        if (inBuilding(_point.x, _point.z)) _normal.copy(wallNormal(_point.x, _point.z, _normal));
        // Back off one sample so the hole sits on the outside face, not a step inside it.
        return {
          hit: true,
          point: _prev.clone(),
          normal: _normal.clone(),
          target: null,
          distance: travelled,
          surface: 'world',
        };
      }

      _prev.copy(_point);
    }

    return {
      hit: false,
      point: origin.clone().addScaledVector(dir, maxRange),
      normal: dir.clone().negate(),
      target: null,
      distance: maxRange,
      surface: null,
    };
  }

  // ------------------------------------------------------------------- tracer / decal
  function spawnTracer(from, to) {
    const tracer = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % TRACER_POOL;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (length < 0.05) {
      tracer.life = 0;
      tracer.mesh.visible = false;
      return;
    }

    tracer.mesh.position.set(from.x + dx * 0.5, from.y + dy * 0.5, from.z + dz * 0.5);
    tracer.mesh.lookAt(to.x, to.y, to.z);
    tracer.mesh.scale.set(1, 1, length);
    tracer.mesh.material.opacity = 0.85;
    tracer.mesh.visible = true;
    tracer.life = TRACER_LIFE;
  }

  function spawnImpact(hit) {
    if (!hit || !hit.hit) return;
    const impact = impacts[holeNext];
    holeNext = (holeNext + 1) % HOLE_POOL;

    const normal = hit.normal || new THREE.Vector3(0, 1, 0);
    // 2 cm proud of the surface: enough to clear depth precision at any camera
    // distance, small enough that the hole still looks painted on.
    impact.mesh.position.set(
      hit.point.x + normal.x * 0.02,
      hit.point.y + normal.y * 0.02,
      hit.point.z + normal.z * 0.02
    );
    impact.mesh.lookAt(
      impact.mesh.position.x + normal.x,
      impact.mesh.position.y + normal.y,
      impact.mesh.position.z + normal.z
    );
    // A hole on a wall is round to the eye; random roll stops a row of them looking stamped.
    impact.mesh.rotateZ(Math.random() * TAU);
    impact.mesh.material.opacity = 0.92;
    impact.mesh.visible = true;
    impact.life = HOLE_LIFE;
  }

  // ------------------------------------------------------------------------- firing
  function fire(ctx = {}) {
    const spec = specNow();

    if (state.reloading) return { fired: false, reason: 'reloading', weapon: state.weapon };
    if (state.cooldown > 0) return { fired: false, reason: 'cooldown', weapon: state.weapon };
    if (hasAmmo(spec) && state.magazine[state.weapon] <= 0) {
      return { fired: false, reason: 'empty', weapon: state.weapon };
    }

    if (hasAmmo(spec)) state.magazine[state.weapon] -= 1;
    state.cooldown = spec.cooldown;
    state.shotsFired += 1;

    const origin = ctx.origin
      ? new THREE.Vector3(ctx.origin.x, ctx.origin.y, ctx.origin.z)
      : muzzlePoint();

    let direction;
    if (ctx.direction) {
      direction = new THREE.Vector3(ctx.direction.x, ctx.direction.y, ctx.direction.z);
    } else {
      const yaw = (player && player.state && player.state.yaw) || 0;
      const pitch = ctx.pitch ?? 0;
      direction = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch)
      );
    }
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1);
    direction.normalize();

    state.muzzlePosition.copy(origin);
    state.muzzleFlash = FLASH_TIME;

    const targets = ctx.targets || [];
    const pellets = spec.pellets || 1;
    const hits = [];
    // `nearest` is reported so the caller can place an impact; `nearestBody` is
    // what may take damage, since a wall in front of a body must not be misread
    // as a miss on the body.
    let nearest = null;
    let nearestBody = null;

    for (let i = 0; i < pellets; i++) {
      const hit = hitscan(origin, direction, spec.range, spec.spread || 0, targets);
      hits.push(hit);
      if (hit.hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
      if (hit.hit && hit.target && (!nearestBody || hit.distance < nearestBody.distance)) nearestBody = hit;
      spawnTracer(origin, hit.point);
      if (hit.hit) spawnImpact(hit);
    }

    const result = {
      fired: true,
      weapon: state.weapon,
      damage: spec.damage,
      pellets,
      hits,
      hit: nearest,
      /** The nearest struck body, or null when the shot only found scenery. */
      bodyHit: nearestBody,
      // Point blank with a shotgun is several pellets on one body; the caller can scale heat by it.
      bodiesHit: hits.filter((h) => h.hit && h.target).length,
      magazine: state.magazine[state.weapon],
      reserve: state.reserve[state.weapon],
    };

    state.lastHit = nearest;
    return result;
  }

  // ------------------------------------------------------------------------ reloading
  function reload() {
    const spec = specNow();
    const key = state.weapon;

    if (!hasAmmo(spec)) return false;
    if (state.reloading) return false;
    if (state.magazine[key] >= spec.magazine) return false;
    if (state.reserve[key] <= 0) return false;

    state.reloading = true;
    state.reloadDuration = RELOAD_SECONDS[key] ?? 1.6;
    state.reloadTimer = state.reloadDuration;
    return true;
  }

  function finishReload() {
    const spec = specNow();
    const key = state.weapon;
    state.reloading = false;
    state.reloadTimer = 0;

    if (!hasAmmo(spec)) return;
    const room = spec.magazine - state.magazine[key];
    // A partial box is fine: leftover rounds are the reason the reload takes the same time either way.
    const moved = Math.min(room, state.reserve[key]);
    state.magazine[key] += moved;
    if (Number.isFinite(state.reserve[key])) state.reserve[key] -= moved;
  }

  function selectWeapon(key) {
    if (!WEAPONS[key] || key === state.weapon) return false;
    // Swapping cancels a reload: the weapon is no longer in hand, so the rounds stay in the pocket.
    if (state.reloading) {
      state.reloading = false;
      state.reloadTimer = 0;
    }
    state.weapon = key;
    if (player && player.state) player.state.weapon = key;
    return true;
  }

  // --------------------------------------------------------------------------- update
  function update(dt) {
    if (!(dt > 0)) return;

    if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);
    if (state.muzzleFlash > 0) state.muzzleFlash = Math.max(0, state.muzzleFlash - dt);

    if (state.reloading) {
      state.reloadTimer -= dt;
      if (state.reloadTimer <= 0) finishReload();
    }

    for (let i = 0; i < tracers.length; i++) {
      const tracer = tracers[i];
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      if (tracer.life <= 0) {
        tracer.mesh.visible = false;
        tracer.mesh.material.opacity = 0;
      } else {
        tracer.mesh.material.opacity = 0.85 * (tracer.life / TRACER_LIFE);
      }
    }

    for (let i = 0; i < impacts.length; i++) {
      const impact = impacts[i];
      if (impact.life <= 0) continue;
      impact.life -= dt;
      if (impact.life <= 0) {
        impact.mesh.visible = false;
        impact.mesh.material.opacity = 0;
      } else {
        // Holes fade rather than vanish: a hard cut pops against a wall the eye is watching.
        impact.mesh.material.opacity = 0.92 * Math.min(1, impact.life / (HOLE_LIFE * 0.5));
      }
    }
  }

  /** Rounds currently in the magazine of the weapon in hand, for the HUD. */
  function ammo() {
    const key = state.weapon;
    return { magazine: state.magazine[key], reserve: state.reserve[key], reloading: state.reloading };
  }

  return { state, update, fire, reload, selectWeapon, hitscan, tracers, ammo, impacts };
}
