// The shoreline east of the city: boardwalk, seawall, sand and open water.
//
// Bands sit below y = 0 on purpose (WORLD.beachDrop is -1.35): the city's asphalt plane lies
// exactly at y = 0, and anything authored at that height shimmers against it at grazing
// angles. Only the boardwalk keeps promenade height, with a small lip so it never sits
// coplanar on a slab.

import * as THREE from 'three';
import { COLORS, WORLD } from './config.js';
import { clamp, smoothstep } from './mathutil.js';
import { boardwalkTexture, sandTexture } from './textures.js';

// WORLD.extent is a radius, not a width: the shore runs the full -extent..+extent span.
const EDGE = WORLD.extent;
const SPAN = EDGE * 2;

const SAND_X0 = WORLD.beachStart; // 86: inland edge, buried under the seawall
const SAND_X1 = WORLD.beachEnd; // 128: where the surf takes over
const SAND_W = SAND_X1 - SAND_X0;
const SAND_Y = WORLD.beachDrop; // -1.35: one step down from the promenade

const DECK_W = 7;
const DECK_LIP = 0.035;
const DECK_TOP = WORLD.kerb + DECK_LIP;

const WALL_T = 1.4;
const WALL_TOP = WORLD.kerb;
const WALL_BOTTOM = SAND_Y - 0.1; // sunk into the sand so the wall base never z-fights it

// Sea plane sits 27 cm under the sand: the summed wave crest peaks at about +0.19, so the surf
// can never poke through the beach, and the water can run inland underneath the sand with no seam.
const WATER_Y = SAND_Y - 0.27;
const SEA_X0 = 96;

// Reused each frame by the fog sync below; kept out here so update() allocates nothing.
const warmSun = new THREE.Color(0xffe0b0);

// Clone a cached canvas texture so this module's repeat stays independent of other users.
function repeatTex(texture, rx, ry) {
  const t = texture.clone();
  t.needsUpdate = true;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}

const WATER_VERT = /* glsl */ `
  uniform float uTime;

  varying vec3 vWorld;
  varying float vWave;

  void main() {
    vec3 p = position;

    // Two overlapping swells at different wavelengths and drift speeds. One sine alone lines
    // its crests into a visible grid, which reads as a pool, not the sea.
    float w1 = sin(p.x * 0.19 + uTime * 0.9) * 0.11;
    float w2 = sin(p.z * 0.07 - uTime * 1.2 + p.x * 0.05) * 0.08;

    p.y += w1 + w2;
    vWave = w1 + w2;

    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSunColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uLight;

  varying vec3 vWorld;
  varying float vWave;

  void main() {
    // Wave height picks the colour: troughs deep teal, crests pale and sky-lit.
    float crest = smoothstep(-0.15, 0.17, vWave);
    vec3 col = mix(uDeep, uShallow, crest);

    // The sea is lit by the sky, not by itself: at night the graded light collapses toward
    // black instead of leaving a glowing teal sheet in a dark world.
    col = mix(uFogColor * 0.18, col, uLight);

    // Fine detail fades with distance: at 300 m each ripple is a couple of pixels and aliases
    // into moire, while the far water is fog-washed anyway.
    float dist = length(cameraPosition - vWorld);
    float detail = 1.0 - smoothstep(90.0, 320.0, dist);

    // A broad sun streak sliding with the surface, plus a tighter sparkle term.
    float band = sin(vWorld.x * 0.5 - uTime * 1.5 + vWorld.z * 0.09 + vWave * 6.0);
    float streak = pow(max(band, 0.0), 6.0);
    float sparkle = pow(max(sin(vWorld.z * 0.85 + uTime * 2.2), 0.0), 24.0);

    // Grazing view angles catch far more sun, and mirror the sky more than the depth colour.
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float grazing = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 2.5);
    col = mix(col, uFogColor * (0.35 + 0.65 * uLight), grazing * 0.55);

    col += uSunColor * (streak * (0.22 + 0.9 * grazing) + sparkle * 0.22) * detail * uLight;

    // Linear fog matching the rest of the scene, so the sea dissolves into the horizon instead
    // of ending in a hard teal edge.
    float fogFactor = smoothstep(uFogNear, uFogFar, dist);
    col = mix(col, uFogColor, fogFactor);

    gl_FragColor = vec4(col, 0.92);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createBeach(scene) {
  const group = new THREE.Group();
  group.name = 'beach';

  const sandCentreX = (SAND_X0 + SAND_X1) / 2;

  // --- sand ---------------------------------------------------------------
  const sandMap = repeatTex(sandTexture(), SAND_W / 4, SPAN / 4);
  sandMap.anisotropy = 8;
  sandMap.colorSpace = THREE.SRGBColorSpace;

  const sandGeo = new THREE.PlaneGeometry(SAND_W, SPAN, 48, 1);
  sandGeo.rotateX(-Math.PI / 2);
  {
    const pos = sandGeo.attributes.position;
    const shades = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const worldX = pos.getX(i) + sandCentreX;
      // Past x = 118 the sand rolls down under the surf: the sea plane starts inland at x = 96,
      // so the two surfaces have to cross or the waterline is a visible geometry edge.
      pos.setY(i, SAND_Y - smoothstep(SAND_X1 - 10, SAND_X1, worldX) * 0.95);

      // Wet band: sand darkens and cools over the last metres before the surf. Baked into
      // vertex colour — a decal strip along the waterline would read as painted on.
      const wet = smoothstep(SAND_X1 - 14, SAND_X1 - 3, worldX);
      const v = 1 - wet * 0.34;
      shades[i * 3] = v;
      shades[i * 3 + 1] = v * (1 - wet * 0.02);
      shades[i * 3 + 2] = v * (1 + wet * 0.04);
    }
    pos.needsUpdate = true;
    sandGeo.setAttribute('color', new THREE.BufferAttribute(shades, 3));
    sandGeo.computeVertexNormals();
  }

  const sand = new THREE.Mesh(
    sandGeo,
    new THREE.MeshStandardMaterial({ map: sandMap, roughness: 0.97, metalness: 0, vertexColors: true })
  );
  sand.position.set(sandCentreX, 0, 0);
  sand.receiveShadow = true;
  group.add(sand);

  // --- boardwalk along the inland edge, at promenade height ---------------
  const deckMap = repeatTex(boardwalkTexture(), 3, 70);
  deckMap.anisotropy = 8;
  const boardwalk = new THREE.Mesh(
    new THREE.BoxGeometry(DECK_W, 0.18, SPAN),
    new THREE.MeshStandardMaterial({ map: deckMap, roughness: 0.86, metalness: 0 })
  );
  boardwalk.position.set(SAND_X0 - DECK_W / 2, DECK_TOP - 0.09, 0);
  boardwalk.receiveShadow = true;
  group.add(boardwalk);

  // --- seawall, holding the promenade up where the sand drops away --------
  const wallH = WALL_TOP - WALL_BOTTOM;
  const seawall = new THREE.Mesh(
    new THREE.BoxGeometry(WALL_T, wallH, SPAN),
    new THREE.MeshStandardMaterial({ color: COLORS.concrete, roughness: 0.93, metalness: 0 })
  );
  seawall.position.set(SAND_X0, WALL_BOTTOM + wallH / 2, 0);
  seawall.castShadow = true;
  seawall.receiveShadow = true;
  group.add(seawall);

  // --- the sea ------------------------------------------------------------
  const seaW = EDGE - SEA_X0;
  const waterGeo = new THREE.PlaneGeometry(seaW, SPAN, 96, 64);
  waterGeo.rotateX(-Math.PI / 2);

  const waterUniforms = {
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(0x155a6b) },
    uShallow: { value: new THREE.Color(0x4fb6b4) },
    uSunColor: { value: new THREE.Color(COLORS.sun) },
    uFogColor: { value: new THREE.Color(0xffffff) },
    uFogNear: { value: 90 },
    uFogFar: { value: 520 },
    uLight: { value: 1 },
  };

  const water = new THREE.Mesh(
    waterGeo,
    new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    })
  );
  water.position.set(SEA_X0 + seaW / 2, WATER_Y, 0);
  water.renderOrder = 1; // drawn after the opaque sand it sits on, so depth shows through
  group.add(water);

  scene.add(group);

  // Pull fog from the scene every frame — sky.js repaints it, so read it, never cache it.
  function syncFog() {
    const fog = scene.fog;
    if (!fog) return;
    waterUniforms.uFogColor.value.copy(fog.color);
    if (fog.isFog) {
      waterUniforms.uFogNear.value = fog.near;
      waterUniforms.uFogFar.value = fog.far;
    } else if (fog.isFogExp2) {
      // Exp2 has no near/far; use the 2% visibility distance as the far edge.
      waterUniforms.uFogNear.value = 0;
      waterUniforms.uFogFar.value = Math.sqrt(-Math.log(0.02)) / Math.max(1e-4, fog.density);
    }

    // The sea must be fully fogged by the time its geometry ends at EDGE, or the plane's own
    // far edge becomes a hard teal line standing in for the horizon.
    waterUniforms.uFogFar.value = Math.min(waterUniforms.uFogFar.value, EDGE - 12);
    waterUniforms.uFogNear.value = Math.min(waterUniforms.uFogNear.value, waterUniforms.uFogFar.value * 0.5);

    // The sun tint follows the graded sky, or the glint stays noon-white while everything else
    // goes orange at dusk.
    waterUniforms.uSunColor.value.copy(fog.color).lerp(warmSun, 0.55);

    // Fog luminance is the beach's only reliable proxy for "how lit is the world right now":
    // bright noon fog reads as 1, deep midnight blue as 0.
    const lum = 0.2126 * fog.color.r + 0.7152 * fog.color.g + 0.0722 * fog.color.b;
    waterUniforms.uLight.value = clamp((lum - 0.004) / 0.22, 0, 1);
  }

  syncFog();

  return {
    group,
    water,
    update(dt) {
      waterUniforms.uTime.value += dt;
      syncFog();
    },
  };
}
