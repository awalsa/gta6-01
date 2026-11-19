// Pedestrians for Puerto Fuego.
//
// Each person is a handful of boxes with a two-bone walk cycle. The point is
// legibility at the distance the third-person camera actually sits: a clear
// silhouette, opposing arm and leg swing, and clothes that vary enough that a
// crowd does not read as one repeated mannequin.
//
// People walk the pavements, step off the kerb only at junctions, and run
// when they hear gunfire or a car bears down on them.

import * as THREE from 'three';
import { GRID, WORLD } from './config.js';
import { ROAD_LINES } from './city.js';
import { angleTo, clamp, createRandom, damp, pick, range } from './mathutil.js';

/**
 * Palettes. Ten of each, deliberately spread across warm, cool and neutral so
 * two neighbours in a crowd almost never share a top, and skin tones are not
 * all one shade.
 */
export const SHIRTS = [
  0xb8473f, 0x466f9e, 0xdccf9f, 0x557a4e, 0xc97f33,
  0x63547a, 0x33373e, 0x9db8c2, 0xc45f7d, 0x7d8449,
];
export const TROUSERS = [
  0x323a4c, 0x55493a, 0x777a80, 0x26333d, 0x97855f,
  0x42536b, 0x63503f, 0x2b2d31, 0x756a85, 0xa2adb3,
];
export const SKINS = [
  0xeec39e, 0xd29a70, 0xb0714a, 0x825636, 0x633e28,
  0xe9d1b4, 0x9c6038, 0x452e1e, 0xdba87f, 0x74452b,
];

const HALF_ROAD = GRID.road * 0.5;
// How far from a junction a person will step off the kerb. Beyond this the
// road is a wall.
const CROSSING_RADIUS = 6.5;
// Pavement band, measured from the road edge inward. People walk the outer
// half of the kerb.
const PAVEMENT_NEAR = 1.1;
const PAVEMENT_FAR = 4.2;

const UNIT_CUBE = new THREE.BoxGeometry(1, 1, 1);

// Shirts are per-person colour, so they are cached by hex: ten shirts, not
// ten times the crowd.
const SHIRT_MATS = new Map();
function shirtMat(hex) {
  let mat = SHIRT_MATS.get(hex);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.86, metalness: 0 });
    SHIRT_MATS.set(hex, mat);
  }
  return mat;
}

const TROUSER_MATS = new Map();
function trouserMat(hex) {
  let mat = TROUSER_MATS.get(hex);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.9, metalness: 0 });
    TROUSER_MATS.set(hex, mat);
  }
  return mat;
}

const SKIN_MATS = new Map();
function skinMat(hex) {
  let mat = SKIN_MATS.get(hex);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.78, metalness: 0 });
    SKIN_MATS.set(hex, mat);
  }
  return mat;
}

const HAIR_MAT = new THREE.MeshStandardMaterial({ color: 0x221b16, roughness: 0.95 });

function part(material, sx, sy, sz) {
  const mesh = new THREE.Mesh(UNIT_CUBE, material);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Nearest road line to a coordinate, so a person knows the carriageway they
 *  are walking beside. */
function closestLine(value) {
  let best = ROAD_LINES[0];
  let gap = Math.abs(value - best);
  for (let i = 1; i < ROAD_LINES.length; i++) {
    const d = Math.abs(value - ROAD_LINES[i]);
    if (d < gap) {
      gap = d;
      best = ROAD_LINES[i];
    }
  }
  return best;
}

/** True when (x, z) is over asphalt rather than a block slab. */
function isRoad(x, z, margin = 0) {
  for (let i = 0; i < ROAD_LINES.length; i++) {
    if (Math.abs(x - ROAD_LINES[i]) <= HALF_ROAD + margin) return true;
    if (Math.abs(z - ROAD_LINES[i]) <= HALF_ROAD + margin) return true;
  }
  return false;
}

/** True when the point is inside a junction box, where stepping off the kerb
 *  is legal. */
function atJunction(x, z) {
  let onX = false;
  let onZ = false;
  for (let i = 0; i < ROAD_LINES.length; i++) {
    if (Math.abs(x - ROAD_LINES[i]) <= HALF_ROAD + CROSSING_RADIUS) onX = true;
    if (Math.abs(z - ROAD_LINES[i]) <= HALF_ROAD + CROSSING_RADIUS) onZ = true;
  }
  return onX && onZ;
}

/**
 * Pick a pavement point: offset from a road line on one axis, free to slide
 * along it. `side` is which side of the street, `axis` says whether the
 * street runs north-south or east-west. Buildings fill most of a block, so
 * candidates are rejected when they land inside a footprint — without that
 * rejection a third of the crowd starts life entombed in a lobby.
 */
function pavementPoint(random, centre, isValid) {
  let fallback = null;
  for (let attempt = 0; attempt < 18; attempt++) {
    const axis = random() < 0.5 ? 'z' : 'x';
    // With a centre in hand, use the street that actually passes it: picking
    // a road line at random from the whole grid would scatter a "relocate
    // here" crowd across a block and a half.
    const line = centre ? closestLine(axis === 'z' ? centre.x : centre.z) : pick(random, ROAD_LINES);
    const side = random() < 0.5 ? -1 : 1;
    const inset = range(random, PAVEMENT_NEAR, PAVEMENT_FAR) + HALF_ROAD;
    const along = (axis === 'z' ? centre?.z : centre?.x) ?? 0;
    const spread = centre ? range(random, -30, 30) : range(random, -120, 120);
    const alongClamped = clamp(along + spread, -WORLD.extent * 0.86, WORLD.extent * 0.86);

    const spot =
      axis === 'z'
        ? { x: line + side * inset, z: alongClamped, axis, line, side }
        : { x: alongClamped, z: line + side * inset, axis, line, side };

    fallback = spot;
    if (!isValid || isValid(spot.x, spot.z)) return spot;
  }
  return fallback;
}

/** Assemble one walker: torso, head, hair, two pivoted arms, two pivoted legs. */
function assembleWalker(random) {
  const group = new THREE.Group();
  const shirt = shirtMat(pick(random, SHIRTS));
  const trousers = trouserMat(pick(random, TROUSERS));
  const skin = skinMat(pick(random, SKINS));

  // Slight height variation: a crowd of identical 1.7 m mannequins looks like
  // scenery, not people.
  const height = range(random, 1.58, 1.88);
  const scale = height / 1.75;

  const torsoHeight = 0.62 * scale;
  const torsoWidth = 0.42 * scale;
  const torsoDepth = 0.24 * scale;
  const legLength = 0.78 * scale;
  const legWidth = 0.17 * scale;

  const torso = part(shirt, torsoWidth, torsoHeight, torsoDepth);
  torso.position.y = legLength + torsoHeight * 0.5;
  group.add(torso);

  const head = part(skin, 0.22 * scale, 0.24 * scale, 0.22 * scale);
  head.position.y = legLength + torsoHeight + 0.13 * scale;
  group.add(head);

  const hair = part(HAIR_MAT, 0.23 * scale, 0.08 * scale, 0.23 * scale);
  hair.position.y = legLength + torsoHeight + 0.24 * scale;
  group.add(hair);

  // Arms hang from a shoulder pivot so the swing rotates about the joint,
  // not the elbow.
  const arms = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (torsoWidth * 0.5 + 0.055 * scale), legLength + torsoHeight - 0.04 * scale, 0);
    const arm = part(shirt, 0.11 * scale, 0.5 * scale, 0.13 * scale);
    // Offset down half the arm so the pivot sits at the shoulder and the box
    // hangs below it.
    arm.position.y = -0.25 * scale;
    shoulder.add(arm);

    const hand = part(skin, 0.1 * scale, 0.1 * scale, 0.11 * scale);
    hand.position.y = -0.52 * scale;
    shoulder.add(hand);

    group.add(shoulder);
    arms.push(shoulder);
  }

  const legs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * legWidth * 0.55, legLength, 0);
    const leg = part(trousers, legWidth, legLength, 0.18 * scale);
    leg.position.y = -legLength * 0.5;
    hip.add(leg);
    group.add(hip);
    legs.push(hip);
  }

  return { group, limbs: arms, hips: legs, scale, height };
}

export function createPeds(scene, handles) {
  const group = new THREE.Group();
  group.name = 'peds';
  scene.add(group);

  const people = [];
  const random = createRandom(0x9e3d21);

  function spawnPerson(x, z) {
    const body = assembleWalker(random);
    group.add(body.group);

    const person = {
      ...body,
      x,
      z,
      y: handles?.groundHeight ? handles.groundHeight(x, z) : 0,
      yaw: range(random, -Math.PI, Math.PI),
      speed: 0,
      walkSpeed: range(random, 0.9, 1.55),
      phase: range(random, 0, Math.PI * 2),
      // Idle timer and heading are per person: a crowd where everyone turns
      // at once reads as a chorus line rather than a street.
      idleTimer: range(random, 0, 3),
      paused: false,
      panic: 0,
      dodge: 0,
      dodgeDir: 0,
      target: null,
      axis: 'z',
      line: ROAD_LINES[0],
      side: 1,
      alongDir: random() < 0.5 ? -1 : 1,
    };

    person.group.position.set(x, person.y, z);
    person.group.rotation.y = -person.yaw;
    people.push(person);
    return person;
  }

  // A pavement point is only usable if it is not inside a building and not
  // out over the water.
  function usablePavement(x, z) {
    if (handles?.insideBuilding && handles.insideBuilding(x, z, 0.4)) return false;
    if (x > WORLD.beachStart) return false;
    return !isRoad(x, z, 0.35);
  }

  function pickDestination(person, centre) {
    // Wandering keeps a person on the same pavement they were put on, and
    // only lets them leave it at a junction — the crossing rule the whole
    // crowd is held to.
    const spot = pavementPoint(random, centre ?? { x: person.x, z: person.z }, usablePavement);
    person.axis = spot.axis;
    person.line = spot.line;
    person.side = spot.side;
    person.target = { x: spot.x, z: spot.z };
  }

  function within(x, z, radius) {
    const out = [];
    const r = radius * radius;
    for (let i = 0; i < people.length; i++) {
      const dx = people[i].x - x;
      const dz = people[i].z - z;
      if (dx * dx + dz * dz <= r) out.push(people[i]);
    }
    return out;
  }

  function nearest(x, z, radius = Infinity) {
    let best = null;
    let bestSq = radius * radius;
    for (let i = 0; i < people.length; i++) {
      const dx = people[i].x - x;
      const dz = people[i].z - z;
      const d = dx * dx + dz * dz;
      if (d <= bestSq) {
        bestSq = d;
        best = people[i];
      }
    }
    return best;
  }

  function relocate(centre) {
    const origin = centre ?? { x: 0, z: 0 };
    for (let i = 0; i < people.length; i++) {
      const person = people[i];
      const spot = pavementPoint(random, origin, usablePavement);
      person.x = spot.x;
      person.z = spot.z;
      person.axis = spot.axis;
      person.line = spot.line;
      person.side = spot.side;
      person.yaw = range(random, -Math.PI, Math.PI);
      person.speed = 0;
      person.paused = false;
      person.idleTimer = range(random, 0, 2.5);
      person.panic = 0;
      person.dodge = 0;
      person.target = null;
      person.y = handles?.groundHeight ? handles.groundHeight(person.x, person.z) : 0;
      person.group.position.set(person.x, person.y, person.z);
      person.group.rotation.y = -person.yaw;
    }
  }

  function seedCrowd(centre, count) {
    for (let i = 0; i < count; i++) {
      const spot = pavementPoint(random, centre, usablePavement);
      spawnPerson(spot.x, spot.z);
    }
  }

  /**
   * Move a person, refusing any step that would put them in a facade.
   * `allowRoad` is true only for panic: a fleeing crowd runs across the
   * carriageway rather than being walled in by the kerb, which is also what
   * keeps them from jittering in place against an invisible edge.
   */
  function stepPerson(person, dx, dz, allowRoad) {
    const nx = person.x + dx;
    const nz = person.z + dz;
    if (handles?.insideBuilding && handles.insideBuilding(nx, nz, 0.3)) return false;
    if (!allowRoad && isRoad(nx, nz) && !atJunction(nx, nz)) return false;
    if (nx > WORLD.beachStart) return false;
    person.x = nx;
    person.z = nz;
    return true;
  }

  function update(dt, ctx = {}) {
    if (!(dt > 0)) return;

    const player = ctx.playerPos ?? null;
    const alarmed = !!ctx.gunshots || !!ctx.alarm;

    for (let i = 0; i < people.length; i++) {
      const person = people[i];

      // --- threat response --------------------------------------------------
      let wantedX = null;
      let wantedZ = null;
      let wantedSpeed = 0;
      // Only danger overrides the kerb rule; walking never does.
      let allowRoad = false;

      if (alarmed && player) {
        // Flee along the line away from the player, not just away from the
        // point: running down the middle of the street in a straight line is
        // what panicking people actually do.
        person.panic = Math.min(1, person.panic + dt * 1.6);
        person.paused = false;
        // angleTo works in the atan2(dx, dz) convention, so the unit vector
        // along it is (sin a, cos a) — using the vehicle's forward convention
        // here would flee sideways.
        const away = angleTo(player, person);
        wantedX = Math.sin(away);
        wantedZ = Math.cos(away);
        wantedSpeed = 3.1 + person.panic * 1.2;
        allowRoad = true;
      } else {
        person.panic = Math.max(0, person.panic - dt * 0.7);
      }

      // A car bearing down on a person: side-step rather than stand in the lane.
      if (player && ctx.playerSpeed > 3.5) {
        const dxp = person.x - player.x;
        const dzp = person.z - player.z;
        const dist = Math.sqrt(dxp * dxp + dzp * dzp);
        if (dist < 10 && dist > 0.001) {
          // Only dodge the ones actually in front of the car; a person behind
          // it keeps walking.
          const heading = ctx.playerYaw ?? 0;
          const fx = Math.sin(heading);
          const fz = -Math.cos(heading);
          // Positive dot means the person is along the car's forward axis,
          // i.e. in its path.
          const facing = (dxp * fx + dzp * fz) / dist;
          if (facing > 0.35) {
            if (person.dodge <= 0) {
              // Sidestep toward whichever side of the car's path is nearer.
              const rx = Math.cos(heading);
              const rz = Math.sin(heading);
              person.dodgeDir = dxp * rx + dzp * rz >= 0 ? 1 : -1;
            }
            person.dodge = 0.75;
            wantedX = Math.cos(heading) * person.dodgeDir;
            wantedZ = Math.sin(heading) * person.dodgeDir;
            wantedSpeed = 3.8;
            allowRoad = true;
          }
        }
      }
      person.dodge = Math.max(0, person.dodge - dt);

      // --- wandering ---------------------------------------------------------
      if (wantedSpeed <= 0) {
        if (person.paused) {
          person.idleTimer -= dt;
          if (person.idleTimer <= 0) {
            person.paused = false;
            pickDestination(person, ctx.centre);
          }
        } else {
          if (!person.target) pickDestination(person, ctx.centre);
          const dx = person.target.x - person.x;
          const dz = person.target.z - person.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < 1.2) {
            // Stand about for a while: the pause is what makes the crowd look
            // inhabited.
            person.paused = true;
            person.idleTimer = range(random, 1.5, 6);
            person.target = null;
          } else {
            wantedX = dx / dist;
            wantedZ = dz / dist;
            wantedSpeed = person.walkSpeed;
          }
        }
      }

      // --- motion -------------------------------------------------------------
      if (wantedSpeed > 0 && wantedX !== null) {
        // Keep the step inside a comfortable per-frame distance so a long
        // frame cannot teleport a person through a wall the step check would
        // have caught at a smaller step.
        const stepLen = Math.min(wantedSpeed * dt, 0.5);
        const moved = stepPerson(person, wantedX * stepLen, wantedZ * stepLen, allowRoad);
        if (!moved) {
          // Blocked: turn away and pick somewhere else rather than grinding
          // against the facade.
          person.target = null;
          if (person.panic > 0.2) {
            person.yaw += range(random, 0.7, 1.6) * (random() < 0.5 ? -1 : 1);
          } else {
            person.paused = true;
            person.idleTimer = range(random, 0.2, 0.8);
          }
        }
        person.speed += (wantedSpeed - person.speed) * damp(9, dt);
        const wantedYaw = Math.atan2(wantedX, -wantedZ);
        // Turn toward the heading at a rate people can actually turn at.
        let delta = wantedYaw - person.yaw;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        person.yaw += delta * damp(7, dt);
      } else {
        person.speed += (0 - person.speed) * damp(9, dt);
      }

      person.y = handles?.groundHeight ? handles.groundHeight(person.x, person.z) : 0;

      // --- animation ----------------------------------------------------------
      // The phase advances with distance travelled, so a walk cycle matches
      // the stride instead of sliding along at a fixed tempo whatever the
      // speed.
      const stride = 0.9;
      person.phase += (person.speed / stride) * dt * Math.PI;
      const swing =
        person.speed > 0.05 ? Math.sin(person.phase) * clamp(person.speed / 2.2, 0, 1) * 0.62 : 0;
      const settle = damp(12, dt);

      // Arms and legs in opposition: left arm with right leg. That opposition
      // is the whole reason a box figure reads as walking rather than
      // hovering.
      const leftArm = person.limbs[0];
      const rightArm = person.limbs[1];
      const leftLeg = person.hips[0];
      const rightLeg = person.hips[1];

      leftArm.rotation.x += (swing - leftArm.rotation.x) * settle;
      rightArm.rotation.x += (-swing - rightArm.rotation.x) * settle;
      leftLeg.rotation.x += (-swing - leftLeg.rotation.x) * settle;
      rightLeg.rotation.x += (swing - rightLeg.rotation.x) * settle;

      // A small body bob at twice the stride frequency: one rise per footfall.
      const bob = person.speed > 0.05 ? Math.abs(Math.sin(person.phase)) * 0.035 : 0;

      person.group.position.set(person.x, person.y + bob, person.z);
      person.group.rotation.y = -person.yaw;
    }
  }

  // The crowd exists from the moment the system does: the street should never
  // be empty on the first frame before anyone remembers to call relocate. No
  // centre means a city-wide scatter, since the first frame is a wide
  // establishing shot, not a staged one around the player.
  seedCrowd(null, 26);

  return { people, group, update, within, nearest, relocate };
}
