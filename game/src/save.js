// Persistence for Puerto Fuego — Dani's cash, health, weapon, position,
// wanted heat, mission progress and the clock of day.
//
// localStorage is hostile ground: it may be missing in some embeds, it throws
// on access when a browser has storage disabled, and it can hold junk another
// tab wrote. So every function here is total: it either returns a valid
// result or fails quietly, and the game boots from defaults instead.

export const SAVE_KEY = 'puerto-fuego.save.v1';

/** Bump only when the snapshot shape changes incompatibly. */
const SAVE_VERSION = 1;

/** Hour the clock falls back to when a save's time is corrupt (18:24). */
const FALLBACK_HOUR = 18.4;

/** Snapshot fields that must be finite numbers. */
const REQUIRED_NUMBERS = ['cash', 'health', 'armour', 'ammo', 'heat', 'hour'];

/** Fresh-game defaults, used whenever a field is missing or unusable. */
const DEFAULTS = {
  cash: 0,
  health: 100,
  armour: 0,
  weapon: 'pistol',
  ammo: 0,
  heat: 0,
  position: { x: 0, y: 0, z: 0 },
  mission: { id: null, step: 0 },
  hour: FALLBACK_HOUR,
};

function isRealNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Coerce anything number-ish to a finite number, else the fallback. */
function toNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Reach localStorage defensively: resolving the property itself throws under
 * strict privacy settings, so the lookup is inside the guard, not just the
 * read. Returns the storage object or null.
 */
function openStorage() {
  try {
    const store = globalThis.localStorage;
    if (store && typeof store.getItem === 'function' && typeof store.setItem === 'function') {
      return store;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the player's live state inside the host's `world` object. The shape
 * has drifted between modules, so check the plausible spellings in order
 * instead of assuming one.
 */
function findPlayerState(world) {
  const w = world || {};
  const p = w.player;
  if (p && typeof p === 'object') {
    if (p.state && typeof p.state === 'object') return p.state;
    if (p.position) return p;
  }
  if (w.playerState && typeof w.playerState === 'object') return w.playerState;
  return {};
}

/**
 * Pull a heat/wanted value out of whatever shape the police system uses:
 * a bare number, a wrapper with `.value`, `.heat`, or `.stars`.
 */
function findHeat(world, fallback) {
  const places = [
    world && world.heat,
    world && world.wanted,
    world && world.police && world.police.state,
    world && world.cops && world.cops.state,
  ];
  for (const place of places) {
    if (isRealNumber(place)) return place;
    if (place && typeof place === 'object') {
      if (isRealNumber(place.value)) return place.value;
      if (isRealNumber(place.heat)) return place.heat;
      if (isRealNumber(place.stars)) return place.stars;
    }
  }
  return fallback;
}

/** Pull the clock hour out of the host world, in its plausible spellings. */
function findHour(world, fallback) {
  const places = [
    world && world.hour,
    world && world.time && world.time.hour,
    world && world.time && world.time.state && world.time.state.hour,
    world && world.clock && world.clock.hour,
  ];
  for (const place of places) {
    if (isRealNumber(place)) return place;
  }
  return fallback;
}

/**
 * Shape check for a loaded snapshot. Every numeric field must be a finite
 * number — a string cash total would make every economy comparison silently
 * pass against NaN. Weapon must be a non-empty WEAPONS key, position a
 * {x, y, z} of finite numbers, and mission a {id, step} pair with a null id
 * while free-roaming.
 */
export function isSaveShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  for (const key of REQUIRED_NUMBERS) {
    if (!isRealNumber(value[key])) return false;
  }

  if (typeof value.weapon !== 'string' || value.weapon.length === 0) return false;

  const pos = value.position;
  if (!pos || typeof pos !== 'object' || Array.isArray(pos)) return false;
  if (!isRealNumber(pos.x) || !isRealNumber(pos.y) || !isRealNumber(pos.z)) return false;

  const mission = value.mission;
  if (!mission || typeof mission !== 'object' || Array.isArray(mission)) return false;
  if (mission.id !== null && typeof mission.id !== 'string') return false;
  if (!Number.isInteger(mission.step) || mission.step < 0) return false;

  return true;
}

/**
 * Snapshot the host world into localStorage. Refuses to write a snapshot
 * the loader would reject — a save that fails to load next session looks
 * like data loss, which is worse than no save. Returns true on success.
 */
export function saveGame(world) {
  const w = world || {};
  const ps = findPlayerState(w);
  const pos = ps.position && typeof ps.position === 'object' ? ps.position : {};
  const missionState = w.missions && w.missions.state ? w.missions.state : {};

  const snapshot = {
    version: SAVE_VERSION,
    cash: toNumber(ps.cash, DEFAULTS.cash),
    health: toNumber(ps.health, DEFAULTS.health),
    armour: toNumber(ps.armour, DEFAULTS.armour),
    weapon: typeof ps.weapon === 'string' && ps.weapon ? ps.weapon : DEFAULTS.weapon,
    // Some builds call spare rounds `reserve` instead of `ammo`; accept both
    // so a save never silently drops the ammo count to zero.
    ammo: toNumber(ps.ammo !== undefined ? ps.ammo : ps.reserve, DEFAULTS.ammo),
    heat: findHeat(w, DEFAULTS.heat),
    position: {
      x: toNumber(pos.x, DEFAULTS.position.x),
      y: toNumber(pos.y, DEFAULTS.position.y),
      z: toNumber(pos.z, DEFAULTS.position.z),
    },
    mission: {
      id: typeof missionState.active === 'string' ? missionState.active : null,
      step: Number.isInteger(missionState.step) ? Math.max(0, missionState.step) : 0,
    },
    hour: findHour(w, FALLBACK_HOUR),
  };

  if (!isSaveShape(snapshot)) return false;

  const store = openStorage();
  if (!store) return false;
  try {
    store.setItem(SAVE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    // Quota exceeded, or storage disabled between lookup and write.
    return false;
  }
}

/** Load the snapshot, or null when there is none, it is corrupt, or storage is unavailable. */
export function loadGame() {
  const store = openStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isSaveShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Delete the snapshot. Returns true when the removal went through. */
export function clearSave() {
  const store = openStorage();
  if (!store) return false;
  try {
    store.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}
