// Puerto Fuego — the single source of tuning truth.
//
// Every number that shapes the city, the driving, the fighting and the economy
// lives in this file, so a balance pass touches one place instead of twenty.
//
// World axes (agreed across all modules):
//   -Z = north, along the shoreline.  +X = east, toward the beach and the sea.
//   +Z = south, -X = west, into the city.  Yaw 0 faces north; yaw grows
//   clockwise when seen from above, so yaw +PI/2 faces east.

/* ------------------------------------------------------------------ */
/* The island                                                          */
/* ------------------------------------------------------------------ */

/** Playable square, in metres, centred on the origin. */
export const WORLD = {
  extent: 320,
  // Seawall ends here; sand runs from here to beachEnd, then open water.
  beachStart: 86,
  beachEnd: 128,
  // The promenade sits above the sand by this much.
  beachDrop: -1.35,
  // Sidewalk slabs and city blocks rise this far above the asphalt.
  kerb: 0.22,
  groundY: 0,
};

/** Street layout: asphalt lanes of `road` metres between blocks of `block`. */
export const GRID = {
  road: 13,
  block: 34,
  // Lines are indexed in pitches from the origin, minLine..maxLine. The
  // easternmost line stops one pitch short of the seawall so the seafront
  // row is blocks, not a road running into the sand.
  span: 3,
  minLine: -6,
  maxLine: 1,
};

/* ------------------------------------------------------------------ */
/* Light and time                                                      */
/* ------------------------------------------------------------------ */

/** One in-game day is compressed so a single session sees dusk, night, dawn. */
export const TIME = {
  startHour: 18.2,
  minutesPerSecond: 1.4,
  dayLengthHours: 24,
};

/** Dusk-graded palette shared by the sky, fog, lights and ground. */
export const COLORS = {
  skyZenith: 0x2f6f96,
  skyMid: 0x9dc8d8,
  skyHorizon: 0xffc98d,
  sun: 0xffe0b0,
  fog: 0xe8bc9a,
  asphalt: 0x2b2a2c,
  sidewalk: 0xa8a094,
  sand: 0xd8bf94,
  water: 0x1d6d84,
  concrete: 0xbfb6a6,
};

/* ------------------------------------------------------------------ */
/* Dani on foot                                                        */
/* ------------------------------------------------------------------ */

/** Dani Reyes, the courier. Speeds in m/s; accel is how fast she reaches them. */
export const PLAYER = {
  walk: 3.4,
  run: 7.2,
  sprint: 11.0,
  accel: 18,
  turnRate: 12,
  jump: 5.4,
  gravity: -22,
  eyeHeight: 1.62,
  radius: 0.42,
  maxHealth: 100,
  maxArmour: 50,
};

/** Third-person camera: trail distance/height, catch-up speed, aim mode. */
export const CAMERA = {
  fov: 62,
  distance: 4.6,
  height: 1.95,
  pitch: 0.11,
  followLag: 9,
  aimDistance: 2.1,
  aimFov: 48,
  minPitch: -0.55,
  maxPitch: 0.95,
};

/* ------------------------------------------------------------------ */
/* Driving                                                             */
/* ------------------------------------------------------------------ */

/** Shared vehicle physics; each body in CAR_SPECS only scales it. */
export const VEHICLE = {
  gravity: -20,
  drag: 0.42,
  rollingResistance: 1.6,
  brakeForce: 22,
  steerRate: 1.9,
  grip: 7.5,
  // Body centre sits this high so the wheels meet the road surface.
  rideHeight: 0.34,
};

/**
 * Named bodies. length/width are the collision box; power scales
 * acceleration, top is the top speed in m/s, mass scales collisions.
 */
export const CAR_SPECS = {
  sedan: { length: 4.5, width: 1.9, height: 1.42, power: 8.5, top: 26, mass: 1.0, paint: 0xb43a3a },
  taxi: { length: 4.6, width: 1.92, height: 1.5, power: 8.0, top: 24, mass: 1.05, paint: 0xe0b93a },
  van: { length: 5.3, width: 2.12, height: 2.1, power: 7.0, top: 22, mass: 1.5, paint: 0xd8d5cc },
  pickup: { length: 5.0, width: 2.0, height: 1.72, power: 7.8, top: 24, mass: 1.3, paint: 0x3f6d5a },
  sports: { length: 4.3, width: 1.98, height: 1.16, power: 12.5, top: 34, mass: 0.85, paint: 0x1c1c22 },
  cruiser: { length: 4.8, width: 1.96, height: 1.52, power: 10.5, top: 30, mass: 1.15, paint: 0x141c26 },
  boat: { length: 6.4, width: 2.3, height: 1.3, power: 9.0, top: 20, mass: 1.8, paint: 0xf0e6d2 },
};

/** Sun-bleached paints drawn at random for parked and ambient traffic. */
export const TRAFFIC_PAINT = [0xb43a3a, 0x2f4a6b, 0xd8d5cc, 0x8a8f96, 0x3f6d5a, 0xc98a3a, 0x5a3d5c];

/* ------------------------------------------------------------------ */
/* Combat and the law                                                  */
/* ------------------------------------------------------------------ */

/** Weapons. spread = half-angle in radians, cooldown in seconds, ranges in m. */
export const WEAPONS = {
  fists: { label: 'Fists', damage: 12, range: 1.6, cooldown: 0.42, spread: 0, ammo: Infinity, auto: false },
  pistol: { label: '9mm Pistol', damage: 26, range: 42, cooldown: 0.28, spread: 0.012, ammo: 34, magazine: 17, auto: false },
  smg: { label: 'SMG', damage: 17, range: 38, cooldown: 0.09, spread: 0.05, ammo: 120, magazine: 30, auto: true },
  shotgun: { label: 'Shotgun', damage: 15, range: 20, cooldown: 0.82, spread: 0.12, pellets: 7, ammo: 24, magazine: 6, auto: false },
};

/** Heat thresholds: HEAT[i] is the heat needed to reach wanted level i+1.
 *  Five stars, so the array has five entries and level 0 means clean. */
export const HEAT = [0, 2, 6, 12, 22];

/** Police answer per wanted level (index = stars): units sent, aggression 0..1. */
export const RESPONSE = [
  { units: 0, aggression: 0 },
  { units: 1, aggression: 0.35 },
  { units: 2, aggression: 0.5 },
  { units: 3, aggression: 0.68 },
  { units: 4, aggression: 0.85 },
  { units: 5, aggression: 1.0 },
];

/* ------------------------------------------------------------------ */
/* Money and spawn                                                     */
/* ------------------------------------------------------------------ */

/** Payouts, fees and starting cash. jobPayouts is indexed by job number. */
export const ECONOMY = {
  startCash: 1250,
  hospitalFee: 120,
  jobPayouts: [180, 260, 340, 420, 520, 640, 780, 900],
  shopCost: 450,
};

/** Spawn points: Dani's start, the safehouse door, the marina berth. */
export const START = {
  x: 60,
  z: 40,
  yaw: Math.PI,
  safehouse: { x: 50, z: 30 },
  marina: { x: 104, z: -36 },
};
