import * as THREE from 'three';
import { WEAPONS, PLAYER } from './config.js';
import { TAU } from './mathutil.js';

// Hitscan combat: one shot is a ray from the shooter's eye, the closest
// thing it meets wins, and a short-lived tracer shows where it went.

const EYE_HEIGHT = (PLAYER && (PLAYER.eyeHeight || PLAYER.eye || PLAYER.height)) || 1.62;
const TRACER_LIFE = 0.07;
const FLASH_LIFE = 0.05;
const SHOTGUN_PELLETS = 6;
const BUILDING_STEP = 0.4;

function eyePosition(player) {
  const raw = (player && player.state && player.state.position) || (player && player.position) || { x: 0, y: 0, z: 0 };
  return new THREE.Vector3(raw.x, raw.y + EYE_HEIGHT, raw.z);
}

function cloneDirection(direction) {
  if (!direction) return new THREE.Vector3(0, 0, -1);
  if (direction.isVector3) return direction.clone().normalize();
  return new THREE.Vector3(direction.x || 0, direction.y || 0, direction.z || -1).normalize();
}

function spreadDirection(base, spread) {
  if (!spread || spread <= 0) return base.clone();
  const angle = Math.random() * TAU;
  const radius = spread * Math.sqrt(Math.random());
  const up = Math.abs(base.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(base, up).normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, base).normalize();
  const offset = new THREE.Vector3()
    .addScaledVector(right, Math.cos(angle) * radius)
    .addScaledVector(trueUp, Math.sin(angle) * radius);
  return base.clone().add(offset).normalize();
}

function meshOf(entry) {
  if (!entry) return null;
  if (entry.isObject3D) return entry;
  if (entry.mesh && entry.mesh.isObject3D) return entry.mesh;
  return null;
}

function obstacleMeshes(obstacles) {
  const out = [];
  for (const entry of obstacles || []) {
    const mesh = meshOf(entry);
    if (mesh) out.push(mesh);
  }
  return out;
}

export function createCombat(scene, player, handles) {
  const tools = handles || {};
  const groundHeight = typeof tools.groundHeight === 'function' ? tools.groundHeight : () => 0;
  const insideBuilding = typeof tools.insideBuilding === 'function' ? tools.insideBuilding : () => false;
  const onRoad = typeof tools.onRoad === 'function' ? tools.onRoad : () => false;
  const obstacles = Array.isArray(tools.obstacles) ? tools.obstacles : [];

  const state = { weapon: 'fists' };

  // Per-weapon ammunition. Fists carry no ammo at all, so they get no entry.
  // Magazine starts full; reserve starts at the weapon's ammo stock.
  const stores = {};
  for (const name of Object.keys(WEAPONS || {})) {
    const def = WEAPONS[name];
    if (!def || name === 'fists') continue;
    const capacity = def.magazine || 0;
    stores[name] = {
      magazine: capacity,
      reserve: Math.max(0, def.ammo || 0),
    };
  }

  let cooldownLeft = 0;
  const effects = [];

  function currentDef() {
    return (WEAPONS && WEAPONS[state.weapon]) || {};
  }

  function ammo(weaponName) {
    const store = stores[weaponName];
    if (!store) return null;
    return { magazine: store.magazine, reserve: store.reserve };
  }

  function selectWeapon(weaponName) {
    if (!WEAPONS || !WEAPONS[weaponName]) return false;
    state.weapon = weaponName;
    if (player && player.state) player.state.weapon = weaponName;
    return true;
  }

  function reload() {
    const def = currentDef();
    const store = stores[state.weapon];
    if (!store || !def.magazine) return false;
    const needed = def.magazine - store.magazine;
    if (needed <= 0 || store.reserve <= 0) return false;
    const moved = Math.min(needed, store.reserve);
    store.magazine += moved;
    store.reserve -= moved;
    return true;
  }

  function spawnTracer(from, to) {
    if (!scene || !scene.add) return;
    const geometry = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const material = new THREE.LineBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 0.9,
    });
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    effects.push({ object: line, life: TRACER_LIFE, maxLife: TRACER_LIFE, kind: 'tracer' });
  }

  function spawnFlash(at, direction) {
    if (!scene || !scene.add) return;
    const geometry = new THREE.SphereGeometry(0.09, 8, 6);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffc94d,
      transparent: true,
      opacity: 0.95,
    });
    const flash = new THREE.Mesh(geometry, material);
    flash.position.copy(at).addScaledVector(direction, 0.45);
    flash.scale.set(1, 1, 1.6);
    scene.add(flash);
    effects.push({ object: flash, life: FLASH_LIFE, maxLife: FLASH_LIFE, kind: 'flash' });
  }

  // Walk the ray in short steps; the first point reported inside a building
  // is where the shot is stopped by a wall.
  function buildingBlock(origin, direction, range) {
    const probe = new THREE.Vector3();
    for (let travelled = BUILDING_STEP; travelled < range; travelled += BUILDING_STEP) {
      probe.copy(origin).addScaledVector(direction, travelled);
      if (insideBuilding(probe)) return travelled;
    }
    return null;
  }

  // Where the ray would meet the terrain if nothing else stops it first.
  function groundBlock(origin, direction, range) {
    if (direction.y >= -0.001) return null;
    const ground = groundHeight(origin.x, origin.z);
    const drop = origin.y - ground;
    if (drop <= 0) return null;
    const travelled = drop / -direction.y;
    if (travelled > range) return null;
    const point = origin.clone().addScaledVector(direction, travelled);
    // A road surface counts the same as any other ground for a bullet.
    void onRoad(point);
    return travelled;
  }

  function fireOnePellet(origin, direction, targets, range) {
    const caster = new THREE.Raycaster(origin, direction, 0, range);
    const hits = [];

    for (const target of targets || []) {
      const mesh = target && target.mesh;
      if (!mesh) continue;
      const found = caster.intersectObject(mesh, true);
      for (const hit of found) hits.push({ distance: hit.distance, point: hit.point, pedestrian: target });
    }

    for (const mesh of obstacleMeshes(obstacles)) {
      const found = caster.intersectObject(mesh, true);
      for (const hit of found) hits.push({ distance: hit.distance, point: hit.point, pedestrian: null });
    }

    hits.sort((a, b) => a.distance - b.distance);

    const wallAt = buildingBlock(origin, direction, range);
    if (wallAt !== null && (!hits.length || wallAt < hits[0].distance)) {
      const point = origin.clone().addScaledVector(direction, wallAt);
      return { hit: true, bodyHit: false, point };
    }

    if (hits.length) {
      const first = hits[0];
      return { hit: true, bodyHit: Boolean(first.pedestrian), point: first.point.clone() };
    }

    const groundAt = groundBlock(origin, direction, range);
    if (groundAt !== null) {
      const point = origin.clone().addScaledVector(direction, groundAt);
      return { hit: true, bodyHit: false, point };
    }

    return { hit: false, bodyHit: false, point: origin.clone().addScaledVector(direction, range) };
  }

  function fire(input) {
    const def = currentDef();
    const weaponName = state.weapon;
    const fail = (reason) => ({ fired: false, reason, weapon: weaponName, bodyHit: false, hit: false });

    if (cooldownLeft > 0) return fail('cooldown');

    const store = stores[weaponName];
    if (store && store.magazine <= 0) return fail('empty');

    const direction = cloneDirection(input && input.direction);
    const targets = (input && Array.isArray(input.targets)) ? input.targets : [];
    const origin = eyePosition(player);
    const range = def.range || 50;
    const pellets = weaponName === 'shotgun' ? SHOTGUN_PELLETS : 1;

    let anyHit = false;
    let anyBodyHit = false;
    let farthest = origin.clone();

    for (let i = 0; i < pellets; i++) {
      const pelletDir = spreadDirection(direction, def.spread || 0);
      const result = fireOnePellet(origin, pelletDir, targets, range);
      if (result.hit) anyHit = true;
      if (result.bodyHit) anyBodyHit = true;
      if (result.point.distanceTo(origin) > farthest.distanceTo(origin)) farthest = result.point;
      spawnTracer(origin, result.point);
    }

    if (store) store.magazine -= 1;
    cooldownLeft = def.cooldown || 0;
    spawnFlash(origin, direction);

    return { fired: true, reason: 'fired', weapon: weaponName, bodyHit: anyBodyHit, hit: anyHit };
  }

  function update(dt) {
    const step = typeof dt === 'number' && dt > 0 ? dt : 0;
    if (cooldownLeft > 0) cooldownLeft = Math.max(0, cooldownLeft - step);
    for (let i = effects.length - 1; i >= 0; i--) {
      const effect = effects[i];
      effect.life -= step;
      const material = effect.object && effect.object.material;
      if (material && material.transparent) {
        material.opacity = Math.max(0, (effect.life / effect.maxLife)) * 0.9;
      }
      if (effect.life <= 0) {
        if (scene && scene.remove) scene.remove(effect.object);
        if (effect.object) {
          if (effect.object.geometry) effect.object.geometry.dispose();
          if (effect.object.material) effect.object.material.dispose();
        }
        effects.splice(i, 1);
      }
    }
  }

  return { state, ammo, selectWeapon, reload, fire, update };
}
