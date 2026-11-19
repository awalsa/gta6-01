import * as THREE from 'three';
import { GRID, WORLD } from './config.js';
import { ROAD_LINES } from './city.js';
import { angleTo, clamp, createRandom, damp, pick, range, wrapAngle } from './mathutil.js';

export const SHIRTS = [
  0xd94f3d, 0x3d7ad9, 0x3da55c, 0xe8c33f, 0x8a5fd0,
  0xe07ba8, 0x2fb3a6, 0xf2ede4, 0x2b2b30, 0xc97b2d,
  0x7fb069,
];

export const TROUSERS = [
  0x2c3e50, 0x3a3a3a, 0x5b4636, 0x274472, 0x6b7c93,
  0x1f1f24, 0x4a6741, 0x7a6a53, 0x8c2f39, 0x33555a,
  0x9aa0a6,
];

export const SKINS = [
  0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac,
  0xf0c8a0, 0xd9a066, 0xa0663a, 0xe8b88a, 0x6e4423,
  0xf7d7b0,
];

/** Dark jackets, after the reference looks: black, navy, green bomber. */
export const JACKETS = [
  0x1b1b20, 0x2f4d70, 0x5a6b3f, 0x3a2f2f, 0x23282e, 0x4a3b52,
];

/** One bright accent panel per jacket: orange, teal, red, white, yellow. */
export const ACCENTS = [
  0xe86a1c, 0x1f9aa8, 0xc8102e, 0xe8e8e8, 0xe8c33f, 0x2fb3a6,
];

/** Mostly black caps, a few dark variants. */
export const CAPS = [
  0x141416, 0x1e1e24, 0x2b2b30, 0x3a2f2f, 0x1f2a3a,
];

const COUNT = 38;
const WALK_SPEED = 1.35;
const RUN_SPEED = 5.4;
const IDLE_CHANCE = 0.22;
const CROSS_CHANCE = 0.3;
const PANIC_TIME = 2.6;
const SIDEWALK = 1.7;

function makeRng(seed) {
  try {
    const fn = createRandom(seed);
    if (typeof fn === 'function') return fn;
  } catch (err) {
    // fall through to Math.random below
  }
  return Math.random;
}

function roll(rng, lo, hi) {
  try {
    const v = range(rng, lo, hi);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  } catch (err) {
    // fall through
  }
  return lo + rng() * (hi - lo);
}

function choose(rng, list) {
  try {
    const v = pick(rng, list);
    if (v !== undefined) return v;
  } catch (err) {
    // fall through
  }
  return list[Math.floor(rng() * list.length) % list.length];
}

function groundAt(handles, x, z) {
  try {
    const h = handles.groundHeight(x, z);
    if (typeof h === 'number' && Number.isFinite(h)) return h;
  } catch (err) {
    // fall through
  }
  return WORLD.groundY;
}

function blocked(handles, x, z) {
  try {
    return !!handles.insideBuilding(x, z);
  } catch (err) {
    return false;
  }
}

function freeSpot(handles, rng, cx, cz, radius) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * radius;
    const x = clamp(cx + Math.cos(a) * r, -WORLD.extent, WORLD.extent);
    const z = clamp(cz + Math.sin(a) * r, -WORLD.extent, WORLD.extent);
    if (!blocked(handles, x, z)) return { x, z };
  }
  return { x: clamp(cx, -WORLD.extent, WORLD.extent), z: clamp(cz, -WORLD.extent, WORLD.extent) };
}

function roadPoint(handles, rng, cx, cz) {
  const lines = ROAD_LINES && ROAD_LINES.length ? ROAD_LINES : [0];
  for (let attempt = 0; attempt < 20; attempt++) {
    const line = choose(rng, lines);
    const along = roll(rng, GRID.minLine, GRID.maxLine);
    const side = rng() < 0.5 ? -1 : 1;
    const off = GRID.road / 2 + SIDEWALK + roll(rng, 0, 1.1);
    let x;
    let z;
    if (rng() < 0.5) {
      x = line + side * off;
      z = along;
    } else {
      x = along;
      z = line + side * off;
    }
    if (Math.abs(x) > WORLD.extent || Math.abs(z) > WORLD.extent) continue;
    if (blocked(handles, x, z)) continue;
    if (cx !== undefined && Math.hypot(x - cx, z - cz) > GRID.span * 2.2) continue;
    return { x, z };
  }
  return freeSpot(handles, rng, cx || 0, cz || 0, GRID.span);
}

function buildFigure(rng) {
  const group = new THREE.Group();
  const pants = choose(rng, TROUSERS);
  const skin = choose(rng, SKINS);
  const hairShade = choose(rng, [0x1c1a18, 0x3b2a1a, 0x6b6b6b, 0x8a5a2b, 0x111111, 0xd8c690]);
  // A little under half the crowd is female: slimmer, a touch shorter, long
  // hair down the back. The rest read male. Most peds wear a dark jacket
  // with one bright accent panel and a black cap, after the reference looks.
  const female = rng() < 0.45;
  const jacket = choose(rng, JACKETS);
  const accent = choose(rng, ACCENTS);
  const capShade = choose(rng, CAPS);
  const hasCap = rng() < 0.65;
  const hasAccent = rng() < 0.55;

  const pantsMat = new THREE.MeshLambertMaterial({ color: pants });
  const skinMat = new THREE.MeshLambertMaterial({ color: skin });
  const hairMat = new THREE.MeshLambertMaterial({ color: hairShade });
  const jacketMat = new THREE.MeshLambertMaterial({ color: jacket });
  const accentMat = new THREE.MeshLambertMaterial({ color: accent });
  const capMat = new THREE.MeshLambertMaterial({ color: capShade });

  const height = female ? roll(rng, 1.58, 1.78) : roll(rng, 1.68, 1.92);
  const bulk = female ? roll(rng, 0.8, 1.0) : roll(rng, 0.86, 1.18);
  const scale = height / 1.78;

  const torsoW = (female ? 0.4 : 0.46) * bulk;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(torsoW, female ? 0.54 : 0.58, 0.26 * bulk), jacketMat);
  torso.position.y = 1.02;
  torso.castShadow = true;
  group.add(torso);

  // One bright accent panel on the jacket chest.
  if (hasAccent) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.46, 0.02), accentMat);
    panel.position.set(female ? 0.09 : 0.11, 1.03, 0.13 * bulk + 0.015);
    group.add(panel);
  }

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), skinMat);
  head.position.y = 1.5;
  head.castShadow = true;
  group.add(head);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
  hair.position.y = 1.53;
  group.add(hair);

  // Black cap: crown over the hair, brim forward. Women keep long hair down
  // the back under it.
  if (hasCap) {
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.11, 0.3), capMat);
    crown.position.y = 1.62;
    crown.castShadow = true;
    group.add(crown);

    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.16), capMat);
    brim.position.set(0, 1.585, 0.17);
    group.add(brim);
  }

  if (female) {
    const longHair = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.36, 0.08), hairMat);
    longHair.position.set(0, 1.32, -0.13);
    group.add(longHair);
  }

  const legW = female ? 0.13 : 0.15;
  const legGeo = new THREE.BoxGeometry(legW, 0.62, 0.17);
  const leftLeg = new THREE.Mesh(legGeo, pantsMat);
  leftLeg.geometry = legGeo.clone();
  leftLeg.geometry.translate(0, -0.31, 0);
  leftLeg.position.set(female ? -0.1 : -0.12, 0.72, 0);
  leftLeg.castShadow = true;
  group.add(leftLeg);

  const rightLeg = new THREE.Mesh(legGeo, pantsMat);
  rightLeg.geometry = legGeo.clone();
  rightLeg.geometry.translate(0, -0.31, 0);
  rightLeg.position.set(female ? 0.1 : 0.12, 0.72, 0);
  rightLeg.castShadow = true;
  group.add(rightLeg);

  const armGeo = new THREE.BoxGeometry(female ? 0.1 : 0.11, 0.52, 0.13);
  const armX = (female ? 0.27 : 0.3) * bulk;
  const leftArm = new THREE.Mesh(armGeo, jacketMat);
  leftArm.geometry = armGeo.clone();
  leftArm.geometry.translate(0, -0.26, 0);
  leftArm.position.set(-armX, 1.26, 0);
  group.add(leftArm);

  const rightArm = new THREE.Mesh(armGeo, jacketMat);
  rightArm.geometry = armGeo.clone();
  rightArm.geometry.translate(0, -0.26, 0);
  rightArm.position.set(armX, 1.26, 0);
  group.add(rightArm);

  const handGeo = new THREE.SphereGeometry(0.06, 8, 6);
  const leftHand = new THREE.Mesh(handGeo, skinMat);
  leftHand.position.set(-armX, 0.72, 0);
  group.add(leftHand);
  const rightHand = new THREE.Mesh(handGeo, skinMat);
  rightHand.position.set(armX, 0.72, 0);
  group.add(rightHand);

  group.scale.setScalar(scale);
  group.userData.limbs = { leftLeg, rightLeg, leftArm, rightArm };
  group.userData.height = height;
  return group;
}

function pickDestination(handles, rng, ped) {
  if (rng() < CROSS_CHANCE) {
    const lines = ROAD_LINES && ROAD_LINES.length ? ROAD_LINES : [0];
    const line = choose(rng, lines);
    const along = ped.z;
    const across = rng() < 0.5;
    let dest;
    if (across) {
      dest = { x: line + (ped.x > line ? -1 : 1) * (GRID.road / 2 + SIDEWALK + roll(rng, 0, 2)), z: along + roll(rng, -6, 6) };
    } else {
      dest = { x: along + roll(rng, -6, 6), z: line + (ped.z > line ? -1 : 1) * (GRID.road / 2 + SIDEWALK + roll(rng, 0, 2)) };
    }
    dest.x = clamp(dest.x, -WORLD.extent, WORLD.extent);
    dest.z = clamp(dest.z, -WORLD.extent, WORLD.extent);
    if (!blocked(handles, dest.x, dest.z)) return dest;
  }
  return roadPoint(handles, rng, ped.x, ped.z);
}

export function createPeds(scene, handles) {
  const rng = makeRng(20261119);
  const people = [];

  function spawnOne(cx, cz) {
    const spot = roadPoint(handles, rng, cx, cz);
    const mesh = buildFigure(rng);
    mesh.position.set(spot.x, groundAt(handles, spot.x, spot.z), spot.z);
    mesh.rotation.y = rng() * Math.PI * 2;
    scene.add(mesh);

    const ped = {
      mesh,
      x: spot.x,
      z: spot.z,
      heading: mesh.rotation.y,
      speed: roll(rng, WALK_SPEED * 0.7, WALK_SPEED * 1.3),
      state: 'walk',
      idleFor: 0,
      panicFor: 0,
      phase: rng() * Math.PI * 2,
      target: null,
      stride: roll(rng, 0.8, 1.25),
    };
    ped.target = pickDestination(handles, rng, ped);
    people.push(ped);
    return ped;
  }

  for (let i = 0; i < COUNT; i++) {
    spawnOne(0, 0);
  }

  function relocate(centre) {
    const cx = centre && typeof centre.x === 'number' ? centre.x : 0;
    const cz = centre && typeof centre.z === 'number' ? centre.z : 0;
    for (const ped of people) {
      const spot = roadPoint(handles, rng, cx, cz);
      ped.x = spot.x;
      ped.z = spot.z;
      ped.state = 'walk';
      ped.idleFor = 0;
      ped.panicFor = 0;
      ped.target = pickDestination(handles, rng, ped);
      ped.heading = angleTo({ x: ped.x, z: ped.z }, { x: ped.target.x, z: ped.target.z });
      ped.mesh.position.set(ped.x, groundAt(handles, ped.x, ped.z), ped.z);
      ped.mesh.rotation.y = ped.heading;
    }
  }

  function update(dt, options) {
    const step = clamp(dt || 0, 0, 0.1);
    if (step <= 0) return;
    const opts = options || {};
    const player = opts.playerPos || null;
    const shots = !!opts.gunshots;

    for (const ped of people) {
      const limbs = ped.mesh.userData.limbs;

      if (shots && ped.panicFor <= 0) {
        ped.panicFor = PANIC_TIME + roll(rng, 0, 1.6);
        ped.state = 'flee';
        if (player) {
          ped.heading = angleTo({ x: player.x, z: player.z }, { x: ped.x, z: ped.z });
        } else {
          ped.heading = rng() * Math.PI * 2;
        }
      }

      if (ped.panicFor > 0) {
        ped.panicFor -= step;
        ped.state = 'flee';
        if (ped.panicFor <= 0) {
          ped.state = 'walk';
          ped.target = pickDestination(handles, rng, ped);
        }
      }

      let moving = false;
      let pace = ped.speed;

      if (ped.state === 'flee') {
        pace = RUN_SPEED * roll(rng, 0.9, 1.1);
        moving = true;
        if (player) {
          const away = angleTo({ x: player.x, z: player.z }, { x: ped.x, z: ped.z });
          let diff = away - ped.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          ped.heading += clamp(diff, -2.4 * step, 2.4 * step);
        }
      } else if (ped.state === 'idle') {
        ped.idleFor -= step;
        if (ped.idleFor <= 0) {
          ped.state = 'walk';
          ped.target = pickDestination(handles, rng, ped);
        }
      } else {
        if (!ped.target) ped.target = pickDestination(handles, rng, ped);
        const dx = ped.target.x - ped.x;
        const dz = ped.target.z - ped.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.6) {
          if (rng() < IDLE_CHANCE) {
            ped.state = 'idle';
            ped.idleFor = roll(rng, 1.5, 6);
          } else {
            ped.target = pickDestination(handles, rng, ped);
          }
        } else {
          const want = angleTo({ x: ped.x, z: ped.z }, { x: ped.target.x, z: ped.target.z });
          let diff = want - ped.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          ped.heading += clamp(diff, -3.2 * step, 3.2 * step);
          moving = true;
        }
      }

      if (moving) {
        const nx = ped.x + Math.sin(ped.heading) * pace * step;
        const nz = ped.z + Math.cos(ped.heading) * pace * step;
        if (!blocked(handles, nx, nz) && Math.abs(nx) <= WORLD.extent && Math.abs(nz) <= WORLD.extent) {
          ped.x = nx;
          ped.z = nz;
        } else {
          ped.heading += roll(rng, 0.8, 2.2) * (rng() < 0.5 ? -1 : 1);
          ped.target = pickDestination(handles, rng, ped);
        }
        ped.phase += step * pace * 3.4 * ped.stride;
      }

      const bob = moving ? Math.abs(Math.sin(ped.phase)) * 0.05 : 0;
      const ground = groundAt(handles, ped.x, ped.z);
      ped.mesh.position.set(ped.x, ground + bob, ped.z);
      const targetRot = ped.heading;
      ped.mesh.rotation.y += wrapAngle(targetRot - ped.mesh.rotation.y) * damp(10, step);

      if (limbs) {
        const swing = moving ? Math.sin(ped.phase) * 0.62 : 0;
        const armSwing = moving ? Math.sin(ped.phase) * 0.45 : 0;
        limbs.leftLeg.rotation.x = swing;
        limbs.rightLeg.rotation.x = -swing;
        limbs.leftArm.rotation.x = -armSwing;
        limbs.rightArm.rotation.x = armSwing;
      }
    }
  }

  return { people, relocate, update };
}
