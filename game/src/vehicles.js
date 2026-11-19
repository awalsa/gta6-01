// Vehicle physics and car bodies for Puerto Fuego.
//
// Every moving car in the city — the player's ride, ambient traffic, police
// cruisers — is the same kind of object, and every one of them is advanced by
// stepVehicle. That single shared handling model is what keeps a traffic sedan
// and the player's sports car honest about the same junction.
//
// Axis convention (from config.js): yaw 0 faces north (-Z), yaw grows
// clockwise, forward is (sin yaw, -cos yaw). Meshes are modelled facing -Z,
// so a body root is rotated with rotation.y = -yaw.

import * as THREE from 'three';
import { CAR_SPECS, VEHICLE } from './config.js';
import { clamp, damp, lerp, wrapAngle } from './mathutil.js';

const DEFAULT_SPEC = CAR_SPECS.sedan;

/** Longest physics step: a tab wake-up must not teleport a car through a wall. */
const MAX_STEP = 0.05;
/** Reverse is capped at a fraction of top speed. */
const REVERSE_FRACTION = 0.38;

// ---------------------------------------------------------------------------
// Materials
//
// Paint is cached per hex at module scope: a dozen cars in the same red must
// not upload a dozen identical shaders. Everything else is shared outright.

const PAINTS = new Map();

function paintFor(hex) {
  let found = PAINTS.get(hex);
  if (!found) {
    found = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.45, metalness: 0.25 });
    PAINTS.set(hex, found);
  }
  return found;
}

const GLASS = new THREE.MeshStandardMaterial({ color: 0x151d24, roughness: 0.14, metalness: 0.6 });
const RUBBER = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.94, metalness: 0 });
const ALLOY = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.36, metalness: 0.85 });
const DARK_TRIM = new THREE.MeshStandardMaterial({ color: 0x22262a, roughness: 0.72, metalness: 0.15 });

const LAMP_FRONT = new THREE.MeshStandardMaterial({
  color: 0xfff3d0,
  emissive: 0xffe7ae,
  emissiveIntensity: 1.7,
  roughness: 0.3,
});
const LAMP_REAR = new THREE.MeshStandardMaterial({
  color: 0x2a0505,
  emissive: 0xff2a18,
  emissiveIntensity: 1.4,
  roughness: 0.4,
});
const BEACON_RED = new THREE.MeshStandardMaterial({
  color: 0x40060a,
  emissive: 0xff1226,
  emissiveIntensity: 2.2,
  roughness: 0.35,
});
const BEACON_BLUE = new THREE.MeshStandardMaterial({
  color: 0x061033,
  emissive: 0x2a6bff,
  emissiveIntensity: 2.2,
  roughness: 0.35,
});
/** Near-white paint for the cruiser's doors and roof: black-and-white livery. */
const WHITE_PAINT = new THREE.MeshStandardMaterial({ color: 0xf2f2ec, roughness: 0.42, metalness: 0.2 });
/** Gloss near-black for the player's sports coupe: the reference car is black
 *  with red stripes, so the sports spec wears this instead of its pink.
 *  Kept just light enough to catch streetlight at night — pure black
 *  vanished into the asphalt in the night shot. */
const SPORTS_BLACK = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.3, metalness: 0.5 });
/** Racing red for the coupe's centre stripes: a faint emissive so the stripe
 *  still reads at night without glowing in daylight. */
const STRIPE_RED = new THREE.MeshStandardMaterial({ color: 0xc8102e, emissive: 0x40000a, emissiveIntensity: 0.35, roughness: 0.38, metalness: 0.3 });
/** Dark gunmetal for the coupe's rims, so the red brake ring reads against them. */
const GUNMETAL = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.35, metalness: 0.85 });
/** Dark red for the brake ring behind the coupe's rims. */
const BRAKE_RED = new THREE.MeshStandardMaterial({ color: 0x8f0f16, roughness: 0.5, metalness: 0.3 });

/**
 * "POLICE" door decal, drawn once on a 2D canvas and used as a texture.
 * Built lazily and guarded: if the canvas or texture fails for any reason
 * this returns null and the cruiser simply keeps its clean white doors.
 * The word is POLICE only — no department initials, no other branding.
 */
let POLICE_DECAL = undefined;
function policeDecalMaterial() {
  if (POLICE_DECAL !== undefined) return POLICE_DECAL;
  POLICE_DECAL = null;
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#14265e';
    ctx.font = 'bold 64px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('POLICE', canvas.width / 2, canvas.height / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    POLICE_DECAL = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
  } catch {
    POLICE_DECAL = null;
  }
  return POLICE_DECAL;
}

const UNIT_CUBE = new THREE.BoxGeometry(1, 1, 1);

/** A unit cube, scaled to a panel. One geometry serves every part of every car. */
function panel(material, w, h, d) {
  const mesh = new THREE.Mesh(UNIT_CUBE, material);
  mesh.scale.set(w, h, d);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Physics

/**
 * Does the car's footprint overlap a building at (x, z) with this heading?
 * Probes sit just past each bumper and at the four corners: a body whose
 * centre is still on asphalt can already have its nose inside a shop front.
 */
function footprintClear(insideBuilding, x, z, yaw, spec) {
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = Math.sin(yaw);
  const hl = spec.length * 0.5;
  const hw = spec.width * 0.5;

  const probes = [
    [hl + 0.2, 0],
    [-hl - 0.2, 0],
    [hl, hw],
    [hl, -hw],
    [-hl, hw],
    [-hl, -hw],
  ];

  for (let i = 0; i < probes.length; i++) {
    const px = x + fx * probes[i][0] + rx * probes[i][1];
    const pz = z + fz * probes[i][0] + rz * probes[i][1];
    if (insideBuilding(px, pz, 0)) return false;
  }
  return true;
}

/**
 * The arcade handling model. `state` holds position, heading, body-frame
 * velocities and the spec; `input` is { throttle, steer, brake, handbrake }
 * with throttle/steer in -1..1. Mutates and returns `state`.
 */
export function stepVehicle(state, input, dt) {
  if (!state || !(dt > 0)) return state;

  const spec = state.spec || DEFAULT_SPEC;
  const step = Math.min(dt, MAX_STEP);

  const throttle = clamp(input?.throttle ?? 0, -1, 1);
  const steer = clamp(input?.steer ?? 0, -1, 1);
  const braking = !!input?.brake;
  const handbrake = !!input?.handbrake;

  const top = spec.top;
  let forward = state.speed || 0;
  let lateral = state.lateral || 0;

  // --- longitudinal ---------------------------------------------------------
  if (throttle > 0) {
    // Engine pull fades with the square of speed, so the last few m/s are a
    // climb rather than a wall; the 0.15 floor leaves enough pull to actually
    // reach top speed on a flat road.
    const headroom = clamp(1 - 0.85 * (forward / top) ** 2, 0.15, 1);
    forward += spec.power * throttle * headroom * step;
  } else if (throttle < 0) {
    if (forward > 0.5) {
      forward = Math.max(0, forward - VEHICLE.brakeForce * -throttle * step);
    } else {
      // Below walking pace the same input becomes reverse: the car walks back
      // to a capped reverse speed instead of stalling against the brakes.
      forward = Math.max(-top * REVERSE_FRACTION, forward + spec.power * 0.42 * throttle * step);
    }
  }

  if (braking) {
    const bite = VEHICLE.brakeForce * step;
    forward = Math.abs(forward) <= bite ? 0 : forward - Math.sign(forward) * bite;
  }

  if (Math.abs(forward) > 0.001) {
    const coasting = Math.abs(throttle) < 0.02 || braking;
    // Linear drag plus rolling resistance: what a car does when the driver
    // lifts off, and why a coasting car settles at a stop instead of drifting.
    const drag = VEHICLE.drag * Math.abs(forward) * 0.12 + (coasting ? VEHICLE.rollingResistance : 0.35);
    const loss = drag * step;
    forward = Math.abs(forward) <= loss ? 0 : forward - Math.sign(forward) * loss;
  }

  forward = clamp(forward, -top * REVERSE_FRACTION, top);

  // --- steering ---------------------------------------------------------------
  const speedAbs = Math.abs(forward);
  // A parked car cannot pivot on the spot, and the turn rate falls off with
  // speed so a fast car sweeps wide through a junction instead of snapping.
  const authority = clamp(speedAbs / 2.2, 0, 1);
  const falloff = 1 / (1 + speedAbs * 0.075);
  const reverseSense = forward < -0.05 ? -1 : 1;
  const yawRate = steer * VEHICLE.steerRate * falloff * authority * reverseSense;

  const sinBefore = Math.sin(state.yaw);
  const cosBefore = Math.cos(state.yaw);
  // Keep the world velocity from before the steer, rotate the body, then
  // re-project: whatever no longer lines up with the nose is slip, which is
  // exactly what grip is about to eat.
  let vx = sinBefore * forward + cosBefore * lateral;
  let vz = -cosBefore * forward + sinBefore * lateral;

  state.yaw = wrapAngle(state.yaw + yawRate * step);

  const sinAfter = Math.sin(state.yaw);
  const cosAfter = Math.cos(state.yaw);

  forward = vx * sinAfter - vz * cosAfter;
  lateral = vx * cosAfter + vz * sinAfter;

  // Grip bleeds sideways velocity toward zero. The handbrake keeps most of it,
  // which is the whole difference between a tidy lane change and a drift.
  const gripRate = handbrake ? VEHICLE.grip * 0.22 : VEHICLE.grip;
  lateral *= Math.exp(-gripRate * step);

  vx = sinAfter * forward + cosAfter * lateral;
  vz = -cosAfter * forward + sinAfter * lateral;

  // --- movement ---------------------------------------------------------------
  const nextX = state.x + vx * step;
  const nextZ = state.z + vz * step;
  const inside = state.handles?.insideBuilding;

  if (!inside || footprintClear(inside, nextX, nextZ, state.yaw, spec)) {
    state.x = nextX;
    state.z = nextZ;
  } else if (footprintClear(inside, nextX, state.z, state.yaw, spec)) {
    // Slide along the facade: a car scraping a wall keeps the component of its
    // motion that runs parallel to it instead of dead-stopping in the road.
    state.x = nextX;
    forward *= 0.7;
    lateral *= 0.5;
  } else if (footprintClear(inside, state.x, nextZ, state.yaw, spec)) {
    state.z = nextZ;
    forward *= 0.7;
    lateral *= 0.5;
  } else {
    // Square into the wall: bounce back and lose most of the energy.
    forward = -forward * 0.22;
    lateral *= 0.2;
  }

  // Wheels sit on whatever surface is under the body, so the car climbs the
  // kerb with the block slab rather than floating at asphalt height. Eased,
  // because a kerb edge is a step.
  const ground = state.handles?.groundHeight
    ? state.handles.groundHeight(state.x, state.z)
    : state.y ?? 0;
  state.y = lerp(state.y ?? ground, ground, damp(12, dt));

  state.speed = forward;
  state.lateral = lateral;
  state.vx = vx;
  state.vz = vz;
  return state;
}

// ---------------------------------------------------------------------------
// Car bodies

/**
 * Build one car out of boxes. Everything faces -Z: headlights at -Z, cabin
 * pushed toward +Z, so a car whose cabin sits over the middle reads as a bus
 * from the side.
 */
function makeBody(spec, paint, police) {
  const group = new THREE.Group();
  const length = spec.length;
  const width = spec.width;
  const height = spec.height;

  // The sports coupe wears gloss black instead of its spec paint; every
  // other car keeps the paint it was spawned with.
  const bodyPaint = spec === CAR_SPECS.sports ? SPORTS_BLACK : paintFor(paint);

  // The silhouette is built in three stacked steps instead of one slab, so the
  // car reads as a car from above as well as from the side: a low hood up
  // front, a tall beltline under the cabin, a low trunk at the rear. Every
  // layer is a touch narrower than the one below it, so no two faces are
  // coplanar and nothing z-fights. All of it stays inside the spec box, so
  // the collision footprint does not move.
  const shellHeight = Math.max(0.36, height * 0.42);
  const floor = VEHICLE.rideHeight * 1.06;
  // The spec length is the collision box, so the painted shell is inset by the
  // bumper depth at nose and tail: bumpers then sit flush with the collision
  // box instead of hanging past it.
  const bumperDepth = 0.16;
  const shellLength = length - bumperDepth * 2;

  // Beltline base: the lowest painted band, full length.
  const bandHeight = 0.30;
  const lowerBody = panel(bodyPaint, width * 0.96, bandHeight, shellLength);
  lowerBody.position.y = floor + bandHeight * 0.5;
  group.add(lowerBody);

  // Shoulder: the tall middle band the cabin sits on, inset from the base.
  const shoulderHeight = shellHeight - bandHeight;
  const shoulder = panel(bodyPaint, width * 0.92, shoulderHeight, shellLength * 0.62);
  shoulder.position.set(0, floor + bandHeight + shoulderHeight * 0.5, length * 0.05);
  group.add(shoulder);

  // Hood: a low step up front, inset from the base and below the beltline.
  const hoodLength = shellLength * 0.30;
  const hood = panel(bodyPaint, width * 0.94, 0.13, hoodLength);
  hood.position.set(0, floor + bandHeight + 0.065, -shellLength * 0.5 + hoodLength * 0.5);
  group.add(hood);

  // Trunk: a low step at the rear, same idea as the hood.
  const trunkLength = shellLength * 0.20;
  const trunk = panel(bodyPaint, width * 0.94, 0.11, trunkLength);
  trunk.position.set(0, floor + bandHeight + 0.055, shellLength * 0.5 - trunkLength * 0.5);
  group.add(trunk);

  const bumperFront = panel(DARK_TRIM, width * 0.94, shellHeight * 0.34, bumperDepth);
  bumperFront.position.set(0, floor + shellHeight * 0.34, -length * 0.5 + bumperDepth * 0.5);
  group.add(bumperFront);

  const bumperRear = panel(DARK_TRIM, width * 0.94, shellHeight * 0.34, bumperDepth);
  bumperRear.position.set(0, floor + shellHeight * 0.34, length * 0.5 - bumperDepth * 0.5);
  group.add(bumperRear);

  // Front splitter lip under the nose: the coupe's low front, flush with the
  // collision box so the footprint does not move.
  if (spec === CAR_SPECS.sports) {
    const splitter = panel(DARK_TRIM, width * 0.94, 0.05, 0.14);
    splitter.position.set(0, floor + 0.025, -length * 0.5 + 0.07);
    group.add(splitter);
  }

  // Cabin: dark glass with a painted roof cap that is SHORTER than the cabin,
  // so glass shows at the front and rear of the roofline from above, and
  // sloped glass at both ends instead of a flat glass brick.
  const barHeight = police ? 0.16 : 0;
  // The coupe's roofline sits lower than a sedan's: a sleeker glasshouse.
  const roofDrop = spec === CAR_SPECS.sports ? 0.05 : 0;
  const cabinHeight = Math.max(0.2, height - (floor + shellHeight) - 0.06 - barHeight - roofDrop);
  const cabinLength = length * 0.44;
  const cabinZ = length * 0.07;
  const cabin = panel(GLASS, width * 0.76, cabinHeight, cabinLength);
  cabin.position.set(0, floor + shellHeight + cabinHeight * 0.5, cabinZ);
  group.add(cabin);

  const roof = panel(police ? WHITE_PAINT : bodyPaint, width * 0.74, 0.06, cabinLength * 0.68);
  roof.position.set(0, floor + shellHeight + cabinHeight + 0.01, cabinZ);
  group.add(roof);

  // Sloped windshield and rear glass: the top leans toward the cabin, the
  // bottom meets the hood and the trunk, so the glasshouse has a rake.
  const glassHeight = cabinHeight * 1.25;
  const windshield = panel(GLASS, width * 0.70, glassHeight, 0.05);
  windshield.rotation.x = 0.38;
  windshield.position.set(0, floor + shellHeight + cabinHeight * 0.5, cabinZ - cabinLength * 0.42);
  group.add(windshield);

  const rearGlass = panel(GLASS, width * 0.70, glassHeight, 0.05);
  rearGlass.rotation.x = -0.38;
  rearGlass.position.set(0, floor + shellHeight + cabinHeight * 0.5, cabinZ + cabinLength * 0.42);
  group.add(rearGlass);

  // B-pillars: thin painted strips on the cabin flanks, so the side glass
  // reads as windows instead of one dark slab. Mirrors ride on short stalks
  // at the front of the cabin, just proud of the body sides.
  for (const side of [-1, 1]) {
    const pillar = panel(bodyPaint, 0.03, cabinHeight * 0.92, 0.07);
    pillar.position.set(side * (width * 0.38 + 0.005), floor + shellHeight + cabinHeight * 0.5, cabinZ);
    group.add(pillar);

    const stalk = panel(DARK_TRIM, 0.10, 0.03, 0.03);
    stalk.position.set(side * width * 0.40, floor + shellHeight + cabinHeight * 0.32, cabinZ - cabinLength * 0.40);
    group.add(stalk);

    const mirror = panel(DARK_TRIM, 0.05, 0.10, 0.13);
    mirror.position.set(side * width * 0.46, floor + shellHeight + cabinHeight * 0.32, cabinZ - cabinLength * 0.40);
    group.add(mirror);
  }

  // Sports dress-up: red centre stripes over hood, roof and trunk, hood
  // vents, and a raised GT wing on the trunk — the black/red coupe from the
  // reference, still inside the spec box. Each stripe sits a hair proud of
  // the surface it rides on, so no face is coplanar with anything behind it.
  if (spec === CAR_SPECS.sports) {
    const hoodTop = floor + bandHeight + 0.13;
    const roofTop = floor + shellHeight + cabinHeight + 0.04;
    const trunkTop = floor + bandHeight + 0.11;

    const hoodStripe = panel(STRIPE_RED, 0.3, 0.015, hoodLength);
    hoodStripe.position.set(0, hoodTop + 0.008, -shellLength * 0.5 + hoodLength * 0.5);
    group.add(hoodStripe);

    const roofStripe = panel(STRIPE_RED, 0.3, 0.015, cabinLength * 0.68);
    roofStripe.position.set(0, roofTop + 0.008, cabinZ);
    group.add(roofStripe);

    const trunkStripe = panel(STRIPE_RED, 0.3, 0.015, trunkLength);
    trunkStripe.position.set(0, trunkTop + 0.008, shellLength * 0.5 - trunkLength * 0.5);
    group.add(trunkStripe);

    for (const side of [-1, 1]) {
      const vent = panel(DARK_TRIM, 0.26, 0.02, 0.34);
      vent.position.set(side * 0.3, hoodTop + 0.012, -shellLength * 0.5 + hoodLength * 0.5);
      group.add(vent);
    }

    for (const side of [-1, 1]) {
      const strut = panel(DARK_TRIM, 0.06, 0.12, 0.06);
      strut.position.set(side * 0.55, trunkTop + 0.06, shellLength * 0.5 - 0.12);
      group.add(strut);
    }
    const wing = panel(SPORTS_BLACK, width * 0.88, 0.04, 0.26);
    wing.position.set(0, trunkTop + 0.13, shellLength * 0.5 - 0.12);
    group.add(wing);
  }

  // Dark side skirts between the wheels: they ground the body and make the
  // wheel gaps read as arches instead of a floating slab.
  for (const side of [-1, 1]) {
    const skirt = panel(DARK_TRIM, 0.04, 0.10, length * 0.30);
    skirt.position.set(side * width * 0.48, floor + 0.05, 0);
    group.add(skirt);
  }

  // --- wheels -----------------------------------------------------------------
  // The old mesh tucked the tyres inside the body sides, so from the rear
  // three-quarter view that every staged shot uses, the car had no visible
  // wheels at all. The tyres now stand just proud of the lower body — still
  // inside the spec width, so the collision box is untouched — and the rims
  // are bigger and brighter, so a wheel reads as a wheel even on dark asphalt.
  const wheels = [];
  const wheelRadius = VEHICLE.rideHeight;
  const wheelWidth = Math.min(0.26, width * 0.13);
  const tyreGeometry = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 12);
  const rimGeometry = new THREE.CylinderGeometry(wheelRadius * 0.62, wheelRadius * 0.62, wheelWidth * 1.08, 8);
  // Slightly larger than the rim but narrower than it is wide, so the red
  // ring shows around the dark rim without ever covering its face.
  const brakeGeometry = new THREE.CylinderGeometry(wheelRadius * 0.68, wheelRadius * 0.68, wheelWidth * 1.04, 12);
  const track = width * 0.5 - wheelWidth * 0.5 - 0.005;

  for (let i = 0; i < 4; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const front = i < 2 ? -1 : 1;

    // The pivot stays unrotated and spins on X (the axle line); the cylinder
    // inside is turned a quarter turn so its default Y axis becomes that axle.
    const pivot = new THREE.Group();
    pivot.position.set(side * track, wheelRadius, front * length * 0.31);

    const tyre = new THREE.Mesh(tyreGeometry, RUBBER);
    tyre.rotation.z = Math.PI / 2;
    tyre.castShadow = true;
    pivot.add(tyre);

    const rim = new THREE.Mesh(rimGeometry, spec === CAR_SPECS.sports ? GUNMETAL : ALLOY);
    rim.rotation.z = Math.PI / 2;
    pivot.add(rim);

    // The coupe's red brake ring: a red disc behind the dark rim, its edge
    // showing as a red ring around it at a glance.
    if (spec === CAR_SPECS.sports) {
      const brake = new THREE.Mesh(brakeGeometry, BRAKE_RED);
      brake.rotation.z = Math.PI / 2;
      pivot.add(brake);
    }

    group.add(pivot);
    wheels.push({ pivot, radius: wheelRadius });
  }

  // --- lights -----------------------------------------------------------------
  // Headlights sit on the hood's nose, a dark grille between them on the
  // bumper face, and the rear gets one full-width red bar across the trunk
  // face instead of two small blocks, so the tail reads at a glance from
  // behind — which is where the staged camera always sits.
  for (const side of [-1, 1]) {
    const head = panel(LAMP_FRONT, width * 0.26, 0.13, 0.08);
    head.position.set(side * width * 0.3, floor + bandHeight + 0.065, -shellLength * 0.5 - 0.03);
    group.add(head);
  }

  const grille = panel(DARK_TRIM, width * 0.36, 0.08, 0.06);
  grille.position.set(0, floor + shellHeight * 0.34, -length * 0.5 - 0.01);
  group.add(grille);

  const tailBar = panel(LAMP_REAR, width * 0.80, 0.09, 0.06);
  tailBar.position.set(0, floor + bandHeight + 0.055, shellLength * 0.5 + 0.03);
  group.add(tailBar);

  // --- police livery ------------------------------------------------------------
  if (police) {
    // Black-and-white livery: white doors over the black body (the roof is
    // already white), so a cruiser reads as a cruiser even with its light
    // bar out of frame. The panels sit a hair proud of the skirt and the
    // body side, so no face is coplanar with anything behind it.
    for (const side of [-1, 1]) {
      const door = panel(WHITE_PAINT, 0.03, 0.3, length * 0.34);
      door.position.set(side * (width * 0.48 + 0.015), floor + 0.19, length * 0.02);
      group.add(door);

      // "POLICE" on the door, drawn on a canvas: the word only, no
      // department initials, no other branding. If the texture fails, the
      // door simply stays clean white.
      const decal = policeDecalMaterial();
      if (decal) {
        const text = new THREE.Mesh(new THREE.PlaneGeometry(length * 0.24, 0.2), decal);
        text.rotation.y = side * Math.PI * 0.5;
        text.position.set(side * (width * 0.48 + 0.033), floor + 0.19, length * 0.02);
        group.add(text);
      }
    }

    // Anchored to the top of the spec rather than to the roof, so the light bar
    // fills the last 16 cm of the silhouette instead of adding to it.
    const barBase = height - barHeight;
    const barZ = length * 0.07;

    const base = panel(DARK_TRIM, width * 0.72, 0.05, 0.24);
    base.position.set(0, barBase - 0.02, barZ);
    group.add(base);

    // Two blocks, red to one side and blue to the other, so a cruiser is
    // identifiable from the roof alone at any distance or light level.
    const red = panel(BEACON_RED, width * 0.32, barHeight, 0.2);
    red.position.set(-width * 0.17, barBase + barHeight * 0.5, barZ);
    group.add(red);

    const blue = panel(BEACON_BLUE, width * 0.32, barHeight, 0.2);
    blue.position.set(width * 0.17, barBase + barHeight * 0.5, barZ);
    group.add(blue);

    // Push bar: a dark guard frame ahead of the grille, like the reference
    // cruiser's. It stands inside the collision probes' margin, so the car
    // still stops short of a wall before the bar could touch it.
    const pushZ = -length * 0.5 - 0.08;
    for (const side of [-1, 1]) {
      const upright = panel(DARK_TRIM, 0.08, 0.44, 0.08);
      upright.position.set(side * 0.45, floor + 0.34, pushZ);
      group.add(upright);
    }
    const crossbar = panel(DARK_TRIM, 1.0, 0.09, 0.08);
    crossbar.position.set(0, floor + 0.48, pushZ);
    group.add(crossbar);
  }

  return { group, wheels };
}

/** Free a car's per-car geometries. Materials are shared: disposing them here
 *  would blank every other car in the city. */
function releaseMesh(root) {
  root.traverse((child) => {
    if (child.isMesh && child.geometry && child.geometry !== UNIT_CUBE) child.geometry.dispose();
  });
}

/** Copy a vehicle's physics state onto its mesh, and spin the wheels. */
function alignMesh(vehicle, dt) {
  const state = vehicle.state;
  vehicle.group.position.set(state.x, state.y, state.z);
  // Negated: the body is modelled facing -Z while yaw 0 is north and yaw
  // grows clockwise.
  vehicle.group.rotation.y = -state.yaw;

  if (dt > 0 && vehicle.wheels.length) {
    const spin = (state.speed / VEHICLE.rideHeight) * dt;
    for (let i = 0; i < vehicle.wheels.length; i++) vehicle.wheels[i].pivot.rotation.x += spin;
  }
}

// ---------------------------------------------------------------------------
// Fleet

/**
 * Owns every vehicle in the scene: the player's car, ambient traffic and the
 * police response all live in one list, so nearest/byId see a single fleet.
 */
export function createVehicleSystem(scene, handles) {
  const group = new THREE.Group();
  group.name = 'vehicles';
  scene.add(group);

  const vehicles = [];
  let nextId = 1;

  function spawn(kind, x, z, yaw = 0, options = {}) {
    const spec = CAR_SPECS[kind] || DEFAULT_SPEC;
    const police = options.police ?? (kind === 'cruiser');
    const paint = options.paint ?? spec.paint;
    const body = makeBody(spec, paint, police);
    group.add(body.group);

    const state = {
      x,
      z,
      yaw: wrapAngle(yaw),
      y: handles?.groundHeight ? handles.groundHeight(x, z) : 0,
      speed: 0,
      lateral: 0,
      vx: 0,
      vz: 0,
      spec,
      // The physics reads the city through the state, so a caller holding only
      // a car can still collide it — traffic and pedestrians never need to hand
      // the handles around.
      handles,
    };

    const vehicle = {
      id: nextId++,
      kind,
      spec,
      paint,
      police,
      driver: options.driver ?? null,
      state,
      group: body.group,
      wheels: body.wheels,
      input: { throttle: 0, steer: 0, brake: false, handbrake: false },
      // Traffic drives its own cars through stepVehicle, so the system must
      // not step them twice.
      autoStep: true,
    };

    vehicles.push(vehicle);
    alignMesh(vehicle, 0);
    return vehicle;
  }

  function despawn(target) {
    const index =
      typeof target === 'number' ? vehicles.findIndex((v) => v.id === target) : vehicles.indexOf(target);
    if (index < 0) return false;

    const [vehicle] = vehicles.splice(index, 1);
    group.remove(vehicle.group);
    releaseMesh(vehicle.group);
    return true;
  }

  function clear() {
    for (let i = vehicles.length - 1; i >= 0; i--) despawn(vehicles[i]);
  }

  function update(dt) {
    for (let i = 0; i < vehicles.length; i++) {
      const vehicle = vehicles[i];
      if (vehicle.autoStep) stepVehicle(vehicle.state, vehicle.input, dt);
      alignMesh(vehicle, dt);
    }
  }

  function nearest(x, z, radius = Infinity) {
    let best = null;
    let bestSq = radius * radius;
    for (let i = 0; i < vehicles.length; i++) {
      const s = vehicles[i].state;
      const dx = s.x - x;
      const dz = s.z - z;
      const d = dx * dx + dz * dz;
      if (d <= bestSq) {
        bestSq = d;
        best = vehicles[i];
      }
    }
    return best;
  }

  function byId(id) {
    for (let i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) return vehicles[i];
    return null;
  }

  return { vehicles, group, spawn, despawn, clear, update, nearest, byId, sync: alignMesh };
}
