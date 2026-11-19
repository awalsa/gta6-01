// Weather for Puerto Fuego: one authoritative preset at a time, applied to
// the fog, the sun, the wind and a cheap rain field.
//
// The defensive rule that matters most: a NaN handed to a light's intensity
// turns every material it lights black, and the bug looks like a renderer
// failure rather than a weather one. Every numeric path into a light therefore
// has a finite fallback, and the sun is recomputed from the rig's own base
// intensity each frame instead of being dimmed in place (dimming in place
// compounds to black).

import * as THREE from 'three';
import { clamp, damp, lerp, wrapAngle } from './mathutil.js';

// windAngle is the direction the wind blows *toward*, in radians in the XZ
// plane. fogDensity is FogExp2 density (1/u), so 0.019 of sea fog is roughly a
// 90 u view. rain is a target drop count out of RAIN_SEGMENTS; wetness is
// 0..1 and is read by the road/traffic shaders.
export const PRESETS = {
  clear: {
    fogDensity: 0.0016,
    cloudCover: 0.12,
    wind: 0.4,
    rain: 0,
    wetness: 0,
    windAngle: 1.9,
    fogColor: 0xffc79a,
  },
  hazy: {
    fogDensity: 0.0044,
    cloudCover: 0.38,
    wind: 0.7,
    rain: 0,
    wetness: 0.06,
    windAngle: 2.5,
    fogColor: 0xffd9b8,
  },
  drizzle: {
    // 0.0078 is where a 34 u/s drive visibly eats the horizon without hiding
    // the traffic two blocks ahead.
    fogDensity: 0.0078,
    cloudCover: 0.66,
    wind: 1.1,
    rain: 420,
    wetness: 0.5,
    windAngle: 0.7,
    fogColor: 0xbcc0c6,
  },
  storm: {
    fogDensity: 0.0135,
    cloudCover: 0.96,
    wind: 2.8,
    rain: 1600,
    wetness: 0.92,
    windAngle: 3.4,
    fogColor: 0x6f7480,
  },
  seaFog: {
    // Denser than the storm but bright: sea fog swallows distance in white, so
    // its colour stays near the horizon tint instead of going grey.
    fogDensity: 0.019,
    cloudCover: 0.44,
    wind: 0.3,
    rain: 0,
    wetness: 0.2,
    windAngle: 4.6,
    fogColor: 0xd7d3ca,
  },
};

// 600 segments is the sweet spot: it reads as rain at 60 fps in one draw
// call, and the per-frame CPU loop over six hundred drops is invisible next
// to the physics.
const RAIN_SEGMENTS = 600;
const RAIN_BOX = 56; // horizontal wrap span, centred on whoever the rain follows
const RAIN_HEIGHT = 26;
const RAIN_FLOOR = -4;
const RAIN_FULL = 1600; // the count that means "storm"

// Two quick pulses read as a strike; a single frame just reads as a dropped
// frame.
const FLASH_ON = 0.06;
const FLASH_OFF = 0.09;
const STRIKE_MIN = 5.5;
const STRIKE_MAX = 13;

// The clear-sky visibility this map was graded for, used when the fog is a
// linear Fog (near/far) rather than FogExp2 and density has to be expressed
// as a far plane.
const CLEAR_FAR = 420;

function finite(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function colorsMatch(a, b) {
  // Cheap equality on a THREE.Color: 1e-6 is far below one 8-bit channel step,
  // so this detects "the sky rewrote it" without firing on float noise.
  return (
    !!a &&
    !!b &&
    Math.abs(a.r - b.r) <= 1e-6 &&
    Math.abs(a.g - b.g) <= 1e-6 &&
    Math.abs(a.b - b.b) <= 1e-6
  );
}

function locateSun(root) {
  if (!root || typeof root.traverse !== 'function') return null;
  let found = null;
  root.traverse((object) => {
    if (found || !object || !object.isLight) return;
    const role = object.userData && object.userData.role;
    const named = typeof object.name === 'string' && object.name.toLowerCase().includes('sun');
    if (named || role === 'sun') found = object;
  });
  return found;
}

/** Build the rain field: one LineSegments draw call, hashed drop seeds so the
 *  field looks identical every reload. */
function makeRainField() {
  const positions = new Float32Array(RAIN_SEGMENTS * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Zero-length draw range until the field is seeded: a buffer of zeros would
  // otherwise render one frame of static across the whole screen.
  geometry.setDrawRange(0, 0);

  const material = new THREE.LineBasicMaterial({
    color: 0xd7e2ee,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    // Additive, so rain stays visible against a bright horizon instead of
    // disappearing into the fog colour it is lit by.
    blending: THREE.AdditiveBlending,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'weather-rain';
  lines.frustumCulled = false;
  lines.visible = false;

  const px = new Float32Array(RAIN_SEGMENTS);
  const py = new Float32Array(RAIN_SEGMENTS);
  const pz = new Float32Array(RAIN_SEGMENTS);
  const fall = new Float32Array(RAIN_SEGMENTS);
  const length = new Float32Array(RAIN_SEGMENTS);

  for (let i = 0; i < RAIN_SEGMENTS; i += 1) {
    const h = (i * 2654435761) >>> 0;
    px[i] = ((h & 0xffff) / 0xffff - 0.5) * RAIN_BOX;
    pz[i] = (((h >>> 8) & 0xffff) / 0xffff - 0.5) * RAIN_BOX;
    py[i] = (((h >>> 16) & 0xff) / 0xff) * RAIN_HEIGHT;
    fall[i] = 22 + ((h & 0x3f) / 0x3f) * 16;
    length[i] = 0.55 + ((h & 0x0f) / 0x0f) * 0.75;
  }

  return { lines, geometry, material, positions, px, py, pz, fall, length };
}

export function createWeather(scene, sky) {
  const state = {
    name: 'clear',
    fogDensity: PRESETS.clear.fogDensity,
    cloudCover: PRESETS.clear.cloudCover,
    wind: PRESETS.clear.wind,
    rain: 0,
    wetness: PRESETS.clear.wetness,
    windAngle: PRESETS.clear.windAngle,
    /** Gust multiplier applied on top of the preset wind; drifts on its own. */
    gust: 1,
    lightning: 0,
    /**
     * Optional object whose position the rain follows. Assignable rather than
     * imported so this module never holds a stale player reference across a
     * respawn, and a screenshot script can point it at the camera.
     */
    follow: null,
  };

  // Fog is created if the scene has none: every preset here is defined by its
  // fog, so no fog would make set() a no-op.
  if (scene && !scene.fog) {
    scene.fog = new THREE.FogExp2(PRESETS.clear.fogColor, PRESETS.clear.fogDensity);
  }
  const fog = scene ? scene.fog : null;
  const isLinearFog = !!(fog && !('density' in fog));

  // The sky rig owns a linear Fog and republishes its colour every frame.
  // Mapping a literal 1/density onto `far` would drop storm visibility to
  // about 50 u — a whiteout, not weather you can drive in — so the curve is
  // softened.
  const LINEAR_FALLOFF = 0.55;

  function writeFogDensity(density) {
    if (!fog) return;
    const safe = clamp(finite(density, PRESETS.clear.fogDensity), 1e-5, 1);
    if (isLinearFog) {
      const ratio = clamp(safe / PRESETS.clear.fogDensity, 1e-3, 40);
      const far = CLEAR_FAR * Math.pow(ratio, -LINEAR_FALLOFF);
      if (!Number.isFinite(far) || far <= 1) return;
      fog.far = far;
      // Near at a third of far: near == far removes the fog entirely, and a
      // hard near plane greys out the street the player is standing on.
      fog.near = far * 0.34;
    } else if ('density' in fog) {
      fog.density = safe;
    }
  }

  // --- sun dimming -----------------------------------------------------------
  // sun.userData.baseIntensity is the rig's record of the undimmed value. The
  // rig republishes sun.intensity from its own day table inside apply(), so
  // dimming has to be recomputed from that base every frame — recomputed, not
  // multiplied, or a thousand frames of haze would fade the sun to black.
  const sun = sky && sky.sun && sky.sun.isLight ? sky.sun : locateSun(scene);
  let adoptedBase = 1;
  if (sun) {
    if (!sun.userData) sun.userData = {};
    const current = finite(sun.intensity, 1);
    adoptedBase = current > 0 ? current : 1;
    if (!Number.isFinite(sun.userData.baseIntensity)) sun.userData.baseIntensity = adoptedBase;
  }

  function sunBaseIntensity() {
    if (!sun) return 0;
    const declared = sun.userData ? sun.userData.baseIntensity : undefined;
    // The fallback covers a rig that was rebuilt and lost its userData
    // mid-session: one bad frame keeps the last known value instead of
    // zeroing the daylight.
    return finite(declared, adoptedBase);
  }

  function refreshSun() {
    if (!sun) return;
    const base = sunBaseIntensity();
    // Never below 18%: a storm is dim, not night, and the whole palette turns
    // to mud once the key light drops under that.
    const scale = lerp(1, 0.18, clamp(state.cloudCover, 0, 1));
    const next = base * scale;
    if (Number.isFinite(next) && next >= 0) sun.intensity = next;
  }

  // --- fog tint ---------------------------------------------------------------
  // The sky owns the fog colour (that is how fog turns orange at 18:24).
  // Rather than fight for it, the sky's value is treated as the base and the
  // weather pulls it toward the preset by a cloud-cover-weighted amount.
  const presetFogColor = new THREE.Color(PRESETS.clear.fogColor);
  const skyFogColor = new THREE.Color(PRESETS.clear.fogColor);
  const lastWritten = new THREE.Color(PRESETS.clear.fogColor);
  const tintedFog = new THREE.Color(PRESETS.clear.fogColor);
  const flashTint = new THREE.Color(0xd8e4ff);
  const scratch = new THREE.Color();
  let wroteFog = false;

  function tintWeight() {
    return clamp(0.1 + 0.75 * state.cloudCover, 0, 0.9);
  }

  function refreshFog() {
    if (!fog) {
      tintedFog.copy(presetFogColor);
      return;
    }
    writeFogDensity(state.fogDensity);
    if (!fog.color) {
      tintedFog.copy(presetFogColor);
      return;
    }

    // A colour that no longer matches our last write came from the sky, so it
    // is adopted as the new base. Without this the tint would re-lerp its own
    // output every frame and creep to the preset colour at a frame-rate
    // dependent speed.
    if (!wroteFog || !colorsMatch(fog.color, lastWritten)) skyFogColor.copy(fog.color);

    scratch.copy(skyFogColor).lerp(presetFogColor, tintWeight());
    fog.color.copy(scratch);
    lastWritten.copy(scratch);
    wroteFog = true;
    tintedFog.copy(scratch);
  }

  // --- lightning fill ---------------------------------------------------------
  // A dedicated fill for lightning. The sky's own fill is rewritten inside
  // apply() every frame, so a boost written to it would flicker depending on
  // module order; this one is written only here and therefore survives the
  // frame.
  const flashLight = new THREE.DirectionalLight(0xdfe8ff, 0);
  flashLight.name = 'weather-lightning-fill';
  flashLight.position.set(-30, 60, 20);
  flashLight.userData.baseIntensity = 0;
  if (scene) scene.add(flashLight);

  const rain = makeRainField();
  if (scene) scene.add(rain.lines);

  function set(name) {
    const preset = PRESETS[name] || PRESETS.clear;
    state.name = PRESETS[name] ? name : 'clear';
    state.fogDensity = clamp(finite(preset.fogDensity, PRESETS.clear.fogDensity), 1e-5, 1);
    state.cloudCover = clamp(finite(preset.cloudCover, 0), 0, 1);
    state.wind = clamp(finite(preset.wind, 0), 0, 12);
    state.rain = clamp(finite(preset.rain, 0), 0, RAIN_FULL);
    state.wetness = clamp(finite(preset.wetness, 0), 0, 1);
    state.windAngle = finite(preset.windAngle, PRESETS.clear.windAngle);

    if (fog) {
      presetFogColor.set(preset.fogColor || PRESETS.clear.fogColor);
      // With a sky rig the day cycle's colour is the base, so storming at
      // noon and storming at midnight stay different greys. Without one, the
      // preset is the only writer and becomes the base itself.
      if (!sky) skyFogColor.copy(presetFogColor);
      else if (!wroteFog || !colorsMatch(fog.color, lastWritten)) skyFogColor.copy(fog.color);
    } else {
      presetFogColor.set(preset.fogColor || PRESETS.clear.fogColor);
    }

    refreshFog();
    refreshSun();
    flashLight.intensity = 0;
    return state;
  }

  function focusPoint() {
    const follow = state.follow;
    if (follow) {
      const pos =
        follow.state && follow.state.position ? follow.state.position : follow.position || follow;
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) return pos;
    }
    const camera = scene && scene.userData ? scene.userData.camera : null;
    if (camera && camera.position && Number.isFinite(camera.position.x)) return camera.position;
    return null;
  }

  function activeDropCount() {
    const ratio = clamp(state.rain / RAIN_FULL, 0, 1);
    if (ratio <= 0) return 0;
    return Math.max(24, Math.floor(RAIN_SEGMENTS * ratio));
  }

  function updateRain(dt, focus) {
    const count = activeDropCount();
    rain.lines.visible = count > 0;
    if (!count) {
      rain.geometry.setDrawRange(0, 0);
      return;
    }

    const windX = Math.sin(state.windAngle) * state.wind * state.gust;
    const windZ = Math.cos(state.windAngle) * state.wind * state.gust;
    const half = RAIN_BOX * 0.5;
    const cx = focus ? focus.x : 0;
    const cz = focus ? focus.z : 0;
    const cy = focus ? Math.max(0, finite(focus.y, 0)) : 0;
    const floor = cy + RAIN_FLOOR;
    const ceiling = cy + RAIN_HEIGHT;
    const lengthScale = 0.7 + 0.9 * clamp(state.rain / RAIN_FULL, 0, 1);
    const positions = rain.positions;

    for (let i = 0; i < count; i += 1) {
      rain.py[i] -= rain.fall[i] * dt;
      rain.px[i] += windX * dt;
      rain.pz[i] += windZ * dt;

      // Recycled at both ends: a drop that has fallen past the floor reappears
      // at the ceiling, which keeps one allocation alive for the whole session.
      if (rain.py[i] < floor) rain.py[i] = ceiling;
      else if (rain.py[i] > ceiling) rain.py[i] = floor;

      // Wrapped relative to the focus, so the field is always around the
      // camera and never has to be re-seeded as the player drives across the
      // map.
      if (rain.px[i] - cx > half) rain.px[i] -= RAIN_BOX;
      else if (rain.px[i] - cx < -half) rain.px[i] += RAIN_BOX;
      if (rain.pz[i] - cz > half) rain.pz[i] -= RAIN_BOX;
      else if (rain.pz[i] - cz < -half) rain.pz[i] += RAIN_BOX;

      const len = rain.length[i] * lengthScale;
      const offset = i * 6;
      const x = rain.px[i];
      const y = rain.py[i];
      const z = rain.pz[i];
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      // The tail leans into the wind: that slant is what makes a downpour
      // read as weather rather than as a vertical curtain of static.
      positions[offset + 3] = x - windX * 0.08 * len;
      positions[offset + 4] = y + len;
      positions[offset + 5] = z - windZ * 0.08 * len;
    }

    rain.geometry.setDrawRange(0, count * 2);
    rain.geometry.attributes.position.needsUpdate = true;
    rain.material.opacity = 0.3 + 0.25 * clamp(state.rain / RAIN_FULL, 0, 1);
  }

  let flashTimer = 0;
  let flashPhase = 0; // 0 idle, 1 first pulse, 2 gap, 3 afterglow pulse
  let nextStrike = 6;

  function updateLightning(dt) {
    const stormy = state.name === 'storm' || state.cloudCover > 0.85;
    if (!stormy) {
      // The flash fades out on this path too: returning early would leave the
      // last strike's light burning through a clear sky. damp() returns a
      // blend factor, so it feeds lerp() rather than being treated as the
      // eased value itself.
      state.lightning = lerp(state.lightning, 0, damp(6, dt));
      const cooled = state.lightning * 3.2;
      flashLight.intensity = Number.isFinite(cooled) ? cooled : 0;
      flashPhase = 0;
      flashTimer = 0;
      nextStrike = STRIKE_MIN;
      return;
    }

    if (flashPhase === 0) {
      nextStrike -= dt;
      if (nextStrike <= 0) {
        flashPhase = 1;
        flashTimer = FLASH_ON;
        nextStrike = lerp(STRIKE_MIN, STRIKE_MAX, Math.random());
      }
    } else {
      flashTimer -= dt;
      if (flashTimer <= 0) {
        if (flashPhase === 1) {
          flashPhase = 2;
          flashTimer = FLASH_OFF;
        } else if (flashPhase === 2) {
          // Shorter and dimmer: a real strike's afterglow, not a second strike.
          flashPhase = 3;
          flashTimer = FLASH_ON * 0.6;
        } else {
          flashPhase = 0;
          flashTimer = 0;
        }
      }
    }

    const active = flashPhase === 1 || flashPhase === 3;
    const target = active ? (flashPhase === 1 ? 1 : 0.55) : 0;
    // Rises fast, falls slower: a strike is instantaneous, its afterglow is not.
    state.lightning = lerp(state.lightning, target, damp(active ? 40 : 9, dt));

    const boost = state.lightning * 3.2;
    flashLight.intensity = Number.isFinite(boost) ? boost : 0;

    if (fog && fog.color) {
      // Lightning lights the mist, it does not replace it, so this is a blend
      // and never a hard set — and it starts from the tinted value so the
      // storm's grey does not snap back to the day cycle's orange during a
      // flash.
      scratch.copy(tintedFog).lerp(flashTint, state.lightning * 0.55);
      fog.color.copy(scratch);
      // Recorded as our own write, or next frame would mistake the flash for
      // the sky's colour and adopt cold white as the tint base.
      lastWritten.copy(scratch);
    }

    if (scene && scene.background && scene.background.isColor) {
      scene.background.copy(scratch.copy(tintedFog).lerp(flashTint, state.lightning * 0.35));
    }
  }

  function update(dt) {
    // Clamped: a tab that was hidden must not teleport the rain field or burn
    // a whole lightning cycle in one frame.
    const step = clamp(finite(dt, 0), 0, 0.1);

    // The wind never sits still. A slow sine of its own angle plus a gust term
    // keeps the rain slant and the palm sway alive when nothing else changes.
    state.windAngle = wrapAngle(state.windAngle + Math.sin(state.windAngle * 0.7) * 0.05 * step);
    state.gust = clamp(
      1 + Math.sin(state.windAngle * 2.3 + state.fogDensity * 40) * 0.18 * clamp(state.wind / 3, 0, 1),
      0.55,
      1.6,
    );

    // Fog and sun first: the lightning flash has to blend over this frame's
    // tinted colour, not last frame's, or the flash trails the storm by a
    // frame.
    refreshFog();
    refreshSun();

    const focus = focusPoint();
    updateRain(step, focus);
    updateLightning(step);

    return state;
  }

  set('clear');

  return { state, set, update };
}
