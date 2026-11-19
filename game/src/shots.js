// Puerto Fuego — screenshot staging.
//
// A staged frame runs none of the game loop, so everything a live frame would have produced by
// simulating — traffic placed around the subject, a crowd on the pavement, the character's pose,
// the sun at its hour, the wanted stars — has to be written here explicitly. Whatever this
// module forgets simply does not exist in the screenshot.
//
// The integrator calls stageShot(name, game) once, then renders one frame. Every subsystem is
// optional: a missing one degrades the frame instead of throwing, so a half-built game still
// produces a usable shot.

/** Clamp into [lo, hi]. */
function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Linear interpolation. */
function lerpNum(a, b, t) {
  return a + (b - a) * t;
}

/** The six frames the dossier is shot from. */
export const SHOT_NAMES = ['seafront', 'chase', 'mission', 'night', 'beach', 'downtown'];

/**
 * The shot table.
 *
 * Player offsets are in world metres. Camera offsets are in the PLAYER's frame: `behind` metres
 * behind her back, `side` metres to her right, `above` metres over her feet. The stager converts
 * them with the same (sin yaw, -cos yaw) forward every other module uses, because a world-space
 * offset only lines up for a subject facing +Z — everyone else gets the camera in front of
 * their face.
 *
 * `pitch` is extra downward tilt in radians after the aim, matching the camera rig's convention.
 * `stage` picks the staging flavour used for the crowd, the pose and (for chases) the heat.
 */
const SHOT_TABLE = {
  // Hero frame: driving the seafront boulevard at golden hour, traffic around her, two cruisers
  // closing in, HUD up. The sea is on her left, the city on her right.
  seafront: {
    player: { x: 79, z: 6, yaw: 1.35 },
    camera: { side: 1.6, above: 2.6, behind: 7.0, pitch: 0.02, fov: 52 },
    hour: 18.3,
    weather: 'clear',
    stage: 'drive',
    inVehicle: true,
  },
  // Dusk pursuit on the avenue: lights on, light bars reading against a darkening sky, 4 stars.
  chase: {
    player: { x: -20, z: -47, yaw: Math.PI / 2 },
    camera: { side: 1.1, above: 2.15, behind: 6.2, pitch: 0.06, fov: 55 },
    hour: 19.15,
    weather: 'hazy',
    stage: 'pursuit',
    inVehicle: true,
  },
  // On-foot mission beat: Dani mid-aim outside the meet, late-afternoon sun, clear sky.
  mission: {
    player: { x: -47, z: 56, yaw: 0 },
    camera: { side: 1.3, above: 1.9, behind: 4.8, pitch: 0.05, fov: 54 },
    hour: 17.2,
    weather: 'clear',
    stage: 'job',
    inVehicle: false,
  },
  // Night chase through downtown: blue hour, windows lit, wet-looking streets, 3 stars.
  night: {
    player: { x: -141, z: -70, yaw: 0 },
    camera: { side: 0.4, above: 2.3, behind: 5.8, pitch: -0.02, fov: 60 },
    hour: 20.4,
    weather: 'hazy',
    stage: 'nightPursuit',
    inVehicle: true,
  },
  // Barefoot on the sand at 16:54: boardwalk behind her, surf in front, a few beachgoers around.
  beach: {
    player: { x: 96, z: 24, yaw: 1.2 },
    camera: { side: 1.4, above: 1.55, behind: 6.5, pitch: 0.03, fov: 60 },
    hour: 16.9,
    weather: 'clear',
    stage: 'shore',
    inVehicle: false,
  },
  // Downtown canyon in a storm: 21:36, rain, lightning-ready sky, neon and headlights on wet road.
  downtown: {
    player: { x: 47, z: -20, yaw: Math.PI },
    camera: { side: -0.8, above: 2.0, behind: 5.0, pitch: 0.1, fov: 58 },
    hour: 21.6,
    weather: 'storm',
    stage: 'wet',
    inVehicle: false,
  },
};

/**
 * Staging flavour per shot. `phase` is the walk cycle the character is frozen in — a phase of 0
 * stands her with both feet together, which reads as a mannequin, so every shot sits mid-stride.
 * `aiming` lifts the arms into a firing pose. `heat`/`stars` are the wanted level a chase forces.
 */
const STAGE_FLAVOURS = {
  drive: { phase: 1.15, aiming: false, heat: 18.0, stars: 3 },
  pursuit: { phase: 2.4, aiming: false, heat: 23.4, stars: 4 },
  job: { phase: 1.9, aiming: true },
  nightPursuit: { phase: 0.9, aiming: false, heat: 19.5, stars: 3 },
  shore: { phase: 3.1, aiming: false },
  wet: { phase: 2.0, aiming: false },
};

/** Old names that used to appear in shot lists, kept so an old query still resolves. */
const SHOT_ALIASES = {
  start: 'seafront',
  title: 'seafront',
  play: 'mission',
  chase_cam: 'chase',
  cops: 'chase',
  storm: 'downtown',
  beachfront: 'beach',
  evening: 'night',
};

/**
 * Resolve whatever a URL or a script hands us into a shot name, or null. Accepts the bare name,
 * a filename like `2-night.jpg`, and a `?shot=` query value — all three show up in practice.
 */
export function resolveShotName(query) {
  if (typeof query !== 'string') return null;

  let value = query.trim().toLowerCase();
  if (!value) return null;

  // A query string may arrive whole; only the shot parameter is interesting.
  if (value.includes('shot=')) {
    const match = value.match(/shot=([^&]+)/);
    if (match) value = match[1];
  }
  value = value
    .replace(/^[?&]+/, '')
    .replace(/\.(jpe?g|png|webp)$/, '')
    .replace(/^\d+[-_]/, '') // screenshot files are numbered for the dossier's sort order
    .replace(/[-_]+/g, ' ')
    .trim();

  const squashed = value.replace(/\s+/g, '');
  if (SHOT_NAMES.includes(squashed)) return squashed;
  if (SHOT_ALIASES[squashed]) return SHOT_ALIASES[squashed];

  // Unique prefix: "sea" is unambiguous, "s" is not — ambiguity degrades to null rather than a
  // silently wrong frame.
  const matches = SHOT_NAMES.filter((name) => name.startsWith(squashed));
  if (matches.length === 1) return matches[0];

  return null;
}

// ------------------------------------------------------------ world access helpers

/** Call target[method](...args) only if it exists; returns undefined otherwise. Never throws. */
function callIf(target, method, ...args) {
  if (target && typeof target[method] === 'function') {
    try {
      return target[method](...args);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The player body, whether the caller handed over the module or its state object. */
function playerState(game) {
  const player = game && game.player;
  if (!player) return null;
  if (player.state && player.state.position) return player.state;
  if (player.position) return player;
  return null;
}

/** The first object in the game that behaves like a camera. */
function findCamera(game) {
  const candidates = [
    game && game.camera,
    game && game.camera && game.camera.camera,
    game && game.viewCamera,
    game && game.sceneCamera,
    game && game.scene && game.scene.userData && game.scene.userData.camera,
    game && game.three && game.three.camera,
  ];
  for (const c of candidates) {
    if (
      c &&
      c.position &&
      typeof c.position.set === 'function' &&
      typeof c.lookAt === 'function'
    ) {
      return c;
    }
  }
  return null;
}

/** Ground height at a point, falling back to the player's current height, then to sea level. */
function groundAt(game, x, z) {
  const city = game && game.city;
  if (city && typeof city.groundHeight === 'function') {
    const y = city.groundHeight(x, z);
    if (Number.isFinite(y)) return y;
  }
  const player = playerState(game);
  if (player && player.position && Number.isFinite(player.position.y)) return player.position.y;
  return 0;
}

function insideBuilding(game, x, z, margin) {
  const city = game && game.city;
  if (!city || typeof city.insideBuilding !== 'function') return false;
  return city.insideBuilding(x, z, margin) === true;
}

// ------------------------------------------------------------ population staging

/**
 * Park one ambient car exactly where it was put. A staged frame must not drive it away, so the
 * car is frozen: zero speed, handbrake on, auto-step disabled, then synced once.
 */
function parkVehicle(game, kind, x, z, yaw, options) {
  const vehicles = game && game.vehicles;
  if (!vehicles || typeof vehicles.spawn !== 'function') return null;

  const y = groundAt(game, x, z);
  let car = null;
  try {
    car = vehicles.spawn(kind, x, z, yaw, options);
  } catch {
    return null;
  }
  if (!car) return null;

  if (car.state) {
    car.state.x = x;
    car.state.z = z;
    car.state.y = y;
    car.state.yaw = yaw;
    car.state.speed = 0;
    car.state.vx = 0;
    car.state.vz = 0;
    car.state.lateral = 0;
  }
  car.autoStep = false;
  if (car.input) {
    car.input.throttle = 0;
    car.input.steer = 0;
    car.input.brake = true;
    car.input.handbrake = true;
  }
  callIf(vehicles, 'sync', car, 0);
  return car;
}

/**
 * A few ambient cars dotted around the subject so the street is alive, not empty. Slots are in
 * the player's frame (ahead / side metres), kept out of the line of sight between lens and
 * subject so no roof fills the bottom of the frame.
 */
function stageTraffic(game, px, pz, yaw, kind = 'sedan') {
  const forwardX = Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);
  const slots = [
    { ahead: 14, side: 7.5, yaw: yaw - 0.08 },
    { ahead: 20, side: -6.5, yaw: yaw + 0.1 },
    { ahead: -6, side: 8.5, yaw: yaw + 0.05 },
    { ahead: -12, side: -7.0, yaw: yaw - 0.12 },
  ];
  for (const slot of slots) {
    const x = px + forwardX * slot.ahead + rightX * slot.side;
    const z = pz + forwardZ * slot.ahead + rightZ * slot.side;
    parkVehicle(game, kind, x, z, slot.yaw, { driver: 'traffic' });
  }
}

/**
 * Two cruisers ahead of the player and off her shoulders, both in the forward half-plane: one
 * forward-right at 9 m, one forward-left at 13 m. The pair brackets her without ever crossing
 * the line of sight, and the nearer car overlaps her silhouette just enough to sell speed.
 * The wanted level is set through the real crime path so the HUD ticker fires as it would in
 * play, then the exact numbers are overwritten — the star band is the point of the frame.
 */
function stagePursuit(game, px, pz, yaw, flavour) {
  const police = game && game.police;
  if (!police) return;

  callIf(police, 'clearWanted');
  callIf(police, 'commitCrime', 'killPolice', 3);

  if (police.state) {
    police.state.heat = flavour.heat;
    police.state.stars = flavour.stars;
    police.state.backupTimer = 0;
    police.state.lastCrime = 'killPolice';
  }

  const forwardX = Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);
  const flank = [
    { ahead: 9.0, side: 4.2, yaw: yaw - 0.22 },
    { ahead: 13.0, side: -4.6, yaw: yaw - 0.3 },
  ];
  for (const slot of flank) {
    const x = px + forwardX * slot.ahead + rightX * slot.side;
    const z = pz + forwardZ * slot.ahead + rightZ * slot.side;
    parkVehicle(game, 'cruiser', x, z, slot.yaw, { driver: 'police', police: true });
  }
}

// ------------------------------------------------------------ the stager

/**
 * Stage a shot from the table and return a description of the frame that was built.
 *
 * Signature: stageShot(name, game) — `name` is a shot name (or anything resolveShotName
 * accepts), `game` is the assembled game: player, city, sky, weather, traffic, peds, police,
 * character, vehicles and camera, each optional. For convenience the arguments may also be
 * passed in the other order; the string is always treated as the shot name.
 *
 * Returns:
 *   {
 *     name,            // resolved shot name
 *     player: { x, z, yaw },
 *     camera: { side, above, behind, pitch, fov },
 *     hour, weather, stage,
 *     focus: { x, y, z }   // the point the lens was aimed at (player chest height)
 *   }
 *
 * Throws if the name cannot be resolved to a shot.
 */
export function stageShot(nameOrGame, gameOrName) {
  // Accept either argument order: the string is the shot name, the object is the game.
  let name = nameOrGame;
  let game = gameOrName;
  if (typeof nameOrGame === 'object' && typeof gameOrName === 'string') {
    game = nameOrGame;
    name = gameOrName;
  }

  const shotName = SHOT_NAMES.includes(name) ? name : resolveShotName(name);
  if (!shotName) throw new Error(`unknown shot: ${name}`);

  const entry = SHOT_TABLE[shotName];
  const flavour = STAGE_FLAVOURS[entry.stage] || { phase: 0.8, aiming: false };

  const player = playerState(game);
  const px = entry.player.x;
  const pz = entry.player.z;
  const yaw = entry.player.yaw;
  const py = groundAt(game, px, pz);

  if (player) {
    player.position.x = px;
    player.position.y = py;
    player.position.z = pz;
    player.yaw = yaw;
    if (player.velocity) {
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;
    }
    // Stood still: a non-zero speed would put a walk cycle under a pose chosen by hand.
    player.speed = 0;
    player.inVehicle = entry.inVehicle === true;
    player.grounded = true;
    player.alive = true;
  }

  // ------------------------------------------------------------ light and weather
  const sky = game && game.sky;
  callIf(sky, 'setHour', entry.hour);
  callIf(game && game.clock, 'setHour', entry.hour);
  if (game) {
    if (Number.isFinite(game.timeOfDay) || game.timeOfDay === undefined) game.timeOfDay = entry.hour;
    if (game.time && typeof game.time === 'object' && Number.isFinite(game.time.hour)) {
      game.time.hour = entry.hour;
    }
  }

  const weather = game && game.weather;
  callIf(weather, 'set', entry.weather);
  // Rain and lightning are built around a focus; without it the storm is centred on the origin
  // and the frame is dry.
  if (weather && weather.state) {
    weather.state.follow = { x: px, z: pz };
    callIf(weather, 'update', 0.05);
  }

  const focus = { x: px, y: py + 1.15, z: pz };
  callIf(sky, 'followShadow', focus);

  // ------------------------------------------------------------ the subject
  const character = game && game.character;
  if (character) {
    callIf(character, 'setVisible', true);
    // Staged frames never run update(), so the transform and the pose both have to be written
    // once, here, or the subject is left where the last live frame put her — or invisible.
    const group = character.group;
    if (group) {
      if (group.position && typeof group.position.set === 'function') {
        group.position.set(px, py, pz);
      }
      group.rotation.y = yaw;
    }
    callIf(character, 'pose', { phase: flavour.phase, aiming: flavour.aiming === true });
  }

  // ------------------------------------------------------------ population
  const traffic = game && game.traffic;
  callIf(traffic, 'populate', { x: px, z: pz });

  const peds = game && game.peds;
  if (peds && typeof peds.relocate === 'function') {
    callIf(peds, 'relocate', { x: px, z: pz });
    callIf(peds, 'update', 0);
  } else {
    callIf(game && game.crowd, 'relocate', { x: px, z: pz });
  }

  // Driving shots get ambient traffic; chase shots get the pursuit on top of it.
  if (entry.inVehicle) stageTraffic(game, px, pz, yaw);
  if (flavour.heat !== undefined) stagePursuit(game, px, pz, yaw, flavour);

  // ------------------------------------------------------------ the lens, last
  // Last, because the safety loop needs to know where the population ended up: a lens pushed
  // out of a wall must not then be shoved back into a car's flank.
  const forwardX = Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);

  let lensX = px - forwardX * entry.camera.behind + rightX * entry.camera.side;
  let lensZ = pz - forwardZ * entry.camera.behind + rightZ * entry.camera.side;
  let lensY = py + entry.camera.above;

  // A staged frame shot from inside a shopfront is a black rectangle, and there is no loop to
  // notice. Fourteen lerps of 15% close 90% of the gap to the subject, who is always outside
  // the walls because she had to be able to stand there.
  const SAFETY_STEPS = 14;
  const SAFETY_PULL = 0.15;
  for (let i = 0; i < SAFETY_STEPS && insideBuilding(game, lensX, lensZ, 0.6); i++) {
    lensX = lerpNum(lensX, px, SAFETY_PULL);
    lensZ = lerpNum(lensZ, pz, SAFETY_PULL);
    // Rising as it closes: pulled in flush with her, a lens at chest height looks up her nose.
    lensY = lerpNum(lensY, py + entry.camera.above * 1.15 + 0.35, SAFETY_PULL);
  }
  if (insideBuilding(game, lensX, lensZ, 0.6)) {
    lensX = px + rightX * 0.9;
    lensZ = pz + rightZ * 0.9;
    lensY = py + Math.max(entry.camera.above, 1.9);
  }

  const camera = findCamera(game);
  if (camera) {
    camera.position.set(lensX, lensY, lensZ);
    if (Number.isFinite(entry.camera.fov)) {
      camera.fov = clampNum(entry.camera.fov, 20, 110);
      callIf(camera, 'updateProjectionMatrix');
    }
    camera.lookAt(focus.x, focus.y, focus.z);
    // Extra tilt after the aim, in the camera's own frame: positive pitch looks down, matching
    // the rig so a shot-table value means the same thing in both places.
    if (entry.camera.pitch) callIf(camera, 'rotateX', -entry.camera.pitch);

    // The rig caches its pose; a frame rendered without the loop would otherwise be drawn from
    // wherever the previous snap parked it.
    const rig = game && game.camera && game.camera.state;
    if (rig) {
      const dx = focus.x - lensX;
      const dy = focus.y - lensY;
      const dz = focus.z - lensZ;
      const flat = Math.hypot(dx, dz) || 1e-4;
      rig.yaw = Math.atan2(dx, -dz);
      rig.pitch = clampNum(Math.atan2(-dy, flat) - entry.camera.pitch, -1.4, 1.4);
      rig.distance = Math.hypot(flat, dy);
      if (rig.position) {
        rig.position.x = lensX;
        rig.position.y = lensY;
        rig.position.z = lensZ;
      }
      if ('shakeAmount' in rig) rig.shakeAmount = 0;
    }
  }

  return {
    name: shotName,
    player: { x: px, z: pz, yaw },
    camera: { ...entry.camera },
    hour: entry.hour,
    weather: entry.weather,
    stage: entry.stage,
    focus,
  };
}
