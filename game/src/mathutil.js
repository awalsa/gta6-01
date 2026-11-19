// Tiny numeric toolkit, plus the seeded randomness the whole city is built on.
//
// Why seeded: every scene and every screenshot is rebuilt from one seed, so a
// capture is reproducible instead of depending on whatever Math.random gave
// back that frame. Nothing here touches the DOM or three.js — pure numbers.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Clamp a value into [min, max]. */
export function clamp(value, min, max) {
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

/** Linear interpolation between a and b at t. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Fold any angle into the range (-PI, PI]. */
export function wrapAngle(angle) {
  const folded = ((angle + Math.PI) % TAU + TAU) % TAU;
  return folded - Math.PI;
}

/**
 * Rotate `current` toward `target` by at most `maxStep` radians, taking the
 * short way around the circle. Returns `target` once it is within reach.
 */
export function turnToward(current, target, maxStep) {
  const delta = wrapAngle(target - current);
  if (Math.abs(delta) <= maxStep) return target;
  return wrapAngle(current + Math.sign(delta) * maxStep);
}

/**
 * Frame-rate-independent approach factor: the fraction of the remaining gap
 * to close in `dt` seconds when moving at `rate` per second.
 */
export function damp(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

/** Smooth 0..1 ramp: 0 below edge0, 1 above edge1, eased in between. */
export function smoothstep(edge0, edge1, x) {
  const span = edge1 - edge0;
  const t = clamp((x - edge0) / (span === 0 ? 1e-6 : span), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Straight-line distance between two {x, z} points. */
export function distance2D(a, b) {
  return Math.sqrt(distance2DSq(a, b));
}

/** Squared 2D distance — use for comparisons where the root is wasted work. */
export function distance2DSq(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/**
 * Bearing from point `a` to point `b`, in the game's yaw convention
 * (0 = north/-Z, clockwise positive).
 */
export function angleTo(a, b) {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

/**
 * Avalanche-mix a 32-bit integer into a stable unsigned 32-bit value.
 * Same input, same output, on every run and every machine — handy for
 * turning a world coordinate into a repeatable pseudo-random pick.
 */
export function hashInt(n) {
  let x = (n | 0) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Seeded generator (splitmix32). Returns a function yielding values in [0, 1).
 * Deterministic for a given seed; fast and small enough for placement work.
 * Not cryptographic — it never needs to be.
 */
export function createRandom(seed = 1) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = z ^ (z >>> 15);
    return (z >>> 0) / 4294967296;
  };
}

/** Pick one element of `items` using the seeded generator `random`. */
export function pick(random, items) {
  const index = Math.floor(random() * items.length);
  return items[index >= items.length ? items.length - 1 : index];
}

/** A random value in [min, max). */
export function range(random, min, max) {
  return min + random() * (max - min);
}

/** A random integer in [min, max], inclusive on both ends. */
export function rangeInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Turn a hex colour number into a CSS colour string, so canvas code and
 * three.js materials can share one palette without converting it twice.
 */
export function cssColor(hex, alpha = 1) {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  if (alpha >= 1) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
