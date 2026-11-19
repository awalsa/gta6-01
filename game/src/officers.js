// On-foot police officers for Puerto Fuego.
//
// Cruisers were the whole police force until now: the wanted system only
// ever answered with cars. This module adds the officers who step out of
// them — male and female, in navy uniform with a dark vest, peaked cap,
// shoulder radio and duty belt, built from the same boxes-and-pivots kit
// as the civilian crowd so a walk cycle swings from the joints.
//
// The module only ADDS officers to the wanted system: it reads the star
// band from police.js, never changes heat, aggression or the cruiser fleet.
// Officers spawn at two stars and above, chase Dani on foot, hold a ring
// around her when close, and walk off the roster when the heat drops.
// They are not combat targets and never shoot — the cruisers keep the guns.
//
// Branding: the only word anywhere on an officer is POLICE, drawn on a
// canvas with a guarded fallback to a plain vest, the same pattern as the
// cruiser door decals. No department initials, no other branding.

import * as THREE from 'three';
import { WORLD } from './config.js';
import { angleTo, clamp, createRandom, wrapAngle, TAU } from './mathutil.js';

// Navy shirt, near-black vest and belt, gold cap badge, skin tones.
const NAVY = 0x1f2a44;
const NAVY_DARK = 0x182238;
const VEST = 0x16181c;
const VEST_DARK = 0x101114;
const BELT = 0x0e0e10;
const CAP_NAVY = 0x1a2338;
const GOLD = 0xd8a83c;
const LENS = 0x0d1b2e;
const RADIO = 0x141416;
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xd9a066];
const HAIR = [0x1c1a18, 0x111111, 0x3b2a1a, 0x6b6b6b];
const TROUSERS = 0x1c2333;

// How many officers answer each star band. None below two stars: a
// one-star tail is cruisers only, the way the game has always played it.
const OFFICERS_PER_STAR = [0, 0, 1, 2, 3, 4];
const CHASE_WALK = 3.4;
const CHASE_RUN = 6.4;
const HOLD_RING = 5.5;
const SPAWN_MIN = 10;
const SPAWN_MAX = 16;
const CRUISER_SIDE = 2.4; // an officer steps out beside the car, not through it

function makeRng(seed) {
  try {
    const fn = createRandom(seed);
    if (typeof fn === 'function') return fn;
  } catch {
    // fall through to Math.random below
  }
  return Math.random;
}

function choose(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

/**
 * "POLICE" chest tab, drawn once on a 2D canvas and used as a texture.
 * Built lazily and guarded: if the canvas or texture fails for any reason
 * this returns null and the officer simply keeps a clean vest.
 * The word is POLICE only — no department initials, no other branding.
 */
let POLICE_TAB = undefined;
function policeTabMaterial() {
  if (POLICE_TAB !== undefined) return POLICE_TAB;
  POLICE_TAB = null;
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f2ede4';
    ctx.font = 'bold 44px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('POLICE', canvas.width / 2, canvas.height / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    POLICE_TAB = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
  } catch {
    POLICE_TAB = null;
  }
  return POLICE_TAB;
}

/**
 * Build one officer figure. `female` picks the polwan variant: slimmer,
 * a touch shorter, dark ponytail down the back, tactical vest with the
 * big dual-lens body camera on the chest. The male variant wears
 * aviator-style dark glasses and a chest badge instead of the camera.
 * Limbs hang off pivots at the joints, so a walk cycle swings from the
 * shoulder and hip; the pivots are reachable on userData.limbs.
 */
export function buildOfficerFigure(female, rng) {
  const random = rng || Math.random;
  const group = new THREE.Group();
  group.name = female ? 'officer-female' : 'officer-male';

  const skin = choose(random, SKINS);
  const hairShade = choose(random, HAIR);
  const bulk = female ? 0.88 : 1.05;

  const navyMat = new THREE.MeshLambertMaterial({ color: NAVY });
  const navyDarkMat = new THREE.MeshLambertMaterial({ color: NAVY_DARK });
  const vestMat = new THREE.MeshLambertMaterial({ color: VEST });
  const vestDarkMat = new THREE.MeshLambertMaterial({ color: VEST_DARK });
  const beltMat = new THREE.MeshLambertMaterial({ color: BELT });
  const skinMat = new THREE.MeshLambertMaterial({ color: skin });
  const hairMat = new THREE.MeshLambertMaterial({ color: hairShade });
  const capMat = new THREE.MeshLambertMaterial({ color: CAP_NAVY });
  const goldMat = new THREE.MeshLambertMaterial({ color: GOLD });
  const lensMat = new THREE.MeshLambertMaterial({ color: LENS });
  const radioMat = new THREE.MeshLambertMaterial({ color: RADIO });

  // --- torso: navy shirt under a dark tactical vest -----------------------
  const torsoW = (female ? 0.4 : 0.46) * bulk;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(torsoW, 0.58, 0.26 * bulk), navyMat);
  torso.position.y = 1.02;
  torso.castShadow = true;
  group.add(torso);

  // The vest is a hair proud of the shirt on every face, so no two faces
  // are coplanar and the kit reads as a layer, not a paint job.
  const vest = new THREE.Mesh(new THREE.BoxGeometry(torsoW + 0.04, 0.52, 0.3 * bulk), vestMat);
  vest.position.y = 1.03;
  vest.castShadow = true;
  group.add(vest);

  // Vest pouches: two dark slabs low on the chest, one each side.
  for (const side of [-1, 1]) {
    const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.03), vestDarkMat);
    pouch.position.set(side * 0.13, 0.9, 0.16 * bulk + 0.005);
    group.add(pouch);
  }

  // "POLICE" tab across the upper chest. If the canvas texture fails,
  // the vest simply stays clean — the officer still reads as police
  // from the cap, vest and belt.
  const tab = policeTabMaterial();
  if (tab) {
    const text = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.075), tab);
    text.position.set(0, 1.27, 0.16 * bulk + 0.01);
    group.add(text);
  }

  // Duty belt at the waist, with a silver buckle and a holster on the
  // right hip. The belt sits above the leg pivots, so it never swings.
  const belt = new THREE.Mesh(new THREE.BoxGeometry(torsoW + 0.06, 0.07, 0.3 * bulk), beltMat);
  belt.position.y = 0.76;
  group.add(belt);

  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.02), goldMat);
  buckle.position.set(0, 0.76, 0.16 * bulk + 0.005);
  group.add(buckle);

  const holster = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.2, 0.13), beltMat);
  holster.position.set(torsoW * 0.5 + 0.02, 0.66, 0.02);
  group.add(holster);

  // Shoulder radio on the left shoulder, with a thin antenna on top.
  const radio = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.06), radioMat);
  radio.position.set(-torsoW * 0.5 - 0.02, 1.3, 0.02);
  group.add(radio);

  const antenna = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.13, 0.015), radioMat);
  antenna.position.set(-torsoW * 0.5 - 0.02, 1.42, 0.02);
  group.add(antenna);

  // --- head ----------------------------------------------------------------
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), skinMat);
  head.position.y = 1.5;
  head.castShadow = true;
  group.add(head);

  // Peaked cap: crown proud of the skull, brim forward, gold badge on
  // the front — the silhouette detail that survives being eight pixels
  // tall in a chase camera.
  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.3), capMat);
  crown.position.y = 1.62;
  crown.castShadow = true;
  group.add(crown);

  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.15), capMat);
  brim.position.set(0, 1.585, 0.17);
  group.add(brim);

  const capBadge = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.02), goldMat);
  capBadge.position.set(0, 1.63, 0.16);
  group.add(capBadge);

  if (female) {
    // Dark ponytail down the back of the head, under the cap.
    const ponytail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.36, 0.07), hairMat);
    ponytail.position.set(0, 1.3, -0.14);
    group.add(ponytail);

    // Big dual-lens body camera on the vest chest: a dark box with two
    // glassy lenses, one high-left and one low-right, like the reference.
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.11, 0.05), radioMat);
    cam.position.set(0, 1.14, 0.17 * bulk + 0.01);
    group.add(cam);

    const lensA = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.012), lensMat);
    lensA.position.set(-0.028, 1.165, 0.2 * bulk + 0.012);
    group.add(lensA);

    const lensB = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.012), lensMat);
    lensB.position.set(0.028, 1.115, 0.2 * bulk + 0.012);
    group.add(lensB);
  } else {
    // Aviator-style dark glasses across the face, and a small gold chest
    // badge on the vest's left side.
    const glasses = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.02), radioMat);
    glasses.position.set(0, 1.52, 0.145);
    group.add(glasses);

    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.02), goldMat);
    badge.position.set(-0.13, 1.27, 0.16 * bulk + 0.01);
    group.add(badge);
  }

  // --- limbs, pivoted at the joints ---------------------------------------
  const legW = female ? 0.14 : 0.15;
  const legGeo = new THREE.BoxGeometry(legW, 0.62, 0.17);
  const leftLeg = new THREE.Mesh(legGeo, navyDarkMat);
  leftLeg.geometry = legGeo.clone();
  leftLeg.geometry.translate(0, -0.31, 0);
  leftLeg.position.set(female ? -0.11 : -0.12, 0.72, 0);
  leftLeg.castShadow = true;
  group.add(leftLeg);

  const rightLeg = new THREE.Mesh(legGeo, navyDarkMat);
  rightLeg.geometry = legGeo.clone();
  rightLeg.geometry.translate(0, -0.31, 0);
  rightLeg.position.set(female ? 0.11 : 0.12, 0.72, 0);
  rightLeg.castShadow = true;
  group.add(rightLeg);

  const armGeo = new THREE.BoxGeometry(female ? 0.1 : 0.11, 0.52, 0.13);
  const armX = (female ? 0.27 : 0.3) * bulk;
  const leftArm = new THREE.Mesh(armGeo, navyMat);
  leftArm.geometry = armGeo.clone();
  leftArm.geometry.translate(0, -0.26, 0);
  leftArm.position.set(-armX, 1.26, 0);
  group.add(leftArm);

  const rightArm = new THREE.Mesh(armGeo, navyMat);
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

  const height = female ? 1.68 : 1.82;
  group.scale.setScalar(height / 1.78);
  group.userData.limbs = { leftLeg, rightLeg, leftArm, rightArm };
  group.userData.height = height;
  group.userData.female = female;
  return group;
}

/**
 * How many officers a star band fields. Kept on the module so the
 * stager and the live roster agree without importing config.
 */
export function officersForStars(stars) {
  const n = Number.isFinite(stars) ? Math.floor(stars) : 0;
  return OFFICERS_PER_STAR[clamp(n, 0, OFFICERS_PER_STAR.length - 1)] || 0;
}

export function createOfficers(scene, handles, police, vehicles) {
  const rng = makeRng(0x6f666963);
  const roster = [];
  let spawnCount = 0;

  function groundAt(x, z) {
    try {
      const h = handles.groundHeight(x, z);
      if (typeof h === 'number' && Number.isFinite(h)) return h;
    } catch {
      // fall through
    }
    return WORLD.groundY;
  }

  function blocked(x, z) {
    try {
      return !!handles.insideBuilding(x, z);
    } catch {
      return false;
    }
  }

  function starCount() {
    try {
      if (police && typeof police.starCount === 'function') return police.starCount();
      if (police && police.state && Number.isFinite(police.state.stars)) return police.state.stars;
    } catch {
      // fall through
    }
    return 0;
  }

  function nearestCruiser(px, pz, maxDist) {
    if (!vehicles || !Array.isArray(vehicles.vehicles)) return null;
    let best = null;
    let bestDist = maxDist;
    for (const car of vehicles.vehicles) {
      if (!car || !car.police || !car.state) continue;
      const dx = car.state.x - px;
      const dz = car.state.z - pz;
      const d = Math.hypot(dx, dz);
      if (d < bestDist) {
        bestDist = d;
        best = car;
      }
    }
    return best;
  }

  // Pick a spawn point: beside a nearby cruiser when one is close
  // enough to have dropped its partner off, otherwise a ring around
  // Dani at 10–16 m. Never inside a building, never on top of her.
  function pickSpawn(px, pz) {
    const cruiser = nearestCruiser(px, pz, 45);
    if (cruiser && rng() < 0.6) {
      const yaw = cruiser.state.yaw || 0;
      const side = rng() < 0.5 ? -1 : 1;
      const x = cruiser.state.x + Math.cos(yaw) * CRUISER_SIDE * side;
      const z = cruiser.state.z + Math.sin(yaw) * CRUISER_SIDE * side;
      if (!blocked(x, z) && Math.hypot(x - px, z - pz) > 4) return { x, z };
    }
    for (let attempt = 0; attempt < 16; attempt++) {
      const a = rng() * TAU;
      const r = SPAWN_MIN + rng() * (SPAWN_MAX - SPAWN_MIN);
      const x = clamp(px + Math.sin(a) * r, -WORLD.extent, WORLD.extent);
      const z = clamp(pz - Math.cos(a) * r, -WORLD.extent, WORLD.extent);
      if (!blocked(x, z)) return { x, z };
    }
    return { x: clamp(px + SPAWN_MIN, -WORLD.extent, WORLD.extent), z: pz };
  }

  function spawnOne(px, pz) {
    const female = spawnCount % 2 === 1;
    spawnCount += 1;
    const spot = pickSpawn(px, pz);
    const mesh = buildOfficerFigure(female, rng);
    mesh.position.set(spot.x, groundAt(spot.x, spot.z), spot.z);
    mesh.rotation.y = angleTo({ x: spot.x, z: spot.z }, { x: px, z: pz });
    if (scene) scene.add(mesh);
    const officer = {
      mesh,
      female,
      x: spot.x,
      z: spot.z,
      heading: mesh.rotation.y,
      speed: CHASE_WALK,
      phase: rng() * Math.PI * 2,
      stride: 0.8 + rng() * 0.45,
      holding: false,
    };
    roster.push(officer);
    return officer;
  }

  function retireOfficer(officer) {
    if (scene && officer.mesh) scene.remove(officer.mesh);
    const at = roster.indexOf(officer);
    if (at >= 0) roster.splice(at, 1);
  }

  function clear() {
    for (let i = roster.length - 1; i >= 0; i--) retireOfficer(roster[i]);
  }

  function poseOfficer(officer, phase) {
    const limbs = officer.mesh && officer.mesh.userData && officer.mesh.userData.limbs;
    if (!limbs) return;
    const swing = Math.sin(phase) * 0.62;
    const armSwing = Math.sin(phase) * 0.45;
    limbs.leftLeg.rotation.x = swing;
    limbs.rightLeg.rotation.x = -swing;
    limbs.leftArm.rotation.x = -armSwing;
    limbs.rightArm.rotation.x = armSwing;
  }

  // ---- live behaviour -----------------------------------------------------
  // Chase Dani on foot: run when far, walk when near, hold a 5.5 m ring
  // and face her once inside it. The roster tracks the star band: a
  // band that pays for fewer officers retires the newest first, and
  // dropping below two stars clears the street at once.

  function update(dt, options) {
    const step = clamp(dt || 0, 0, 0.1);
    if (step <= 0) return;
    const opts = options || {};
    const player = opts.playerPos || null;
    const px = player && Number.isFinite(player.x) ? player.x : 0;
    const pz = player && Number.isFinite(player.z) ? player.z : 0;

    const want = officersForStars(starCount());
    while (roster.length > want) retireOfficer(roster[roster.length - 1]);
    if (roster.length < want) spawnOne(px, pz);

    for (const officer of roster) {
      const dx = px - officer.x;
      const dz = pz - officer.z;
      const dist = Math.hypot(dx, dz);
      const faceDani = angleTo({ x: officer.x, z: officer.z }, { x: px, z: pz });

      let diff = faceDani - officer.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      officer.heading += clamp(diff, -3.4 * step, 3.4 * step);

      officer.holding = dist <= HOLD_RING;
      const pace = officer.holding ? 0 : dist > 16 ? CHASE_RUN : CHASE_WALK;
      if (pace > 0) {
        const nx = officer.x + Math.sin(officer.heading) * pace * step;
        const nz = officer.z + Math.cos(officer.heading) * pace * step;
        if (!blocked(nx, nz) && Math.abs(nx) <= WORLD.extent && Math.abs(nz) <= WORLD.extent) {
          officer.x = nx;
          officer.z = nz;
        } else {
          officer.heading += (rng() < 0.5 ? -1 : 1) * 1.4;
        }
        officer.phase += step * pace * 3.4 * officer.stride;
      }

      const bob = pace > 0 ? Math.abs(Math.sin(officer.phase)) * 0.05 : 0;
      officer.mesh.position.set(officer.x, groundAt(officer.x, officer.z) + bob, officer.z);
      officer.mesh.rotation.y += wrapAngle(officer.heading - officer.mesh.rotation.y) * 0.85;
      poseOfficer(officer, officer.holding ? 0 : officer.phase);
    }
  }

  // ---- staged frames ------------------------------------------------------
  // A staged frame runs no loop, so the stager writes the officers in
  // by hand: a fixed count, placed in the player's frame ahead of her
  // and facing her — which also faces the lens behind her. Slots are
  // kept clear of the parked pursuit cruisers (3.5 m or more from any
  // cruiser centre) and out of the walls, with one sideways nudge each
  // if a slot lands too close to a car.

  function stage(centre, options) {
    clear();
    const opts = options || {};
    const count = Number.isFinite(opts.count) ? clamp(Math.floor(opts.count), 0, 4) : officersForStars(starCount());
    if (count <= 0) return 0;
    const px = centre && Number.isFinite(centre.x) ? centre.x : 0;
    const pz = centre && Number.isFinite(centre.z) ? centre.z : 0;
    const yaw = centre && Number.isFinite(centre.yaw) ? centre.yaw : 0;
    const forwardX = Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = Math.sin(yaw);

    const slots = [
      { ahead: 6.0, side: -3.4 },
      { ahead: 7.5, side: 3.2 },
      { ahead: 12.0, side: 5.6 },
      { ahead: 13.5, side: -6.2 },
    ];

    function cruiserNear(x, z, minDist) {
      if (!vehicles || !Array.isArray(vehicles.vehicles)) return false;
      for (const car of vehicles.vehicles) {
        if (!car || !car.police || !car.state) continue;
        if (Math.hypot(car.state.x - x, car.state.z - z) < minDist) return true;
      }
      return false;
    }

    let placed = 0;
    for (let i = 0; i < count && i < slots.length; i++) {
      const slot = slots[i];
      let x = px + forwardX * slot.ahead + rightX * slot.side;
      let z = pz + forwardZ * slot.ahead + rightZ * slot.side;
      // One sideways nudge if the slot lands on a cruiser or in a wall.
      if (cruiserNear(x, z, 3.5) || blocked(x, z)) {
        x = px + forwardX * slot.ahead - rightX * slot.side;
        z = pz + forwardZ * slot.ahead - rightZ * slot.side;
      }
      if (cruiserNear(x, z, 3.5) || blocked(x, z)) continue;

      const female = spawnCount % 2 === 1;
      spawnCount += 1;
      const mesh = buildOfficerFigure(female, rng);
      mesh.position.set(x, groundAt(x, z), z);
      mesh.rotation.y = angleTo({ x, z }, { x: px, z: pz });
      if (scene) scene.add(mesh);
      const officer = {
        mesh,
        female,
        x,
        z,
        heading: mesh.rotation.y,
        speed: 0,
        phase: 1.3 + i * 0.9,
        stride: 1,
        holding: true,
      };
      poseOfficer(officer, officer.phase);
      roster.push(officer);
      placed += 1;
    }
    return placed;
  }

  return { officers: roster, update, stage, clear, officersForStars, buildOfficerFigure };
}
