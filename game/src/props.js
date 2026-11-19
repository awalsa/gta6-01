// Street furniture, planting and the two landmarks that are not blocks.
//
// Draw calls are the budget here, not triangles. Every repeated object is one InstancedMesh
// with a shared geometry, so a hundred palms cost a handful of draw calls and a hundred
// railing posts cost one. Only the lighthouse and the hotel are individual meshes, built once.

import * as THREE from 'three';
import { WORLD, GRID } from './config.js';
import { ROAD_LINES } from './city.js';
import { createRandom, range, TAU } from './mathutil.js';

const HALF_ROAD = GRID.road / 2;

// Seafront geometry: the promenade is the paved strip just west of where the sand starts.
const PROMENADE_X = WORLD.beachStart - 6;
const RAIL_X = WORLD.beachStart - 0.6;
const PALM_ROW_X = WORLD.beachStart - 9;

// Long enough to cover the playable square: the railing and the palm row run its length.
const STRIP_Z = WORLD.extent - 12;

// Hand-placed landmarks. Their footprints are published in `obstacles`, because the city's
// collision set only knows about the block grid.
const LIGHTHOUSE = { x: WORLD.beachStart + 14, z: -132, radius: 4.6, height: 26 };
const HOTEL = { x: 68, z: -126, width: 34, depth: 24, height: 44 };

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

function flatMat(color, roughness = 0.85, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

// Instanced mesh with the bookkeeping that is easy to forget and silent when wrong.
function makeInstanced(geo, mat, count, { shadow = true } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  mesh.count = count;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  return mesh;
}

const placer = new THREE.Object3D();

function place(mesh, i, x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) {
  placer.position.set(x, y, z);
  placer.rotation.set(rx, ry, rz);
  placer.scale.set(sx, sy, sz);
  placer.updateMatrix();
  mesh.setMatrixAt(i, placer.matrix);
}

// A lamp head is a lit panel: the colour is emissive, not albedo, so at dusk it reads as a
// source, and the night pass raises `emissiveIntensity` on this one shared material.
function lampHeadMat() {
  return new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: 0xffdca0,
    emissiveIntensity: 0.55,
    roughness: 0.5,
    metalness: 0,
  });
}

// Painted canvas: alternating stripes drawn once into a texture, so a striped canopy is one
// draw call instead of a dozen boxes per stall.
function stripeCanvas(a = '#d9544f', b = '#f2e8d6') {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  const bands = 8;
  const w = canvas.width / bands;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 ? b : a;
    g.fillRect(i * w, 0, w, canvas.height);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Text on a plane, for the hotel sign. A canvas, because TextGeometry would pull in a font
// loader and another few hundred kilobytes of vendored code.
function signCanvas(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = '#12161c';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#ffe9b8';
  g.font = 'bold 72px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createProps(scene, handles) {
  const group = new THREE.Group();
  group.name = 'props';
  scene.add(group);

  const rng = createRandom(0x4d2a17);
  const obstacles = [];
  const lamps = [];

  const groundAt = (x, z) => (handles?.groundHeight ? handles.groundHeight(x, z) : WORLD.groundY);
  const clearOfHotel = (x, z, pad = 6) =>
    !(
      x > HOTEL.x - HOTEL.width / 2 - pad &&
      x < HOTEL.x + HOTEL.width / 2 + pad &&
      z > HOTEL.z - HOTEL.depth / 2 - pad &&
      z < HOTEL.z + HOTEL.depth / 2 + pad
    );
  const clearOfLighthouse = (x, z, pad = 4) =>
    Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) > LIGHTHOUSE.radius + pad;

  // ------------------------------------------------------------- palm layout
  const palms = [];
  const PALM_BUDGET = 96;

  // Seafront row: evenly spaced with a little jitter, the way a planted avenue is surveyed.
  for (let z = -STRIP_Z; z <= STRIP_Z; z += 13.5) {
    const x = PALM_ROW_X + range(rng, -0.6, 0.6);
    const zz = z + range(rng, -1.6, 1.6);
    if (clearOfHotel(x, zz) && clearOfLighthouse(x, zz)) palms.push({ x, z: zz });
  }

  // Avenues: every other road line, palms set back from the kerb on both sides so the rows
  // frame the carriageway instead of standing in it. Nothing is planted inside a block: the
  // city generator owns those, and a palm through a shopfront is worse than a gap in the row.
  for (let li = 0; li < ROAD_LINES.length; li += 2) {
    const line = ROAD_LINES[li];
    for (const axis of ['x', 'z']) {
      for (const side of [-1, 1]) {
        const off = HALF_ROAD + 2.6;
        for (let t = -STRIP_Z + 6; t <= STRIP_Z - 6; t += 26) {
          const x = axis === 'z' ? line + side * off + range(rng, -1.2, 1.2) : t + range(rng, -1.2, 1.2);
          const z = axis === 'z' ? t + range(rng, -1.2, 1.2) : line + side * off + range(rng, -1.2, 1.2);
          if (Math.abs(x) > WORLD.extent - 8 || Math.abs(z) > WORLD.extent - 8) continue;
          if (!clearOfHotel(x, z) || !clearOfLighthouse(x, z)) continue;
          if (handles?.insideBuilding && handles.insideBuilding(x, z, 1.2)) continue;
          palms.push({ x, z });
        }
      }
    }
  }
  // Trim to the instance budget; rows are ordered so the far avenues drop first, which are
  // the ones the camera rarely reaches.
  palms.length = Math.min(palms.length, PALM_BUDGET);

  // -------------------------------------------------------------- palm build
  // Three tapered trunk segments rather than one cylinder: a palm trunk is not a constant
  // radius pole, and the taper is most of what makes the silhouette read at a distance.
  const trunkGeos = [
    new THREE.CylinderGeometry(0.26, 0.32, 1, 7, 1),
    new THREE.CylinderGeometry(0.19, 0.26, 1, 7, 1),
    new THREE.CylinderGeometry(0.14, 0.19, 1, 7, 1),
  ];
  // A flattened low-segment cone is a frond: cheap, and from the street it has the right
  // ragged edge where a real palm leaf is cut by the sky.
  const frondGeo = new THREE.ConeGeometry(0.46, 3.6, 5, 1, true);
  frondGeo.translate(0, 1.8, 0);
  frondGeo.scale(1, 1, 0.28);

  const barkMat = flatMat(0x6b5638, 0.95);
  const frondMat = new THREE.MeshStandardMaterial({
    color: 0x4a6b32,
    roughness: 0.8,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const trunkMeshes = trunkGeos.map((geo) => makeInstanced(geo, barkMat, palms.length));
  const crownMesh = makeInstanced(frondGeo, frondMat, palms.length * 9, { shadow: false });

  const tiltQ = new THREE.Quaternion();
  const spinQ = new THREE.Quaternion();
  const combinedQ = new THREE.Quaternion();
  let frondCount = 0;

  for (let i = 0; i < palms.length; i++) {
    const palm = palms[i];
    const height = range(rng, 6.5, 10.5);
    const scale = range(rng, 0.86, 1.18);
    const leanX = range(rng, -0.09, 0.09);
    const leanZ = range(rng, -0.09, 0.09);
    const yaw = rng() * TAU;
    const gy = groundAt(palm.x, palm.z);
    palm.height = height;

    const segH = height / 3;
    for (let s = 0; s < 3; s++) {
      const y = segH * (s + 0.5);
      // Lean accumulates along the trunk, so the crown offset grows quadratically while the
      // base stays planted where the row was surveyed.
      const bend = (y / height) * (y / height) * height;
      place(trunkMeshes[s], i, palm.x + leanX * bend, gy + y, palm.z + leanZ * bend, scale, segH, scale, yaw, leanZ * 0.22, -leanX * 0.22);
    }

    const crownX = palm.x + leanX * height;
    const crownZ = palm.z + leanZ * height;
    const crownY = gy + height;

    for (let f = 0; f < 9; f++) {
      const angle = (f / 9) * TAU + range(rng, -0.16, 0.16);
      const droop = range(rng, 0.18, 0.62);
      const len = range(rng, 0.86, 1.24) * scale;
      // Cone apex points +Y; a PI/2 turn about X lays it along +Z, and the extra droop tips
      // the tip below the base.
      tiltQ.setFromAxisAngle(AXIS_X, Math.PI * 0.5 + droop);
      spinQ.setFromAxisAngle(AXIS_Y, angle);
      combinedQ.copy(spinQ).multiply(tiltQ);
      // Push the blade out from the crown by about half its length so the base sits at the
      // trunk top rather than the middle of the leaf.
      const out = 1.8 * len * 0.62;
      placer.position.set(crownX + Math.sin(angle) * out, crownY + 0.12, crownZ + Math.cos(angle) * out);
      placer.quaternion.copy(combinedQ);
      placer.scale.set(len * scale, len * scale, len * scale);
      placer.updateMatrix();
      crownMesh.setMatrixAt(frondCount++, placer.matrix);
    }
  }
  trunkMeshes.forEach((m) => {
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
  });
  crownMesh.count = frondCount;
  crownMesh.instanceMatrix.needsUpdate = true;
  group.add(crownMesh);

  // ------------------------------------------------------------- street lamps
  const POLE_H = 5.8;
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 1, 6, 1);
  // Arm geometry points along local -X from the pole, so one yaw aims it at the carriageway.
  const armGeo = new THREE.BoxGeometry(1.5, 0.1, 0.1);
  armGeo.translate(-0.75, 0, 0);
  const headGeo = new THREE.BoxGeometry(0.46, 0.16, 0.3);
  const poleMat = flatMat(0x2b2f33, 0.6, 0.4);
  const headMat = lampHeadMat();

  const lampSpots = [];
  const LAMP_STEP = 30;

  // Lamps alternate kerbs along each street, so one side is lit and the other is not — it
  // reads better than a symmetric avenue under a low sun. Yaw aims -X at the road: 0 east of
  // a north-south street, PI west of it, +/-PI/2 for east-west streets.
  for (let li = 0; li < ROAD_LINES.length; li++) {
    const line = ROAD_LINES[li];
    let flip = li % 2 === 0;
    for (let t = -STRIP_Z + 8; t <= STRIP_Z - 8; t += LAMP_STEP) {
      const sideX = flip ? 1 : -1;
      lampSpots.push({ x: line + sideX * (HALF_ROAD + 1.1), z: t, yaw: sideX > 0 ? 0 : Math.PI });
      const sideZ = flip ? -1 : 1;
      lampSpots.push({ x: t, z: line + sideZ * (HALF_ROAD + 1.1), yaw: sideZ > 0 ? -Math.PI / 2 : Math.PI / 2 });
      flip = !flip;
    }
  }

  // Promenade lamps lean over the walkway, not the sand, so the railing stays a silhouette
  // against the water instead of being lit from the sea side.
  for (let z = -STRIP_Z + 10; z <= STRIP_Z - 10; z += 22) {
    lampSpots.push({ x: RAIL_X - 2.4, z, yaw: 0 });
  }

  const poles = makeInstanced(poleGeo, poleMat, lampSpots.length);
  const arms = makeInstanced(armGeo, poleMat, lampSpots.length);
  const heads = makeInstanced(headGeo, headMat, lampSpots.length, { shadow: false });

  for (let i = 0; i < lampSpots.length; i++) {
    const spot = lampSpots[i];
    const gy = groundAt(spot.x, spot.z);
    place(poles, i, spot.x, gy + POLE_H / 2, spot.z, 1, POLE_H, 1);
    place(arms, i, spot.x, gy + POLE_H - 0.28, spot.z, 1, 1, 1, spot.yaw);
    const headX = spot.x + Math.cos(spot.yaw) * -1.42;
    const headZ = spot.z + Math.sin(spot.yaw) * 1.42;
    place(heads, i, headX, gy + POLE_H - 0.36, headZ, 1, 1, 1, spot.yaw);
    // The night pass reads these: raising the emissive on the shared material lights every head.
    lamps.push({ x: headX, y: gy + POLE_H - 0.36, z: headZ });
  }
  poles.instanceMatrix.needsUpdate = true;
  arms.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  group.add(poles, arms, heads);

  // -------------------------------------------------------- promenade railing
  // Posts every 3 m plus two continuous rails. Long single boxes: a hundred short segments
  // would be a hundred draw calls for no visible gain at street level.
  const POST_STEP = 3;
  const postCount = Math.floor((STRIP_Z * 2) / POST_STEP);
  const railMat = flatMat(0x3a3f42, 0.55, 0.5);
  const posts = makeInstanced(new THREE.BoxGeometry(0.07, 1.05, 0.07), railMat, postCount);
  for (let i = 0; i < postCount; i++) {
    place(posts, i, RAIL_X, WORLD.groundY + 0.53, -STRIP_Z + i * POST_STEP, 1, 1, 1);
  }
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);
  for (const y of [1.0, 0.55]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, STRIP_Z * 2), railMat);
    rail.position.set(RAIL_X, WORLD.groundY + y, 0);
    rail.castShadow = true;
    group.add(rail);
  }

  // ------------------------------------------------------ benches, bins, crates
  const woodMat = flatMat(0x6a5a44, 0.9);
  const metalMat = flatMat(0x33383c, 0.55, 0.45);

  const benchSpots = [];
  for (let z = -STRIP_Z + 14; z <= STRIP_Z - 14; z += 17) {
    benchSpots.push({ x: RAIL_X - 3.6, z, ry: -Math.PI / 2 });
    benchSpots.push({ x: PALM_ROW_X - 4.2, z: z + 8, ry: Math.PI / 2 });
  }

  const seats = makeInstanced(new THREE.BoxGeometry(1.9, 0.09, 0.52), woodMat, benchSpots.length);
  const backs = makeInstanced(new THREE.BoxGeometry(1.9, 0.42, 0.09), woodMat, benchSpots.length);
  const legs = makeInstanced(new THREE.BoxGeometry(0.08, 0.44, 0.44), metalMat, benchSpots.length * 2);

  for (let i = 0; i < benchSpots.length; i++) {
    const b = benchSpots[i];
    place(seats, i, b.x, WORLD.groundY + 0.45, b.z, 1, 1, 1, b.ry);
    // The back rakes away from the seat by a touch: a flat plank back reads as a shelf.
    const backX = b.x - Math.sin(b.ry) * 0.24;
    const backZ = b.z - Math.cos(b.ry) * 0.24;
    place(backs, i, backX, WORLD.groundY + 0.72, backZ, 1, 1, 1, b.ry);
    const legX = Math.cos(b.ry) * 0.72;
    const legZ = -Math.sin(b.ry) * 0.72;
    place(legs, i * 2, b.x + legX, WORLD.groundY + 0.22, b.z + legZ, 1, 1, 1, b.ry);
    place(legs, i * 2 + 1, b.x - legX, WORLD.groundY + 0.22, b.z - legZ, 1, 1, 1, b.ry);
  }
  seats.instanceMatrix.needsUpdate = true;
  backs.instanceMatrix.needsUpdate = true;
  legs.instanceMatrix.needsUpdate = true;
  group.add(seats, backs, legs);

  // A bin beside every third bench, where the eye expects one.
  const binSpots = benchSpots.filter((_, i) => i % 3 === 0).map((b) => ({ x: b.x + 1.4, z: b.z + 1.1 }));
  const bins = makeInstanced(new THREE.CylinderGeometry(0.3, 0.26, 0.92, 8), metalMat, binSpots.length);
  for (let i = 0; i < binSpots.length; i++) {
    place(bins, i, binSpots[i].x, WORLD.groundY + 0.46, binSpots[i].z, 1, 1, 1);
  }
  bins.instanceMatrix.needsUpdate = true;
  group.add(bins);

  // ------------------------------------------------------------ market stalls
  const stallSpots = [];
  for (let i = 0; i < 6; i++) {
    stallSpots.push({
      x: PROMENADE_X - 1.5 + range(rng, -1.2, 1.2),
      z: -STRIP_Z * 0.55 + i * 34 + range(rng, -2, 2),
      ry: -Math.PI / 2 + range(rng, -0.12, 0.12),
    });
  }

  const canopyMat = new THREE.MeshStandardMaterial({
    map: stripeCanvas('#c8493f', '#f2e8d6'),
    roughness: 0.8,
    side: THREE.DoubleSide,
  });
  const canopies = makeInstanced(new THREE.BoxGeometry(3.4, 0.08, 2.1), canopyMat, stallSpots.length);
  const tables = makeInstanced(new THREE.BoxGeometry(3.2, 0.08, 1.8), woodMat, stallSpots.length);
  const stallPosts = makeInstanced(new THREE.BoxGeometry(0.08, 2.4, 0.08), metalMat, stallSpots.length * 4);

  for (let i = 0; i < stallSpots.length; i++) {
    const s = stallSpots[i];
    place(canopies, i, s.x, WORLD.groundY + 2.42, s.z, 1, 1, 1, s.ry);
    place(tables, i, s.x, WORLD.groundY + 0.86, s.z, 1, 1, 1, s.ry);
    for (let p = 0; p < 4; p++) {
      const sx = p % 2 ? 1 : -1;
      const sz = p < 2 ? -1 : 1;
      const px = Math.cos(s.ry) * sx * 1.55 + Math.sin(s.ry) * sz * 0.92;
      const pz = -Math.sin(s.ry) * sx * 1.55 + Math.cos(s.ry) * sz * 0.92;
      place(stallPosts, i * 4 + p, s.x + px, WORLD.groundY + 1.2, s.z + pz, 1, 1, 1, s.ry);
    }
  }
  canopies.instanceMatrix.needsUpdate = true;
  tables.instanceMatrix.needsUpdate = true;
  stallPosts.instanceMatrix.needsUpdate = true;
  group.add(canopies, tables, stallPosts);

  // Crates stacked around the stalls: a market with nothing on the ground looks like a stage set.
  const crateSpots = [];
  for (let i = 0; i < 14; i++) {
    const s = stallSpots[i % stallSpots.length];
    crateSpots.push({
      x: s.x + range(rng, -1.6, 1.6),
      z: s.z + range(rng, -1.9, 1.9),
      ry: rng() * TAU,
      y: rng() < 0.3 ? 0.82 : 0.42,
    });
  }
  const crates = makeInstanced(new THREE.BoxGeometry(0.78, 0.78, 0.78), flatMat(0x8a6b45, 0.95), crateSpots.length);
  for (let i = 0; i < crateSpots.length; i++) {
    const c = crateSpots[i];
    place(crates, i, c.x, WORLD.groundY + c.y, c.z, 1, 1, 1, c.ry);
  }
  crates.instanceMatrix.needsUpdate = true;
  group.add(crates);

  // --------------------------------------------------------------- lighthouse
  // Its own group: a landmark with a rotating lamp the frame loop may drive, not instanced
  // furniture. Two stacked tapered drums let the red band be real geometry, not a texture
  // stretched by the taper.
  const lighthouse = new THREE.Group();
  lighthouse.name = 'lighthouse';
  lighthouse.position.set(LIGHTHOUSE.x, 0, LIGHTHOUSE.z);
  lighthouse.x = LIGHTHOUSE.x;
  lighthouse.z = LIGHTHOUSE.z;
  lighthouse.height = LIGHTHOUSE.height;

  const rockMat = flatMat(0x5c5750, 0.98);
  const towerMat = flatMat(0xe6e0d2, 0.8);
  const bandMat = flatMat(0xb0453f, 0.75);
  const ironMat = flatMat(0x2c3136, 0.5, 0.6);

  const rock = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 3.2, 10), rockMat);
  rock.position.y = -0.6;
  rock.receiveShadow = true;
  lighthouse.add(rock);

  const lowerTower = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 4.0, 14, 12), towerMat);
  lowerTower.position.y = 8.4;
  lowerTower.castShadow = true;
  lowerTower.receiveShadow = true;
  lighthouse.add(lowerTower);

  const band = new THREE.Mesh(new THREE.CylinderGeometry(3.02, 3.1, 2.6, 12), bandMat);
  band.position.y = 16.6;
  band.castShadow = true;
  lighthouse.add(band);

  const upperTower = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.9, 6.4, 12), towerMat);
  upperTower.position.y = 21.1;
  upperTower.castShadow = true;
  lighthouse.add(upperTower);

  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.34, 14), ironMat);
  gallery.position.y = 24.4;
  gallery.castShadow = true;
  lighthouse.add(gallery);

  // Lantern glass is emissive so it stays a bright dot on the horizon after sunset — the only
  // thing that makes the tower silhouette useful at night.
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xffeecc,
    emissive: 0xffcf87,
    emissiveIntensity: 2.2,
    transparent: true,
    opacity: 0.9,
    roughness: 0.3,
  });
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 2.3, 12), lanternMat);
  lantern.position.y = 25.7;
  lighthouse.add(lantern);
  lighthouse.lantern = lantern;
  lighthouse.beamY = 25.7;

  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.95, 1.5, 12), bandMat);
  cap.position.y = 27.6;
  cap.castShadow = true;
  lighthouse.add(cap);

  // Railing hoop on the gallery: an open deck with no rail reads as a cut-off cylinder.
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(3.05, 0.045, 4, 16), ironMat);
  hoop.rotation.x = Math.PI / 2;
  hoop.position.y = 25.0;
  lighthouse.add(hoop);

  group.add(lighthouse);

  // ------------------------------------------------------------------- hotel
  const hotel = new THREE.Group();
  hotel.name = 'hotel';
  hotel.position.set(HOTEL.x, 0, HOTEL.z);
  hotel.x = HOTEL.x;
  hotel.z = HOTEL.z;
  hotel.width = HOTEL.width;
  hotel.depth = HOTEL.depth;
  hotel.height = HOTEL.height;

  const main = new THREE.Mesh(
    new THREE.BoxGeometry(HOTEL.width, HOTEL.height, HOTEL.depth),
    flatMat(0xd9cbb4, 0.9)
  );
  main.position.y = HOTEL.height / 2;
  main.castShadow = true;
  main.receiveShadow = true;
  hotel.add(main);

  // A setback wing breaks the single-cube silhouette every procedural block shares. It sits
  // on the rear (-Z) face so the promenade elevation stays clean for the sign and the canopy.
  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(HOTEL.width * 0.42, HOTEL.height * 0.55, HOTEL.depth + 6),
    flatMat(0xc4b6a2, 0.92)
  );
  wing.position.set(-HOTEL.width * 0.33, HOTEL.height * 0.275, -4);
  wing.castShadow = true;
  wing.receiveShadow = true;
  hotel.add(wing);

  // Window bands: thin dark boxes, not a texture, so the facade stays crisp when the camera
  // gets close on the promenade. Local coordinates — the hotel group is already positioned.
  const glassMat = flatMat(0x2a3a44, 0.25, 0.7);
  for (let i = 0; i < 12; i++) {
    const y = 4 + i * 3.2;
    if (y > HOTEL.height - 2) break;
    const bandMesh = new THREE.Mesh(new THREE.BoxGeometry(HOTEL.width + 0.12, 0.9, 0.16), glassMat);
    bandMesh.position.set(0, y, HOTEL.depth / 2 + 0.02);
    hotel.add(bandMesh);
  }

  // Sign over the entrance, facing the promenade (+Z). The emissive map is the canvas itself,
  // so the letters glow after dark.
  const signMat = new THREE.MeshStandardMaterial({
    map: signCanvas('HOTEL AZUL'),
    roughness: 0.6,
  });
  signMat.emissive = new THREE.Color(0xffffff);
  signMat.emissiveMap = signMat.map;
  signMat.emissiveIntensity = 0.9;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), signMat);
  sign.position.set(0, 8.6, HOTEL.depth / 2 + 0.12);
  hotel.add(sign);
  hotel.sign = sign;

  // Canopy over the doors: the detail that makes the block read as a hotel, not an office.
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(9, 0.28, 3.4), bandMat);
  canopy.position.set(0, 4.6, HOTEL.depth / 2 + 1.5);
  canopy.castShadow = true;
  hotel.add(canopy);

  group.add(hotel);

  // -------------------------------------------------------------- footprints
  // The city's collision set is generated from the block grid, and these two were placed by
  // hand on the promenade, so their footprints have to be handed over explicitly or the
  // player walks straight through a lighthouse.
  obstacles.push({
    minX: LIGHTHOUSE.x - LIGHTHOUSE.radius,
    maxX: LIGHTHOUSE.x + LIGHTHOUSE.radius,
    minZ: LIGHTHOUSE.z - LIGHTHOUSE.radius,
    maxZ: LIGHTHOUSE.z + LIGHTHOUSE.radius,
    height: LIGHTHOUSE.height,
  });
  obstacles.push({
    minX: HOTEL.x - HOTEL.width / 2,
    maxX: HOTEL.x + HOTEL.width / 2,
    minZ: HOTEL.z - HOTEL.depth / 2 - 3,
    maxZ: HOTEL.z + HOTEL.depth / 2,
    height: HOTEL.height,
  });

  return {
    group,
    lamps,
    /** Shared by every lamp head, so a night pass is one material write, not N mesh writes. */
    lampMaterial: headMat,
    lighthouse,
    hotel,
    obstacles,
    palms,
  };
}
