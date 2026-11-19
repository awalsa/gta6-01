import * as THREE from 'three';
import { clamp, damp, lerp, wrapAngle } from './mathutil.js';

export const PRESETS = {
  clear: {
    fogDensity: 0.0016,
    fogColor: 0xbfd9e8,
    rainRate: 0,
    rainSpeed: 22,
    rainLength: 0.9,
    windSpeed: 1.6,
    windAngle: 0.6,
    cloudCover: 0.18,
    cloudSpeed: 1.4,
    cloudDarkness: 0.05,
    sunIntensity: 2.6,
    sunColor: 0xfff2d0,
    hemiIntensity: 0.85,
    hemiSky: 0x9fc4e8,
    hemiGround: 0x5c6b52,
  },
  hazy: {
    fogDensity: 0.006,
    fogColor: 0xd8cdb4,
    rainRate: 0,
    rainSpeed: 18,
    rainLength: 0.7,
    windSpeed: 2.4,
    windAngle: 1.1,
    cloudCover: 0.45,
    cloudSpeed: 2.0,
    cloudDarkness: 0.2,
    sunIntensity: 1.7,
    sunColor: 0xffe6b8,
    hemiIntensity: 0.7,
    hemiSky: 0xd8cdb4,
    hemiGround: 0x6b6250,
  },
  drizzle: {
    fogDensity: 0.009,
    fogColor: 0xaeb8c0,
    rainRate: 0.35,
    rainSpeed: 26,
    rainLength: 1.1,
    windSpeed: 4.5,
    windAngle: 2.2,
    cloudCover: 0.78,
    cloudSpeed: 3.2,
    cloudDarkness: 0.45,
    sunIntensity: 1.1,
    sunColor: 0xdfe8ee,
    hemiIntensity: 0.6,
    hemiSky: 0x9aa8b4,
    hemiGround: 0x4e5650,
  },
  storm: {
    fogDensity: 0.016,
    fogColor: 0x6f7a84,
    rainRate: 1,
    rainSpeed: 38,
    rainLength: 1.6,
    windSpeed: 11,
    windAngle: 2.9,
    cloudCover: 1,
    cloudSpeed: 6.5,
    cloudDarkness: 0.85,
    sunIntensity: 0.45,
    sunColor: 0x9fb4c4,
    hemiIntensity: 0.42,
    hemiSky: 0x5d6b78,
    hemiGround: 0x39403c,
  },
  seaFog: {
    fogDensity: 0.028,
    fogColor: 0xc9d4d2,
    rainRate: 0,
    rainSpeed: 16,
    rainLength: 0.6,
    windSpeed: 1.1,
    windAngle: 4.4,
    cloudCover: 0.3,
    cloudSpeed: 0.9,
    cloudDarkness: 0.15,
    sunIntensity: 0.9,
    sunColor: 0xf2ede0,
    hemiIntensity: 0.62,
    hemiSky: 0xc9d4d2,
    hemiGround: 0x5a6a62,
  },
};

const RAIN_COUNT = 1400;
const RAIN_AREA = 46;
const RAIN_HEIGHT = 30;
const CLOUD_COUNT = 16;
const CLOUD_SPREAD = 150;

function makeRainField() {
  const positions = new Float32Array(RAIN_COUNT * 3);
  const speeds = new Float32Array(RAIN_COUNT);
  for (let i = 0; i < RAIN_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * RAIN_AREA;
    positions[i * 3 + 1] = Math.random() * RAIN_HEIGHT;
    positions[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
    speeds[i] = 0.75 + Math.random() * 0.5;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xaec6d8,
    size: 0.14,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, positions, speeds, geometry, material };
}

function makeCloudPuff(material) {
  const group = new THREE.Group();
  const puffs = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < puffs; i++) {
    const radius = 6 + Math.random() * 9;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 10, 8),
      material,
    );
    mesh.position.set(
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 10,
    );
    mesh.scale.y = 0.42;
    group.add(mesh);
  }
  return group;
}

export function createWeather(scene, sky) {
  const state = { follow: { x: 0, z: 0 } };

  const start = PRESETS.clear;
  const current = {
    fogDensity: start.fogDensity,
    rainRate: start.rainRate,
    rainSpeed: start.rainSpeed,
    windSpeed: start.windSpeed,
    windAngle: start.windAngle,
    cloudCover: start.cloudCover,
    cloudSpeed: start.cloudSpeed,
    cloudDarkness: start.cloudDarkness,
    sunIntensity: start.sunIntensity,
    hemiIntensity: start.hemiIntensity,
  };
  const currentFogColor = new THREE.Color(start.fogColor);
  const currentSunColor = new THREE.Color(start.sunColor);
  const currentHemiSky = new THREE.Color(start.hemiSky);
  const currentHemiGround = new THREE.Color(start.hemiGround);

  let target = start;
  const targetFogColor = new THREE.Color(start.fogColor);
  const targetSunColor = new THREE.Color(start.sunColor);
  const targetHemiSky = new THREE.Color(start.hemiSky);
  const targetHemiGround = new THREE.Color(start.hemiGround);

  if (!scene.fog) {
    scene.fog = new THREE.FogExp2(start.fogColor, start.fogDensity);
  }
  scene.fog.density = start.fogDensity;
  scene.fog.color.copy(currentFogColor);
  scene.background = scene.background || currentFogColor.clone();

  const hemi = new THREE.HemisphereLight(
    start.hemiSky,
    start.hemiGround,
    start.hemiIntensity,
  );
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(start.sunColor, start.sunIntensity);
  sun.position.set(60, 90, 30);
  scene.add(sun);
  scene.add(sun.target);

  const rain = makeRainField();
  rain.points.visible = false;
  scene.add(rain.points);

  const cloudMaterial = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
  });
  const clouds = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const puff = makeCloudPuff(cloudMaterial);
    puff.position.set(
      (Math.random() - 0.5) * CLOUD_SPREAD,
      42 + Math.random() * 22,
      (Math.random() - 0.5) * CLOUD_SPREAD,
    );
    const scale = 0.8 + Math.random() * 1.1;
    puff.scale.setScalar(scale);
    puff.userData.drift = 0.7 + Math.random() * 0.6;
    puff.userData.baseY = puff.position.y;
    scene.add(puff);
    clouds.push(puff);
  }

  let elapsed = 0;
  let gustPhase = Math.random() * Math.PI * 2;

  function set(name) {
    const next = PRESETS[name];
    if (!next) return;
    target = next;
    targetFogColor.set(next.fogColor);
    targetSunColor.set(next.sunColor);
    targetHemiSky.set(next.hemiSky);
    targetHemiGround.set(next.hemiGround);
  }

  function daylightFactor() {
    if (!sky || !sky.state || typeof sky.state.hour !== 'number') return 1;
    const hour = sky.state.hour;
    const day = clamp((hour - 6) / 2, 0, 1);
    const dusk = clamp((20 - hour) / 2, 0, 1);
    return clamp(Math.min(day, dusk), 0.08, 1);
  }

  function update(dt) {
    const step = clamp(dt, 0, 0.05);
    elapsed += step;
    gustPhase += step * 0.35;

    const ease = 1.1;
    current.fogDensity += (target.fogDensity - current.fogDensity) * damp(ease, step);
    current.rainRate += (target.rainRate - current.rainRate) * damp(ease, step);
    current.rainSpeed += (target.rainSpeed - current.rainSpeed) * damp(ease, step);
    current.windSpeed += (target.windSpeed - current.windSpeed) * damp(ease, step);
    current.windAngle = wrapAngle(
      current.windAngle +
        wrapAngle(target.windAngle - current.windAngle) * damp(ease * 0.5, step),
    );
    current.cloudCover += (target.cloudCover - current.cloudCover) * damp(ease, step);
    current.cloudSpeed += (target.cloudSpeed - current.cloudSpeed) * damp(ease, step);
    current.cloudDarkness +=
      (target.cloudDarkness - current.cloudDarkness) * damp(ease, step);
    current.sunIntensity += (target.sunIntensity - current.sunIntensity) * damp(ease, step);
    current.hemiIntensity +=
      (target.hemiIntensity - current.hemiIntensity) * damp(ease, step);

    const colourEase = 1 - Math.exp(-ease * step);
    currentFogColor.lerp(targetFogColor, colourEase);
    currentSunColor.lerp(targetSunColor, colourEase);
    currentHemiSky.lerp(targetHemiSky, colourEase);
    currentHemiGround.lerp(targetHemiGround, colourEase);

    const daylight = daylightFactor();
    const gust = 1 + 0.18 * Math.sin(gustPhase) + 0.1 * Math.sin(gustPhase * 2.7);

    if (scene.fog) {
      scene.fog.density = current.fogDensity;
      scene.fog.color.copy(currentFogColor);
    }
    if (scene.background && scene.background.isColor) {
      scene.background.copy(currentFogColor);
    }

    hemi.intensity = current.hemiIntensity * lerp(0.35, 1, daylight);
    hemi.color.copy(currentHemiSky);
    hemi.groundColor.copy(currentHemiGround);

    sun.intensity = current.sunIntensity * daylight;
    sun.color.copy(currentSunColor);
    const sunAngle = elapsed * 0.01;
    sun.position.set(
      state.follow.x + Math.cos(sunAngle) * 70,
      60 + daylight * 40,
      state.follow.z + Math.sin(sunAngle) * 70,
    );
    sun.target.position.set(state.follow.x, 0, state.follow.z);

    const windX = Math.cos(current.windAngle) * current.windSpeed * gust;
    const windZ = Math.sin(current.windAngle) * current.windSpeed * gust;

    rain.points.visible = current.rainRate > 0.02;
    if (rain.points.visible) {
      rain.points.position.set(state.follow.x, 0, state.follow.z);
      rain.material.opacity = clamp(current.rainRate, 0, 1) * 0.75;
      const fall = current.rainSpeed * step;
      for (let i = 0; i < RAIN_COUNT; i++) {
        let y = rain.positions[i * 3 + 1] - fall * rain.speeds[i];
        let x = rain.positions[i * 3] + windX * step * 0.35;
        let z = rain.positions[i * 3 + 2] + windZ * step * 0.35;
        if (y < 0) {
          y = RAIN_HEIGHT;
          x = (Math.random() - 0.5) * RAIN_AREA;
          z = (Math.random() - 0.5) * RAIN_AREA;
        }
        if (x > RAIN_AREA / 2) x -= RAIN_AREA;
        if (x < -RAIN_AREA / 2) x += RAIN_AREA;
        if (z > RAIN_AREA / 2) z -= RAIN_AREA;
        if (z < -RAIN_AREA / 2) z += RAIN_AREA;
        rain.positions[i * 3] = x;
        rain.positions[i * 3 + 1] = y;
        rain.positions[i * 3 + 2] = z;
      }
      rain.geometry.attributes.position.needsUpdate = true;
    }

    const shade = 1 - current.cloudDarkness * 0.55;
    cloudMaterial.color.setRGB(shade, shade, shade * 1.02);
    for (let i = 0; i < clouds.length; i++) {
      const cloud = clouds[i];
      const visible = i / CLOUD_COUNT < current.cloudCover + 0.08;
      cloud.visible = visible;
      if (!visible) continue;
      cloud.position.x += windX * current.cloudSpeed * cloud.userData.drift * step * 0.4;
      cloud.position.z += windZ * current.cloudSpeed * cloud.userData.drift * step * 0.4;
      cloud.position.y =
        cloud.userData.baseY + Math.sin(elapsed * 0.12 + i * 1.7) * 1.4;
      const dx = cloud.position.x - state.follow.x;
      const dz = cloud.position.z - state.follow.z;
      if (dx > CLOUD_SPREAD / 2) cloud.position.x -= CLOUD_SPREAD;
      if (dx < -CLOUD_SPREAD / 2) cloud.position.x += CLOUD_SPREAD;
      if (dz > CLOUD_SPREAD / 2) cloud.position.z -= CLOUD_SPREAD;
      if (dz < -CLOUD_SPREAD / 2) cloud.position.z += CLOUD_SPREAD;
      cloudMaterial.opacity = 0.25 + current.cloudCover * 0.5;
    }
  }

  return { set, state, update };
}
