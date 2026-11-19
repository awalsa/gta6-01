import * as THREE from 'three';
import { COLORS, WORLD } from './config.js';
import { clamp, smoothstep } from './mathutil.js';
import { boardwalkTexture, sandTexture } from './textures.js';

export function createBeach(scene) {
  const spanZ = WORLD.extent * 2;
  const beachWidth = WORLD.beachEnd - WORLD.beachStart;
  const beachCentreX = (WORLD.beachStart + WORLD.beachEnd) * 0.5;

  // --- Sand: a wide strip sloping gently down toward the sea ---
  const sandTex = sandTexture();
  sandTex.wrapS = THREE.RepeatWrapping;
  sandTex.wrapT = THREE.RepeatWrapping;
  sandTex.repeat.set(6, 24);

  const sandGeo = new THREE.PlaneGeometry(beachWidth, spanZ, 40, 24);
  sandGeo.rotateX(-Math.PI / 2);
  const pos = sandGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // 0 at the boardwalk edge, 1 at the waterline.
    const t = clamp((x + beachWidth / 2) / beachWidth, 0, 1);
    const drop = smoothstep(0, 1, t) * WORLD.beachDrop;
    const dune = Math.sin(x * 0.35 + z * 0.08) * 0.12 * (1 - t)
      + Math.sin(z * 0.22) * 0.08 * t;
    pos.setY(i, WORLD.groundY - drop + dune);
  }
  sandGeo.computeVertexNormals();

  const sandMat = new THREE.MeshStandardMaterial({
    map: sandTex,
    color: COLORS.sand,
    roughness: 1,
    metalness: 0,
  });
  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.position.set(beachCentreX, 0, 0);
  sand.receiveShadow = true;
  scene.add(sand);

  // --- Ocean: a broad sheet east of the sand, slightly below its edge ---
  const seaWidth = WORLD.extent * 1.2;
  const seaGeo = new THREE.PlaneGeometry(seaWidth, spanZ, 32, 16);
  seaGeo.rotateX(-Math.PI / 2);
  const seaMat = new THREE.MeshStandardMaterial({
    color: COLORS.water,
    roughness: 0.25,
    metalness: 0.05,
    transparent: true,
    opacity: 0.88,
  });
  const sea = new THREE.Mesh(seaGeo, seaMat);
  const seaBaseY = WORLD.groundY - WORLD.beachDrop - 0.25;
  sea.position.set(WORLD.beachEnd + seaWidth / 2 - 1, seaBaseY, 0);
  sea.receiveShadow = true;
  scene.add(sea);

  // --- Foam: a pale ribbon riding the waterline, sliding with the swell ---
  const foamGeo = new THREE.PlaneGeometry(1.6, spanZ, 1, 24);
  foamGeo.rotateX(-Math.PI / 2);
  const foamMat = new THREE.MeshStandardMaterial({
    color: 0xf4fbff,
    roughness: 0.6,
    metalness: 0,
    transparent: true,
    opacity: 0.55,
  });
  const foam = new THREE.Mesh(foamGeo, foamMat);
  foam.position.set(WORLD.beachEnd - 0.4, seaBaseY + 0.12, 0);
  foam.receiveShadow = true;
  scene.add(foam);

  // --- Boardwalk: raised timber deck along the western edge of the sand ---
  const deckTex = boardwalkTexture();
  deckTex.wrapS = THREE.RepeatWrapping;
  deckTex.wrapT = THREE.RepeatWrapping;
  deckTex.repeat.set(2, 40);

  const deckWidth = 5;
  const deckGeo = new THREE.BoxGeometry(deckWidth, 0.35, spanZ);
  const deckMat = new THREE.MeshStandardMaterial({
    map: deckTex,
    roughness: 0.9,
    metalness: 0,
  });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.set(WORLD.beachStart - deckWidth / 2 + 1, WORLD.groundY + 0.45, 0);
  deck.castShadow = true;
  deck.receiveShadow = true;
  scene.add(deck);

  // Support posts under the deck, spaced along its length.
  const postGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.9, 8);
  const postMat = new THREE.MeshStandardMaterial({
    color: COLORS.concrete,
    roughness: 0.95,
    metalness: 0,
  });
  const postCount = 24;
  const posts = new THREE.InstancedMesh(postGeo, postMat, postCount * 2);
  const dummy = new THREE.Object3D();
  let idx = 0;
  for (let i = 0; i < postCount; i++) {
    const z = -WORLD.extent + (i + 0.5) * (spanZ / postCount);
    for (const dx of [-deckWidth / 2 + 0.5, deckWidth / 2 - 0.5]) {
      dummy.position.set(deck.position.x + dx, WORLD.groundY - 0.05, z);
      dummy.updateMatrix();
      posts.setMatrixAt(idx++, dummy.matrix);
    }
  }
  posts.castShadow = true;
  scene.add(posts);

  // Low rail on the seaward side of the deck.
  const railGeo = new THREE.BoxGeometry(0.12, 0.12, spanZ);
  const railMat = new THREE.MeshStandardMaterial({
    color: COLORS.concrete,
    roughness: 0.85,
    metalness: 0,
  });
  const rail = new THREE.Mesh(railGeo, railMat);
  rail.position.set(
    deck.position.x + deckWidth / 2 - 0.3,
    WORLD.groundY + 1.35,
    0,
  );
  rail.castShadow = true;
  scene.add(rail);

  const railPostGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6);
  const railPosts = new THREE.InstancedMesh(railPostGeo, railMat, postCount);
  for (let i = 0; i < postCount; i++) {
    const z = -WORLD.extent + (i + 0.5) * (spanZ / postCount);
    dummy.position.set(rail.position.x, WORLD.groundY + 0.9, z);
    dummy.updateMatrix();
    railPosts.setMatrixAt(i, dummy.matrix);
  }
  scene.add(railPosts);

  // A few simple sun umbrellas dotted on the dry sand for scale.
  const umbrellaGroup = new THREE.Group();
  const canopyGeo = new THREE.ConeGeometry(1.6, 0.7, 8);
  const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6);
  const canopyColours = [0xe4572e, 0x2e86de, 0xf5c542];
  for (let i = 0; i < 3; i++) {
    const pole = new THREE.Mesh(
      poleGeo,
      new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 }),
    );
    const canopy = new THREE.Mesh(
      canopyGeo,
      new THREE.MeshStandardMaterial({
        color: canopyColours[i % canopyColours.length],
        roughness: 0.8,
      }),
    );
    canopy.position.y = 2.3;
    canopy.castShadow = true;
    const spot = new THREE.Group();
    spot.add(pole);
    spot.add(canopy);
    spot.position.set(
      WORLD.beachStart + 4 + i * 5,
      WORLD.groundY - WORLD.beachDrop * 0.25,
      -18 + i * 16,
    );
    umbrellaGroup.add(spot);
  }
  scene.add(umbrellaGroup);

  let elapsed = 0;

  function update(dt) {
    elapsed += dt;
    const safeDt = clamp(dt, 0, 0.1);

    // Gentle swell: the sea breathes up and down, the foam rides with it.
    const swell = Math.sin(elapsed * 0.8) * 0.09
      + Math.sin(elapsed * 0.53 + 1.3) * 0.05;
    sea.position.y = seaBaseY + swell;
    foam.position.y = seaBaseY + 0.12 + swell * 1.4;
    foam.position.x = WORLD.beachEnd - 0.4
      + Math.sin(elapsed * 0.6) * 0.5;

    // Slow ripple across the water surface via a subtle tilt.
    sea.rotation.z = Math.sin(elapsed * 0.45) * 0.004;

    // Foam fades in and out as each wave arrives and retreats.
    foamMat.opacity = 0.4 + 0.25 * smoothstep(-1, 1, Math.sin(elapsed * 0.6));

    void safeDt;
  }

  return { update };
}
