// Dani Reyes, rendered. player.js owns where she is; this module owns what she
// looks like — a bike courier in a denim jacket, built from boxes, with every
// limb hanging off a pivot at its joint so a walk cycle swings from the shoulder
// and hip instead of around the middle of a limb.

import * as THREE from 'three';
import { clamp, damp, lerp } from './mathutil.js';

// Palette: warm skin against mid-blue denim and near-black trousers, chosen so
// she separates from an orange, low-contrast sunset street.
const PALETTE = {
  skin: 0xc98d63,
  skinDark: 0xb47a52,
  jacket: 0x2f4d70,
  jacketDark: 0x243c58,
  tee: 0x8f9aa4,
  pants: 0x23262f,
  hair: 0x241a14,
  shoe: 0x17171a,
};

// 1 unit = 1 metre. Total height ~1.79 m to the top of the hair, matching the
// collision capsule so she does not clip doorframes.
const DIM = {
  hipY: 0.9,
  thigh: 0.42,
  shin: 0.4,
  shoeH: 0.08,
  torsoH: 0.56,
  shoulderY: 0.5,
  upperArm: 0.32,
  forearm: 0.3,
};

// One full stride cycle (two steps) covers ~1.6 m. At a 7.2 m/s run that is
// about 4.5 steps a second — a jog, not a scuttle.
const STRIDE = (Math.PI * 2) / 1.6;
const LEG_SWING = 0.62; // thigh clip limit at a run
const ARM_SWING = 0.5;

/** Box mesh with a standard material, shadow-casting on. */
function slab(w, h, d, color, roughness = 0.85) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 })
  );
  mesh.castShadow = true;
  return mesh;
}

/** Empty group at an offset — a joint pivot. */
function joint(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

export function createCharacter(scene, player) {
  const group = new THREE.Group();
  group.name = 'dani-reyes';

  // `body` carries everything above the feet, so the walk bob can move the
  // figure without moving the ground-contact point the game reads.
  const body = joint(group, 0, 0, 0);
  const hips = joint(body, 0, DIM.hipY, 0);

  // --- torso ---------------------------------------------------------------
  const jacket = slab(0.52, DIM.torsoH, 0.3, PALETTE.jacket);
  // Offset from the waist pivot — the axis the aiming twist rotates about —
  // rather than the middle of the chest.
  jacket.position.y = DIM.torsoH * 0.5;
  hips.add(jacket);

  // Open jacket front: a thin inset slab reads as a shirt gap, not a second coat.
  const tee = slab(0.22, DIM.torsoH - 0.06, 0.02, PALETTE.tee, 0.9);
  tee.position.set(0, DIM.torsoH * 0.48, 0.155);
  hips.add(tee);

  const neck = slab(0.14, 0.08, 0.14, PALETTE.skinDark);
  neck.position.y = DIM.torsoH + 0.03;
  hips.add(neck);

  // --- head ----------------------------------------------------------------
  const skull = joint(hips, 0, DIM.torsoH, 0);
  const face = slab(0.26, 0.28, 0.26, PALETTE.skin, 0.7);
  face.position.y = 0.14;
  skull.add(face);

  // Hair cap sits proud and slightly back so the face stays readable from a
  // camera that is usually behind her.
  const hairCap = slab(0.28, 0.16, 0.29, PALETTE.hair, 0.95);
  hairCap.position.set(0, 0.245, -0.015);
  skull.add(hairCap);

  // Ponytail: the one silhouette detail that survives being eight pixels tall
  // in a chase camera.
  const pony = slab(0.13, 0.2, 0.12, PALETTE.hair, 0.95);
  pony.position.set(0, 0.13, -0.17);
  skull.add(pony);

  // --- limbs ---------------------------------------------------------------
  function makeArm(side) {
    // side -1 is her right (world -X at yaw 0), +1 is her left.
    const shoulder = joint(hips, side * 0.33, DIM.shoulderY, 0);
    const upper = slab(0.13, DIM.upperArm, 0.15, PALETTE.jacket);
    upper.position.y = -DIM.upperArm * 0.5; // sleeve hangs from the shoulder
    shoulder.add(upper);

    const elbow = joint(shoulder, 0, -DIM.upperArm, 0);
    const fore = slab(0.11, DIM.forearm, 0.12, PALETTE.jacketDark);
    fore.position.y = -DIM.forearm * 0.5;
    elbow.add(fore);

    const hand = slab(0.1, 0.12, 0.11, PALETTE.skin, 0.75);
    hand.position.y = -(DIM.forearm + 0.06);
    elbow.add(hand);
    return { shoulder, elbow };
  }

  function makeLeg(side) {
    const hip = joint(hips, side * 0.14, 0, 0);
    const thigh = slab(0.17, DIM.thigh, 0.19, PALETTE.pants);
    thigh.position.y = -DIM.thigh * 0.5;
    hip.add(thigh);

    const knee = joint(hip, 0, -DIM.thigh, 0);
    const shin = slab(0.15, DIM.shin, 0.17, PALETTE.pants);
    shin.position.y = -DIM.shin * 0.5;
    knee.add(shin);

    // Toe toward local +Z (her facing direction) so it reads from behind.
    const shoe = slab(0.17, DIM.shoeH, 0.28, PALETTE.shoe, 0.6);
    shoe.position.set(0, -DIM.shin - DIM.shoeH * 0.4, 0.05);
    knee.add(shoe);
    return { hip, knee };
  }

  const rightArm = makeArm(-1);
  const leftArm = makeArm(1);
  const rightLeg = makeLeg(-1);
  const leftLeg = makeLeg(1);

  // Two short-range point lights ride with her: a warm key in front, a cool rim
  // behind, lifting her silhouette off a sunset street without repainting the road.
  const keyLight = new THREE.PointLight(0xffd2a1, 2.4, 5.5, 2);
  keyLight.position.set(0.55, 1.45, 1.1);
  group.add(keyLight);
  const rimLight = new THREE.PointLight(0x9dc4ff, 1.7, 5, 2);
  rimLight.position.set(-0.5, 1.7, -1.2);
  group.add(rimLight);

  // Frustum culling off: she is at the centre of almost every shot, and a rig
  // whose bounds the camera grazes would pop out for a single frame exactly
  // when she fills the screen.
  group.traverse((obj) => {
    if (obj.isMesh) obj.frustumCulled = false;
  });

  if (scene && typeof scene.add === 'function') scene.add(group);

  // Joints are reachable both on the returned state and on userData, so a
  // weapon or IK pass can find a hand without walking the graph by child index.
  const joints = {
    torso: hips,
    head: skull,
    armR: rightArm.shoulder,
    elbowR: rightArm.elbow,
    armL: leftArm.shoulder,
    elbowL: leftArm.elbow,
    legR: rightLeg.hip,
    kneeR: rightLeg.knee,
    legL: leftLeg.hip,
    kneeL: leftLeg.knee,
  };
  group.userData.joints = joints;

  const state = {
    phase: 0,
    aiming: false,
    speed: 0,
    visible: true,
    group,
    joints,
  };

  // Smoothed animation values; `damp(rate, dt)` here is a 0..1 blend factor fed
  // into lerp(), not an eased value — calling it as damp(value, target, ...) would
  // quietly collapse the animation to zero.
  let aimMix = 0;
  let bobY = 0;
  let leanX = 0;

  function pose(input) {
    const opts = input || {};
    const phase = Number.isFinite(opts.phase) ? opts.phase : state.phase;
    // An explicit aiming flag applies at once: pose() is the direct control path
    // (an animator or test expects the arm up on this call); update() relies on
    // the smoothed blend instead.
    const aimGiven = opts.aiming !== undefined;
    const aiming = aimGiven ? !!opts.aiming : state.aiming;
    state.phase = phase;
    state.aiming = aiming;
    if (aimGiven) aimMix = aiming ? 1 : 0;

    const swingR = Math.sin(phase);
    const swingL = Math.sin(phase + Math.PI);

    // Legs in opposition; positive X rotation swings a leg forward.
    rightLeg.hip.rotation.x = swingR * LEG_SWING;
    leftLeg.hip.rotation.x = swingL * LEG_SWING;

    // Knees bend backward only, and only on the trailing leg — the usual tell
    // of a procedural walk is a stance leg that hyperextends.
    const bend = (p) => Math.max(0, -Math.sin(p - 0.6)) * 0.85;
    rightLeg.knee.rotation.x = -bend(phase);
    leftLeg.knee.rotation.x = -bend(phase + Math.PI);

    // Arms counter-swing the legs; without this she marches with her hands in
    // her pockets.
    const armR = swingL * ARM_SWING;
    const armL = swingR * ARM_SWING;

    // Pistol hold: shoulders up and in, elbows folded, hands meeting in front
    // of the chest.
    const RAISE = -1.32;
    const FOLD = -0.55;
    rightArm.shoulder.rotation.x = aimMix * RAISE + (1 - aimMix) * armR;
    leftArm.shoulder.rotation.x = aimMix * (RAISE + 0.12) + (1 - aimMix) * armL;
    // Slight inward splay so sleeves never intersect the torso at full swing.
    rightArm.shoulder.rotation.z = -0.08 - aimMix * 0.12;
    leftArm.shoulder.rotation.z = 0.08 + aimMix * 0.06;
    rightArm.elbow.rotation.x = aimMix * FOLD + (1 - aimMix) * Math.max(0, armR) * 0.35;
    leftArm.elbow.rotation.x = aimMix * (FOLD - 0.18) + (1 - aimMix) * Math.max(0, armL) * 0.35;

    // Aiming blades the stance: shoulders turned slightly look trained, squared
    // looks posed. The head counter-rotates so she still looks where the gun points.
    const twist = aimMix * 0.22;
    hips.rotation.y = twist;
    skull.rotation.y = -twist * 0.7;
    skull.rotation.x = aimMix * 0.06;

    return { phase, aiming, blend: aimMix };
  }

  function setVisible(visible) {
    const next = visible !== false;
    state.visible = next;
    group.visible = next;
    // Lights follow explicitly: an invisible parent stops drawing the meshes,
    // but a light left on would keep lighting the street from nowhere.
    keyLight.visible = next;
    rimLight.visible = next;
  }

  function currentSpeed() {
    const ps = player && player.state;
    if (!ps) return 0;
    // `speed` is already planar and is what the walk phase was tuned against;
    // the velocity is the fallback for a player that only publishes a vector.
    if (Number.isFinite(ps.speed)) return Math.max(0, ps.speed);
    const v = ps.velocity;
    if (!v) return 0;
    const planar = Math.hypot(Number(v.x) || 0, Number(v.z) || 0);
    return Number.isFinite(planar) ? planar : 0;
  }

  function update(dt) {
    const step = clamp(Number(dt) || 0, 0, 0.1);
    const ps = player && player.state;
    if (!ps) return state;

    // Hidden behind a wheel, but the transform keeps tracking: popping back into
    // view in the right place is cheaper than re-parenting on exit.
    setVisible(!ps.inVehicle && ps.alive !== false);
    if (ps.inVehicle) {
      state.speed = 0;
      // The phase is left where it stopped rather than reset: stepping out of a
      // car mid-stride looks natural, restarting from zero looks like a jump cut.
      return state;
    }

    if (ps.position && Number.isFinite(ps.position.x)) {
      const y = Number.isFinite(ps.position.y) ? ps.position.y : 0;
      group.position.set(ps.position.x, y, ps.position.z);
    }
    if (Number.isFinite(ps.yaw)) group.rotation.y = ps.yaw;

    const speed = currentSpeed();
    state.speed = speed;

    // Phase advances from distance travelled, not from time — that is what keeps
    // her feet planted at any speed instead of moonwalking as she slows down.
    state.phase += speed * STRIDE * step;

    aimMix = lerp(aimMix, state.aiming ? 1 : 0, damp(14, step));
    pose({ phase: state.phase });

    // Bob at twice the stride frequency: the body rises on each footfall.
    // Damped so it does not click on and off as she crosses walking pace.
    const bobTarget = speed > 0.2 ? Math.abs(Math.sin(state.phase)) * 0.035 : 0;
    bobY = lerp(bobY, bobTarget, damp(18, step));
    body.position.y = bobY;

    // A small forward lean that grows with speed: at a sprint the hips lead the
    // feet, which is what separates a run from a fast walk.
    const leanTarget = clamp(speed / 8.2, 0, 1) * 0.09;
    leanX = lerp(leanX, leanTarget, damp(8, step));
    hips.rotation.x = leanX;

    return state;
  }

  // Hidden until the first update resolves the player's real state: a figure
  // drawn at the origin for one frame is a visible bug in every screenshot.
  setVisible(false);
  pose({ phase: 0, aiming: false });

  return { group, pose, update, setVisible };
}
