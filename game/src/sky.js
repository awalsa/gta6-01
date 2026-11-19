// Sky dome, sun and the graded light rig.
//
// Every colour in the scene comes out of STOPS: a colour script keyed on the hour of day. Any
// module that wants to know how bright or how warm it is asks this one, so "golden hour" means
// exactly one thing everywhere. The clock runs fast (TIME.minutesPerSecond), so one session
// sees sunset, night and dawn.

import * as THREE from 'three';
import { TIME } from './config.js';
import { clamp, lerp, smoothstep } from './mathutil.js';

// config.js stores the day as minutesPerSecond; accept a plain dayLengthSeconds too, so a
// clock retune cannot silently desync the sky from the rest of the game.
const DAY_SECONDS =
  TIME.dayLengthSeconds ?? (TIME.dayLengthHours * 60) / Math.max(0.0001, TIME.minutesPerSecond);

// Colour script. sunI is the key light, ambient the hemisphere fill. Golden hour holds them
// near 2.2 : 0.55 — push the fill higher and the long 18:00 shadows wash out into flat light.
// lamp is the street-light trim, exposure the renderer's tone-mapping scalar. Hour 24
// duplicates hour 0 so the table is cyclic with no wrap special case.
const STOPS = [
  { hour: 0.0, zenith: 0x05070f, horizon: 0x0a1220, sun: 0x18264a, fog: 0x070b14, sunI: 0.06, ambient: 0.10, lamp: 1.0, exposure: 0.70 },
  { hour: 5.0, zenith: 0x0d1526, horizon: 0x2a2f3f, sun: 0x3a4a68, fog: 0x141a28, sunI: 0.16, ambient: 0.22, lamp: 0.92, exposure: 0.80 },
  { hour: 6.5, zenith: 0x2c4d70, horizon: 0xf0a878, sun: 0xffb27a, fog: 0xd39b7d, sunI: 1.10, ambient: 0.44, lamp: 0.50, exposure: 1.00 },
  { hour: 8.5, zenith: 0x3a76a6, horizon: 0xcfe0e6, sun: 0xffeccd, fog: 0xd6dfe2, sunI: 2.15, ambient: 0.62, lamp: 0.14, exposure: 1.02 },
  { hour: 12.0, zenith: 0x2f74b0, horizon: 0xd7e8f0, sun: 0xfffaf0, fog: 0xdce8ee, sunI: 2.90, ambient: 0.80, lamp: 0.0, exposure: 1.05 },
  { hour: 15.0, zenith: 0x367bad, horizon: 0xdbe6e4, sun: 0xfff2d8, fog: 0xdfe4e0, sunI: 2.65, ambient: 0.74, lamp: 0.0, exposure: 1.04 },
  { hour: 17.0, zenith: 0x3f7ba6, horizon: 0xf0d3b0, sun: 0xffd79c, fog: 0xe5c9a8, sunI: 2.45, ambient: 0.66, lamp: 0.06, exposure: 1.03 },
  { hour: 18.6, zenith: 0x2b5c88, horizon: 0xffb673, sun: 0xffab63, fog: 0xeba878, sunI: 2.20, ambient: 0.55, lamp: 0.32, exposure: 1.02 },
  { hour: 19.8, zenith: 0x39406b, horizon: 0xff7f4e, sun: 0xff763d, fog: 0xc97858, sunI: 1.25, ambient: 0.44, lamp: 0.62, exposure: 0.97 },
  { hour: 21.0, zenith: 0x1e2547, horizon: 0xd9604a, sun: 0xff6234, fog: 0x6d4a58, sunI: 0.42, ambient: 0.26, lamp: 0.88, exposure: 0.88 },
  { hour: 22.5, zenith: 0x06080f, horizon: 0x0b1420, sun: 0x24395c, fog: 0x080d15, sunI: 0.07, ambient: 0.13, lamp: 1.0, exposure: 0.72 },
  { hour: 24.0, zenith: 0x05070f, horizon: 0x0a1220, sun: 0x18264a, fog: 0x070b14, sunI: 0.06, ambient: 0.10, lamp: 1.0, exposure: 0.70 },
];

export const KEYS = STOPS;

const SUN_DIST = 120; // metres out: far enough that the shadow frustum can be 190 m wide
const DOME_R = 900;
const SHADOW_HALF = 95; // +/-95 m ortho frustum around the shadow focus

// Module-level scratch: apply() runs every frame and must not feed the GC.
const sunOffset = new THREE.Vector3();
const shadowFocus = new THREE.Vector3();
const tmpA = new THREE.Color();
const tmpB = new THREE.Color();
const colTop = new THREE.Color();
const colHorizon = new THREE.Color();
const colSun = new THREE.Color();
const colFog = new THREE.Color();
const GREY = new THREE.Color(0x8f9aa3);

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunTint;
  uniform float uSunPower;

  varying vec3 vDir;

  void main() {
    vec3 dir = normalize(vDir);

    // pow(0.6) lifts the mid-sky: a straight linear gradient leaves a dead haze band right
    // above the rooftops, where the camera spends most of its time.
    float up = clamp(dir.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(up, 0.6));

    // Below the horizon the dome is mostly hidden by the sea; settle it back into the horizon
    // colour so no bright seam shows at the edge of the world.
    col = mix(col, uHorizon, smoothstep(0.0, 0.24, -dir.y));

    float d = max(dot(dir, normalize(uSunDir)), 0.0);
    float above = smoothstep(-0.10, 0.05, dir.y);

    // Broad glow plus a tight disc: one lobe at any power reads as a lens artefact, two lobes
    // read as a sun.
    float glow = pow(d, 8.0) * 0.55 + pow(d, 64.0) * 0.45;
    float disc = smoothstep(0.9986, 0.9993, d);
    col += uSunTint * (glow * 0.55 + disc * 1.4) * uSunPower * above;

    // Horizon scatter beside the sun, so the glow bleeds along the waterline at golden hour.
    float lateral = pow(max(1.0 - abs(dir.y) * 3.0, 0.0), 3.0) * pow(d, 2.0);
    col += uSunTint * lateral * 0.10 * uSunPower;

    gl_FragColor = vec4(col, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSky(scene, renderer) {
  const group = new THREE.Group();
  group.name = 'sky';

  const state = { hour: TIME.startHour, overcast: 0, lamp: 0, exposure: 1 };

  // --- dome ---------------------------------------------------------------
  const domeUniforms = {
    uTop: { value: new THREE.Color(0x2f74b0) },
    uHorizon: { value: new THREE.Color(0xd7e8f0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunTint: { value: new THREE.Color(0xffffff) },
    uSunPower: { value: 1 },
  };

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(DOME_R, 48, 32),
    new THREE.ShaderMaterial({
      uniforms: domeUniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
  );
  dome.name = 'sky-dome';
  dome.renderOrder = -10; // background first, never occludes
  dome.frustumCulled = false;
  group.add(dome);

  // --- key light ----------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, 2.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_HALF;
  sun.shadow.camera.right = SHADOW_HALF;
  sun.shadow.camera.top = SHADOW_HALF;
  sun.shadow.camera.bottom = -SHADOW_HALF;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 320;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.05;
  sun.shadow.camera.updateProjectionMatrix();
  group.add(sun);
  group.add(sun.target);

  // --- fill and bounce ----------------------------------------------------
  const fill = new THREE.HemisphereLight(0x9fc4e8, 0xb08a5e, 0.6);
  group.add(fill);

  // Warm light bounced off the sand: without it every shadowed surface goes cold and flat
  // in the middle of a bright afternoon.
  const bounce = new THREE.DirectionalLight(0xffd2a0, 0.18);
  bounce.position.set(0.1, -1, 0.22);
  bounce.castShadow = false;
  group.add(bounce);

  scene.add(group);

  // --- keyframe lookup ----------------------------------------------------
  function bracket(hour) {
    for (let i = 0; i < STOPS.length - 1; i++) {
      const a = STOPS[i];
      const b = STOPS[i + 1];
      if (hour >= a.hour && hour <= b.hour) {
        return { a, b, t: smoothstep(0, 1, (hour - a.hour) / (b.hour - a.hour || 1)) };
      }
    }
    return { a: STOPS[0], b: STOPS[0], t: 0 };
  }

  function blendHex(out, hexA, hexB, t) {
    tmpA.setHex(hexA);
    tmpB.setHex(hexB);
    return out.copy(tmpA).lerp(tmpB, t);
  }

  // --- sun arc ------------------------------------------------------------
  // Elevation peaks near 13:00, not at the 06:00-20:00 midpoint: the afternoon is what the
  // scene is graded for, and a symmetric arc puts the highest sun at noon, where the shadow
  // direction is least interesting. Azimuth swings from the sea at sunrise to the city at
  // sunset, staying close to the street axis so the low sun throws long shadows down the
  // carriageways instead of across them.
  function sunDirection(hour, out) {
    const dayT = clamp((hour - 6) / 14, 0, 1);
    const elevation = Math.sin(dayT * Math.PI) * 1.02 - 0.06;
    const azimuth = (0.5 - dayT) * 1.15;
    const ce = Math.cos(elevation);
    return out.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth)).normalize();
  }

  const sunDir = new THREE.Vector3();

  // --- apply --------------------------------------------------------------
  function apply() {
    const { a, b, t } = bracket(state.hour);
    const overcast = clamp(state.overcast, 0, 1);

    blendHex(colTop, a.zenith, b.zenith, t);
    blendHex(colHorizon, a.horizon, b.horizon, t);
    blendHex(colSun, a.sun, b.sun, t);
    blendHex(colFog, a.fog, b.fog, t);

    // Overcast greys the palette as well as dimming it; dimming alone leaves a saturated blue
    // sky overhead that betrays the flat light below.
    if (overcast > 0) {
      colTop.lerp(GREY, overcast * 0.45);
      colHorizon.lerp(GREY, overcast * 0.35);
      colSun.lerp(GREY, overcast * 0.3);
      colFog.lerp(GREY, overcast * 0.4);
    }

    sunDirection(state.hour, sunDir);

    domeUniforms.uTop.value.copy(colTop);
    domeUniforms.uHorizon.value.copy(colHorizon);
    domeUniforms.uSunDir.value.copy(sunDir);
    domeUniforms.uSunTint.value.copy(colSun);
    // The disc dies once the sun is under the sea, or it glows through the waterline.
    domeUniforms.uSunPower.value = smoothstep(-0.06, 0.1, sunDir.y) * (1 - overcast * 0.85);

    const clearSunI = lerp(a.sunI, b.sunI, t);
    sun.color.copy(colSun);
    sun.intensity = clearSunI * (1 - overcast * 0.78);
    // The clear-sky strength, before weather dims it: weather dims from here, so repeated
    // dim/undim cycles can never ratchet the sun down to nothing.
    sun.userData.baseIntensity = clearSunI;

    const ambientI = lerp(a.ambient, b.ambient, t) * (1 - overcast * 0.42);
    fill.color.copy(colTop);
    // Ground colour follows the sun, not a fixed brown: at dusk the light off the sand is the
    // same orange as everything else.
    fill.groundColor.copy(colSun).multiplyScalar(0.55).add(tmpA.setHex(0x6a5642).multiplyScalar(0.45));
    fill.intensity = ambientI;

    bounce.color.copy(colSun);
    bounce.intensity = ambientI * 0.3;

    if (scene.fog && scene.fog.color) scene.fog.color.copy(colFog);
    if (renderer) renderer.toneMappingExposure = lerp(a.exposure, b.exposure, t);

    // Absolute placement, restated from the stored offset every frame so followShadow() can
    // never accumulate drift as the player walks.
    sunOffset.copy(sunDir).multiplyScalar(SUN_DIST);
    sun.position.copy(shadowFocus).add(sunOffset);
    sun.target.position.set(shadowFocus.x, 0, shadowFocus.z);
    sun.target.updateMatrixWorld();

    state.lamp = lerp(a.lamp, b.lamp, t);
    state.exposure = renderer ? renderer.toneMappingExposure : lerp(a.exposure, b.exposure, t);
  }

  // --- public API ---------------------------------------------------------
  function setHour(hour) {
    state.hour = ((hour % 24) + 24) % 24;
    apply();
  }

  // Advance the clock by dt; pass an explicit hour to pin the time instead (used by the
  // staged screenshot frames, which set the sun directly rather than simulating the day).
  function update(dt, hour) {
    if (typeof hour === 'number') {
      setHour(hour);
      return;
    }
    state.hour = (state.hour + (dt * 24) / DAY_SECONDS) % 24;
    if (state.hour < 0) state.hour += 24;
    apply();
  }

  function setOvercast(value) {
    state.overcast = clamp(value, 0, 1);
    apply();
  }

  // Keep the shadow frustum on the player, not on the world origin: a 190 m box centred 450 m
  // from the origin shadows nothing but empty asphalt.
  function followShadow(focus) {
    shadowFocus.set(focus.x, focus.y ?? 0, focus.z);
    sun.position.copy(shadowFocus).add(sunOffset);
    sun.target.position.set(shadowFocus.x, 0, shadowFocus.z);
    sun.target.updateMatrixWorld();
  }

  function clockLabel() {
    const total = Math.round(state.hour * 60) % 1440;
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  apply();

  return { group, sun, fill, bounce, state, update, setHour, setOvercast, followShadow, clockLabel };
}
