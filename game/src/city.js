// Puerto Fuego street grid.
//
// The whole city is derived from GRID and WORLD in config.js: move a constant there and the
// asphalt, the kerbs, the buildings and the collision boxes all move together. Nothing in here
// is placed by hand except the sizes of the paint.
//
// Axis: -Z is north along the shore, +X is east toward the water, so the city sits west
// (negative X) and the seafront band is the last column of blocks before the sand.

import * as THREE from 'three';
import { GRID, WORLD } from './config.js';
import { createRandom, range, rangeInt } from './mathutil.js';
import { asphaltTexture, concreteTexture, facadeTexture } from './textures.js';

// Road centre lines sit one pitch apart, where pitch is block + road: the blocks live between
// the lines, so the pitch has to include both. Lines run from minLine to maxLine inclusive.
const PITCH = GRID.block + GRID.road;
export const ROAD_LINES = [];
for (let i = GRID.minLine; i <= GRID.maxLine; i++) ROAD_LINES.push(i * PITCH);

const HALF_ROAD = GRID.road / 2;

// The seafront column of blocks ends five metres short of the sand line, so no slab overhangs
// the seawall. Older configs named this edge explicitly; fall back to the sand line if absent.
const LAND_EDGE = (WORLD.mainlandEdge ?? WORLD.beachStart) - 5;

// Centre-line dashes: one dash every 7 m, each 3.4 m long, skipped inside junction boxes.
const DASH_STEP = 7;
const DASH_LEN = 3.4;
const DASH_W = 0.16;
// Crossings sit just clear of the junction, stripes running along the direction of travel.
const CROSS_CLEAR = HALF_ROAD + 2;
const CROSS_WIDTH = GRID.road - 1.2;
const STRIPE_W = 0.45;
const STRIPE_STEP = 0.9;
const STRIPE_LEN = 3.6;

// Texture tiling: one facade tile spans 12 m of wall, one concrete tile 8 m of slab.
const FACADE_SPAN = 12;
const CONCRETE_SPAN = 8;

function clamp01(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Stretch a box's UVs per face so a texture repeats at a fixed world size instead of smearing
// across whatever the box happens to measure. BoxGeometry orders faces +X, -X, +Y, -Y, +Z, -Z.
function tileBoxUVs(geo, w, h, d, tileW, tileH) {
  const uv = geo.attributes.uv;
  const faceSpans = [
    [d, h], [d, h],
    [w, d], [w, d],
    [w, h], [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const uRep = faceSpans[f][0] / tileW;
    const vRep = faceSpans[f][1] / tileH;
    for (let v = 0; v < 4; v++) {
      const idx = f * 4 + v;
      uv.setXY(idx, uv.getX(idx) * uRep, uv.getY(idx) * vRep);
    }
  }
  uv.needsUpdate = true;
}

export function createCity(scene) {
  const group = new THREE.Group();
  group.name = 'city';
  scene.add(group);

  const rng = createRandom(0x5eed01);
  const buildings = [];
  const blockCentres = [];
  const blockRects = [];

  // ---------------------------------------------------------- ground plane
  // One asphalt sheet under everything, 640 m across, tiled every 4 m. The slabs and paint sit
  // a few millimetres above it, so nothing here is ever coplanar with it.
  const asphalt = asphaltTexture();
  asphalt.repeat.set(160, 160);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.extent * 2, WORLD.extent * 2),
    new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.97, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = WORLD.groundY;
  ground.receiveShadow = true;
  group.add(ground);

  // -------------------------------------------------------------- materials
  const concrete = concreteTexture();
  const slabMat = new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.92, metalness: 0 });
  const facadeMats = [0, 1, 2, 3].map(
    (v) => new THREE.MeshStandardMaterial({ map: facadeTexture(`facade${v}`, v), roughness: 0.84, metalness: 0.03 })
  );
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a453f, roughness: 0.95, metalness: 0 });
  const paintMat = new THREE.MeshStandardMaterial({
    color: 0xe8e6dc,
    roughness: 0.8,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  // Every flat marking and every roof cap is a scaled unit box through one instanced mesh.
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const placer = new THREE.Object3D();
  function scatter(list, mat, shadows) {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(unitBox, mat, list.length);
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      placer.position.set(t.x, t.y, t.z);
      placer.rotation.set(0, t.ry || 0, 0);
      placer.scale.set(t.sx, t.sy, t.sz);
      placer.updateMatrix();
      mesh.setMatrixAt(i, placer.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------- blocks
  // Cell edges are the road lines plus the seafront band; each cell's block is the cell minus
  // half a road on every side, which is what leaves GRID.block metres of buildable ground.
  const edgesX = [...ROAD_LINES, LAND_EDGE];
  const edgesZ = [...ROAD_LINES, LAND_EDGE];
  const dashes = [];
  const crossings = [];
  const roofCaps = [];

  for (let ix = 0; ix < edgesX.length - 1; ix++) {
    for (let iz = 0; iz < edgesZ.length - 1; iz++) {
      const minX = edgesX[ix] + HALF_ROAD;
      const maxX = edgesX[ix + 1] - HALF_ROAD;
      const minZ = edgesZ[iz] + HALF_ROAD;
      const maxZ = edgesZ[iz + 1] - HALF_ROAD;
      const w = maxX - minX;
      const d = maxZ - minZ;
      if (w < 8 || d < 8) continue;

      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      blockRects.push({ minX, maxX, minZ, maxZ });
      blockCentres.push({ x: cx, z: cz, width: w, depth: d });

      // Kerb slab: fills the block exactly, its edge face forming the kerb against the asphalt.
      const slabGeo = new THREE.BoxGeometry(w, WORLD.kerb, d);
      tileBoxUVs(slabGeo, w, WORLD.kerb, d, CONCRETE_SPAN, CONCRETE_SPAN);
      const slab = new THREE.Mesh(slabGeo, slabMat);
      slab.position.set(cx, WORLD.kerb / 2, cz);
      slab.receiveShadow = true;
      group.add(slab);

      // Buildings sit in equal slots along the block's long side, one to three per block
      // depending on area, each inset randomly inside its slot so footprints never touch.
      const longSide = w >= d;
      const run = longSide ? w : d;
      const cross = longSide ? d : w;
      const count = clamp01(Math.floor((w * d) / 300), 1, 3);
      const slotLen = run / count;
      for (let b = 0; b < count; b++) {
        const slotBase = (longSide ? minX : minZ) + slotLen * b;
        const footLen = slotLen * range(rng, 0.6, 0.92);
        const footCross = cross * range(rng, 0.55, 0.9);
        const offLen = (slotLen - footLen) * rng();
        const offCross = (cross - footCross) * rng();
        const bx = longSide ? slotBase + offLen + footLen / 2 : minX + offCross + footCross / 2;
        const bz = longSide ? minZ + offCross + footCross / 2 : slotBase + offLen + footLen / 2;
        const bw = longSide ? footLen : footCross;
        const bd = longSide ? footCross : footLen;
        const h = range(rng, 8, 34);

        const bodyGeo = new THREE.BoxGeometry(bw, h, bd);
        tileBoxUVs(bodyGeo, bw, h, bd, FACADE_SPAN, FACADE_SPAN);
        const body = new THREE.Mesh(bodyGeo, facadeMats[rangeInt(rng, 0, facadeMats.length - 1)]);
        body.position.set(bx, WORLD.kerb + h / 2, bz);
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        // Cornice cap, slightly oversized, so the roofline reads against the sky.
        roofCaps.push({ x: bx, y: WORLD.kerb + h + 0.2, z: bz, sx: bw + 0.6, sy: 0.6, sz: bd + 0.6 });
        buildings.push({
          minX: bx - bw / 2,
          maxX: bx + bw / 2,
          minZ: bz - bd / 2,
          maxZ: bz + bd / 2,
          height: WORLD.kerb + h,
        });
      }
    }
  }

  // ------------------------------------------------------- centre-line dashes
  // Both axes share one pass. A dash is dropped when it would fall inside a junction box.
  const gridMin = edgesX[0];
  const gridMax = edgesX[edgesX.length - 1];
  for (const line of ROAD_LINES) {
    for (let t = gridMin; t <= gridMax; t += DASH_STEP) {
      let insideJunction = false;
      for (const cross of ROAD_LINES) {
        if (Math.abs(t - cross) < HALF_ROAD + DASH_LEN) {
          insideJunction = true;
          break;
        }
      }
      if (insideJunction) continue;
      const mid = t + DASH_LEN / 2;
      if (mid > gridMax) continue;
      dashes.push({ x: line, y: 0.008, z: mid, sx: DASH_W, sy: 0.016, sz: DASH_LEN });
      dashes.push({ x: mid, y: 0.008, z: line, sx: DASH_W, sy: 0.016, sz: DASH_LEN, ry: Math.PI / 2 });
    }
  }
  scatter(dashes, paintMat, false);

  // -------------------------------------------------------------- crossings
  // At every junction, four approaches (north, south, east, west); stripes run along the
  // direction of travel, so the two arms of a crossing are perpendicular sets of bars.
  for (const lx of ROAD_LINES) {
    for (const lz of ROAD_LINES) {
      for (const side of [-1, 1]) {
        const zc = lz + side * CROSS_CLEAR;
        const xc = lx + side * CROSS_CLEAR;
        for (let o = -CROSS_WIDTH / 2 + STRIPE_W / 2; o <= CROSS_WIDTH / 2 - STRIPE_W / 2 + 1e-6; o += STRIPE_STEP) {
          crossings.push({ x: lx + o, y: 0.006, z: zc, sx: STRIPE_W, sy: 0.012, sz: STRIPE_LEN });
          crossings.push({ x: xc, y: 0.006, z: lz + o, sx: STRIPE_W, sy: 0.012, sz: STRIPE_LEN, ry: Math.PI / 2 });
        }
      }
    }
  }
  scatter(crossings, paintMat, false);
  scatter(roofCaps, roofMat, true);

  // -------------------------------------------------------------- predicates
  // Collision and placement helpers other systems build on. `buildings` doubles as the
  // obstacle list: addObstacles appends hand-placed footprints (landmarks, props) to it.
  function insideBuilding(x, z, margin = 0) {
    for (const b of buildings) {
      if (x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin) return true;
    }
    return false;
  }

  function addObstacles(list) {
    for (const item of list) {
      if (item.minX !== undefined) {
        buildings.push({ minX: item.minX, maxX: item.maxX, minZ: item.minZ, maxZ: item.maxZ, height: item.height ?? 10 });
      } else {
        buildings.push({
          minX: item.x - item.width / 2,
          maxX: item.x + item.width / 2,
          minZ: item.z - item.depth / 2,
          maxZ: item.z + item.depth / 2,
          height: item.height ?? 10,
        });
      }
    }
  }

  function onRoad(x, z) {
    for (const line of ROAD_LINES) {
      if (Math.abs(x - line) <= HALF_ROAD) return true;
      if (Math.abs(z - line) <= HALF_ROAD) return true;
    }
    return false;
  }

  function groundHeight(x, z) {
    for (const b of blockRects) {
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return WORLD.kerb;
    }
    return WORLD.groundY;
  }

  function nearestLine(v) {
    let best = ROAD_LINES[0];
    let bestGap = Math.abs(v - best);
    for (let i = 1; i < ROAD_LINES.length; i++) {
      const gap = Math.abs(v - ROAD_LINES[i]);
      if (gap < bestGap) {
        bestGap = gap;
        best = ROAD_LINES[i];
      }
    }
    return best;
  }

  return {
    group,
    buildings,
    blockCentres,
    roadLines: ROAD_LINES,
    addObstacles,
    groundHeight,
    onRoad,
    insideBuilding,
    nearestLine,
  };
}
