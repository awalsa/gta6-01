// Puerto Fuego — bootstrapper.
//
// Owns the one thing no single system owns: the order everything starts in,
// the frame loop that drives them, and the seam between the title screen,
// live play, the pause board and the game-over card. Every subsystem is
// constructed through its own factory and then only ever touched through the
// handle that factory returned, so a module can be reworked without this
// file having to learn its internals.
//
// The page (index.html) calls start({ scene, hud }) with the two canvases
// and hides its splash once this resolves. start() therefore initialises
// everything and, in normal play, kicks off the animation loop and returns
// — the loop keeps the game alive after that. In screenshot mode
// (?shot=<name>) it instead stages one frozen frame, renders it once and
// returns without starting the loop, so nothing moves the camera afterwards.

import * as THREE from 'three';

import { CAMERA, ECONOMY, START, TIME, WORLD } from './config.js';
import { createCity } from './city.js';
import { createBeach } from './beach.js';
import { createSky } from './sky.js';
import { createProps } from './props.js';
import { createVehicleSystem } from './vehicles.js';
import { createTraffic } from './traffic.js';
import { createPeds } from './peds.js';
import { createWeather } from './weather.js';
import { createPlayer } from './player.js';
import { createCharacter } from './character.js';
import { createCameraRig } from './camera.js';
import { createCombat } from './combat.js';
import { createPolice } from './police.js';
import { MISSIONS, createMissions } from './missions.js';
import { createHud } from './hud.js';
import { createMenu } from './menu.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import { loadGame, saveGame } from './save.js';
import { resolveShotName, stageShot } from './shots.js';

/** Longest frame step the simulation ever sees, in seconds. */
const MAX_DT = 0.05;

/** Seconds between autosaves while playing. */
const AUTOSAVE_SECONDS = 25;

/** How close Dani has to be to a car to climb in. */
const ENTER_RANGE = 4.5;

/** Weapon slots on keys 1-4, in binding order. */
const WEAPON_SLOTS = ['fists', 'pistol', 'smg', 'shotgun'];

/** Clamp a number into [lo, hi]. */
function clampNum(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Boot the game into the two canvases the page hands over.
 *
 * Resolves once the first frame is on screen (or the staged screenshot
 * frame, in shot mode). Throws on any boot failure, after recording the
 * message on window.__bootFail so a headless harness can read it.
 */
export async function start({ scene: sceneCanvas, hud: hudCanvas }) {
  try {
    return await boot({ sceneCanvas, hudCanvas });
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    try {
      window.__bootFail = message;
    } catch {
      // No window to report on; the throw below still carries the failure.
    }
    throw err;
  }
}

async function boot({ sceneCanvas, hudCanvas }) {
  // ------------------------------------------------------------ shot mode
  // A ?shot= value means "render this one staged frame and stop": the
  // screenshot harness waits on window.__shotReady, never on the loop.
  const params = new URLSearchParams(window.location.search);
  const shotName = resolveShotName(params.get('shot') || '');
  const shotMode = shotName !== null;

  // ------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({
    canvas: sceneCanvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2436);
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.1, 900);

  // ------------------------------------------------------------ sizing
  // Both canvases are CSS 100% in the page; the backing stores are sized
  // here from the window so the 2D HUD stays crisp on hidpi screens.
  function resizeAll() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    hudCanvas.width = Math.round(w * dpr);
    hudCanvas.height = Math.round(h * dpr);
    if (hud) hud.resize();
  }

  // `hud` is referenced by resizeAll before it exists; the first call runs
  // after every system (including the HUD) is built, so this stays null
  // until then and the guard above keeps the early path safe.
  let hud = null;

  // ------------------------------------------------------------ world
  // Config/textures first (implicit: every factory below draws on them),
  // then the static city, then the things that move through it, then the
  // player and the systems that orbit her.
  const city = createCity(scene);
  const beach = createBeach(scene);
  const sky = createSky(scene, renderer);
  const props = createProps(scene, city);
  // Landmark footprints (lighthouse, hotel) block movement and bullets
  // exactly like the city blocks do.
  city.addObstacles(props.obstacles);
  const collision = {
    groundHeight: city.groundHeight,
    insideBuilding: city.insideBuilding,
    onRoad: city.onRoad,
    obstacles: props.obstacles,
  };

  const vehicles = createVehicleSystem(scene, city);
  const traffic = createTraffic(vehicles, city);
  const peds = createPeds(scene, city);
  const weather = createWeather(scene, sky);

  const player = createPlayer();
  const character = createCharacter(scene, player);
  const rig = createCameraRig(camera);
  const combat = createCombat(scene, player, collision);
  const police = createPolice(vehicles, player, scene);
  const missions = createMissions(scene, city, player);

  // ------------------------------------------------------------ HUD/menu/input/audio
  // The HUD never holds a simulation object: it reads this plain view,
  // refreshed every frame, so what it draws can never drift from the live
  // state by holding a stale reference.
  const hudWorld = {
    player,
    camera: rig,
    heat: 0,
    stars: 0,
    timeOfDay: TIME.startHour,
    clock: sky.state,
    time: sky.state,
    weapon: 'fists',
    ammoInMagazine: 0,
    ammoReserve: 0,
    speed: 0,
    velocity: player.state.velocity,
    inVehicle: false,
    vehicle: null,
    traffic: [],
    police: [],
    missions: [],
  };
  // Save/load reads a different shape (missions as a module, not blips),
  // so it gets its own small view instead of sharing the HUD's.
  const saveWorld = {
    player,
    missions,
    heat: 0,
    clock: sky.state,
    time: sky.state,
  };

  hud = createHud(hudCanvas, hudWorld);
  const audio = createAudio();
  const input = createInput(sceneCanvas);

  // ------------------------------------------------------------ game state
  const game = {
    renderer,
    scene,
    camera,
    city,
    beach,
    sky,
    props,
    vehicles,
    traffic,
    peds,
    weather,
    player,
    character,
    rig,
    combat,
    police,
    missions,
    hud,
    audio,
    input,
    timeOfDay: TIME.startHour,
    // stageShot calls clock.setHour(): the clock here is the sky rig
    // itself, whose state.hour is what the HUD and the save read.
    time: sky.state,
    clock: sky,
  };
  window.__puertoFuego = game;

  let mode = 'title'; // title | playing | paused | gameover
  let currentVehicle = null;
  let engineVoice = null;
  let sirenOn = false;
  let lastMissionEvent = null;
  let lastObjective = '';
  let autosaveIn = AUTOSAVE_SECONDS;
  let firstFrameDone = false;

  const trafficBlips = [];
  const policeBlips = [];
  const missionBlips = [];

  /** Copy the live simulation into the plain view the HUD reads. */
  function refreshHudWorld() {
    const ps = player.state;
    hudWorld.heat = police.state.heat;
    hudWorld.stars = police.starCount();
    hudWorld.timeOfDay = sky.state.hour;
    hudWorld.weapon = combat.state.weapon;
    const ammo = combat.ammo(combat.state.weapon);
    hudWorld.ammoInMagazine = ammo ? ammo.magazine : 0;
    hudWorld.ammoReserve = ammo ? ammo.reserve : 0;
    hudWorld.speed = ps.speed;
    hudWorld.velocity = ps.velocity;
    hudWorld.inVehicle = ps.inVehicle;
    hudWorld.vehicle = currentVehicle;

    // Blips come from the vehicle list, not the traffic roster: staged
    // frames park cars straight through vehicles.spawn, so traffic.cars
    // alone would leave the pursuit cruisers off the radar.
    trafficBlips.length = 0;
    policeBlips.length = 0;
    for (const car of vehicles.vehicles) {
      if (car === currentVehicle) continue;
      if (car.police) policeBlips.push({ x: car.state.x, z: car.state.z });
      else trafficBlips.push({ x: car.state.x, z: car.state.z });
    }
    hudWorld.traffic = trafficBlips;
    hudWorld.police = policeBlips;

    missionBlips.length = 0;
    const marker = missions.markerFor();
    if (marker) missionBlips.push(marker);
    hudWorld.missions = missionBlips;

    const objective = missions.objective();
    const key = `${objective.title}|${objective.step}|${objective.label}`;
    if (key !== lastObjective) {
      lastObjective = key;
      hud.setObjective(objective);
    }
  }

  /** Snapshot the game to localStorage; quiet when there is nothing to save. */
  function autosave() {
    saveWorld.heat = police.state.heat;
    if (saveGame(saveWorld)) hud.toast('Progress saved', 1.6);
  }

  /** Restore a snapshot onto the live state. Returns true when one applied. */
  function applySave(snapshot) {
    if (!snapshot) return false;
    const ps = player.state;
    if (snapshot.position) {
      ps.position.x = snapshot.position.x;
      ps.position.y = snapshot.position.y;
      ps.position.z = snapshot.position.z;
    }
    ps.cash = snapshot.cash;
    ps.health = snapshot.health;
    ps.armour = snapshot.armour;
    if (snapshot.weapon && WEAPON_SLOTS.includes(snapshot.weapon)) {
      combat.selectWeapon(snapshot.weapon);
    }
    sky.setHour(snapshot.hour);
    game.timeOfDay = snapshot.hour;
    if (snapshot.mission && snapshot.mission.id) {
      if (missions.startMission(snapshot.mission.id)) {
        missions.state.step = Math.max(0, snapshot.mission.step | 0);
      }
    }
    return true;
  }

  /** Park Dani's car-free body next to her ride and hand the wheel back. */
  function exitVehicle() {
    if (!currentVehicle) return;
    const car = currentVehicle;
    const ps = player.state;
    const sideX = Math.cos(car.state.yaw);
    const sideZ = Math.sin(car.state.yaw);
    ps.position.x = car.state.x + sideX * 2.2;
    ps.position.y = city.groundHeight(ps.position.x, car.state.z + sideZ * 2.2);
    ps.position.z = car.state.z + sideZ * 2.2;
    ps.yaw = car.state.yaw;
    ps.speed = 0;
    ps.velocity.x = 0;
    ps.velocity.z = 0;
    ps.inVehicle = false;
    car.autoStep = true;
    car.input.throttle = 0;
    car.input.steer = 0;
    car.input.brake = false;
    car.input.handbrake = false;
    if (engineVoice) {
      engineVoice.stop();
      engineVoice = null;
    }
    currentVehicle = null;
    hud.toast('On foot', 1.4);
  }

  /** Climb into the nearest car, if one is close enough to reach. */
  function enterVehicle() {
    const ps = player.state;
    const car = vehicles.nearest(ps.position.x, ps.position.z, ENTER_RANGE);
    if (!car) {
      hud.toast('No car in reach', 1.4);
      return;
    }
    // A traffic car stops being traffic the moment Dani takes it: its AI
    // must not keep steering while she holds the wheel.
    car.autoStep = false;
    car.driver = 'player';
    ps.inVehicle = true;
    ps.speed = 0;
    currentVehicle = car;
    engineVoice = audio.engine(car.id);
    hud.toast(car.police ? 'Cruiser taken' : 'Driving', 1.4);
  }

  /** Drive the current car from this frame's input, then ride along. */
  function driveVehicle(dt) {
    const car = currentVehicle;
    const s = input.state;
    car.input.throttle = s.moveZ;
    // Positive steer turns the nose clockwise (yaw grows), which is a
    // right turn when facing north — the same sign as pressing D.
    car.input.steer = s.moveX;
    car.input.brake = s.jump;
    car.input.handbrake = s.jump;
    // The vehicle system steps the car; the player body just rides it.
    // (The player module's own ride path reads a .position vector the
    // vehicle state does not publish, so the copy lives here instead.)
    const ps = player.state;
    ps.position.x = car.state.x;
    ps.position.y = car.state.y;
    ps.position.z = car.state.z;
    ps.yaw = car.state.yaw;
    ps.speed = Math.abs(car.state.speed);
    const forward = car.state.speed;
    ps.velocity.x = Math.sin(car.state.yaw) * forward;
    ps.velocity.z = -Math.cos(car.state.yaw) * forward;
    ps.grounded = true;
    if (engineVoice) engineVoice.setSpeed(Math.abs(car.state.speed) * 2.237);
    void dt;
  }

  /** Fire the drawn weapon along the camera's look direction. */
  function tryFire() {
    if (player.state.inVehicle) return 0;
    const result = combat.fire({
      direction: rig.direction(),
      targets: peds.people,
    });
    if (!result.fired) {
      if (result.reason === 'empty') hud.toast('Magazine empty — R to reload', 1.6);
      return 0;
    }
    audio.play(result.weapon);
    rig.shake(0.12);
    let kills = 0;
    if (result.bodyHit) {
      kills = 1;
      police.addCrime('killCivilian');
      hud.toast('You shot a civilian — the cops are coming', 2.4);
    } else if (result.hit) {
      police.addCrime('assault');
    }
    return kills;
  }

  /** React to a mission director event exactly once. */
  function drainMissionEvents() {
    const event = missions.state.lastEvent;
    if (!event || event === lastMissionEvent) return;
    lastMissionEvent = event;
    if (event.type === 'step') {
      hud.toast(`${event.label} — +$${event.payout}`, 2.6);
      audio.play('select');
    } else if (event.type === 'done') {
      hud.toast(`Job done: ${event.label} — +$${event.payout}`, 3.2);
      audio.play('select');
      const order = MISSIONS.map((entry) => entry.id);
      const next = order[(order.indexOf(event.id) + 1) % order.length];
      if (next && next !== event.id) missions.startMission(next);
    } else if (event.type === 'fail') {
      hud.toast(event.reason || 'Job failed', 3.0);
    }
  }

  /** Start (or restart) live play from the title or pause board. */
  function beginPlay(fromSave) {
    audio.unlock();
    audio.setHour(sky.state.hour);
    audio.startAmbience('street');
    audio.music();
    if (fromSave) {
      const snapshot = loadGame();
      if (snapshot) applySave(snapshot);
    }
    if (!missions.state.mission) missions.startMission(MISSIONS[0].id);
    mode = 'playing';
    menu.hide();
    input.lockPointer();
    refreshHudWorld();
    hud.setObjective(missions.objective());
    hud.toast('Puerto Fuego — follow the beacon', 3.0);
  }

  /** Send Dani to hospital: fee, respawn, wanted cleared, job dropped. */
  function handleDeath() {
    const ps = player.state;
    ps.cash = Math.max(0, ps.cash - ECONOMY.hospitalFee);
    mode = 'gameover';
    input.unlockPointer();
    if (engineVoice) {
      engineVoice.stop();
      engineVoice = null;
    }
    currentVehicle = null;
    menu.setScreen('gameover', {
      mission: missions.state.mission ? missions.state.mission.title : '',
      step: '',
      cash: ps.cash,
      stars: police.starCount(),
      cause: 'WASTED',
      earned: missions.state.payout,
      heading: 'WASTED',
    });
    autosave();
  }

  /** Respawn after the game-over card and put Dani back on the street. */
  function respawn() {
    if (currentVehicle) {
      currentVehicle.autoStep = true;
      currentVehicle = null;
    }
    player.reset();
    police.clearWanted();
    if (missions.state.mission) missions.abort('You went down.');
    missions.startMission(MISSIONS[0].id);
    sky.setHour(sky.state.hour);
    rig.snap({ player, blocked: (x, z) => city.insideBuilding(x, z, 0.5) });
    mode = 'playing';
    menu.hide();
    input.lockPointer();
    hud.toast('Patched up — back to work', 2.6);
  }

  // ------------------------------------------------------------ menu
  const menu = createMenu(hudCanvas, {
    onSelect: (id, screen) => {
      audio.unlock();
      audio.play('select');
      if (id === 'start') beginPlay(false);
      else if (id === 'continue') {
        if (screen === 'gameover') respawn();
        else beginPlay(true);
      } else if (id === 'resume') {
        mode = 'playing';
        menu.hide();
        input.lockPointer();
      } else if (id === 'restart') {
        respawn();
      } else if (id === 'quit') {
        // There is no desktop to quit to: fall back to the title board.
        if (currentVehicle) {
          currentVehicle.autoStep = true;
          currentVehicle = null;
        }
        player.reset();
        police.clearWanted();
        if (missions.state.mission) missions.abort('Walked away.');
        mode = 'title';
        menu.setScreen('title');
        input.unlockPointer();
      }
      // 'controls' and 'back' are handled inside the menu itself.
    },
  });

  // Menu keys are routed here, not through the gameplay input: while a
  // board is up the game is frozen, so WASD must move a selection, not Dani.
  window.addEventListener('keydown', (event) => {
    if (!menu.visible()) return;
    menu.handleKey(event.key);
  });

  window.addEventListener('resize', resizeAll);
  window.addEventListener('beforeunload', () => {
    if (mode === 'playing') autosave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'playing') autosave();
  });

  // ------------------------------------------------------------ populate
  resizeAll();
  sky.setHour(TIME.startHour);
  weather.set('clear');
  traffic.populate({ x: START.x, z: START.z });
  peds.relocate({ x: player.state.position.x, z: player.state.position.z });
  // One parked sedan by the spawn so driving is possible from the first minute.
  const starterCar = vehicles.spawn('sedan', START.x + 7, START.z + 2, Math.PI / 2);
  starterCar.autoStep = false;
  starterCar.input.throttle = 0;
  starterCar.input.steer = 0;
  starterCar.input.brake = true;
  starterCar.input.handbrake = true;
  vehicles.sync(starterCar, 0);
  rig.snap({ player, blocked: (x, z) => city.insideBuilding(x, z, 0.5) });
  sky.followShadow(player.state.position);
  weather.state.follow = {
    x: player.state.position.x,
    z: player.state.position.z,
  };

  // ------------------------------------------------------------ shot mode
  if (shotMode) {
    menu.hide();
    if (shotName === 'mission' && !missions.state.mission) {
      missions.startMission(MISSIONS[0].id);
    }
    const staged = stageShot(shotName, game);
    // One director tick after staging puts the mission beacon on its
    // target; the staged frame runs no loop to do it later.
    if (shotName === 'mission') {
      missions.update(0.1, { position: player.state.position });
    }
    // A driving shot needs Dani's own car under her: the stager parks the
    // traffic and the pursuit, but the subject's car is the integrator's job.
    if (player.state.inVehicle) {
      const car = vehicles.spawn(
        'sports',
        staged.player.x,
        staged.player.z,
        staged.player.yaw,
      );
      car.autoStep = false;
      car.input.throttle = 0;
      car.input.steer = 0;
      car.input.brake = true;
      car.input.handbrake = true;
      vehicles.sync(car, 0);
      currentVehicle = car;
      character.setVisible(false);
    }
    refreshHudWorld();
    hud.setObjective(missions.objective());
    hud.draw(performance.now() / 1000);
    renderer.render(scene, camera);
    firstFrameDone = true;
    window.__bootDone = true;
    window.__shotReady = true;
    window.__shot = staged;
    return game;
  }

  // ------------------------------------------------------------ normal boot
  // A save only applies when the player picks Continue; a fresh Start
  // begins at the spawn with starting cash, as the config intends.
  menu.setScreen('title');
  mode = 'title';

  // ------------------------------------------------------------ frame loop
  let prevT = performance.now();
  let elapsed = 0;

  function frame(nowMs) {
    requestAnimationFrame(frame);
    const now = nowMs / 1000;
    const dt = clampNum((nowMs - prevT) / 1000, 0, MAX_DT);
    prevT = nowMs;
    elapsed += dt;
    input.update();

    const ps = player.state;

    if (mode === 'title') {
      // Living backdrop behind the title board: the city breathes, Dani waits.
      sky.update(dt);
      weather.state.follow = { x: ps.position.x, z: ps.position.z };
      weather.update(dt);
      beach.update(dt);
      traffic.update(dt, { playerPos: ps.position });
      peds.update(dt, { playerPos: ps.position });
      rig.update(dt, { player, blocked: (x, z) => city.insideBuilding(x, z, 0.5) });
      sky.followShadow(ps.position);
    } else if (mode === 'playing') {
      // Pause is an edge trigger on Escape; the menu takes over from here.
      if (input.wasPressed('pause')) {
        mode = 'paused';
        input.unlockPointer();
        menu.setScreen('pause', {
          mission: missions.state.mission ? missions.state.mission.title : '',
          step: missions.state.mission ? `Step ${missions.state.step + 1}` : '',
          cash: ps.cash,
          stars: police.starCount(),
          cause: '',
          earned: missions.state.payout,
          heading: 'PAUSED',
        });
        autosave();
      } else {
        // --- enter / exit a car
        if (input.wasPressed('interact')) {
          if (ps.inVehicle) exitVehicle();
          else enterVehicle();
        }

        // --- weapons
        for (let i = 0; i < WEAPON_SLOTS.length; i++) {
          if (input.wasPressed(`weapon${i + 1}`)) {
            if (combat.selectWeapon(WEAPON_SLOTS[i])) {
              ps.weapon = WEAPON_SLOTS[i];
              audio.play('select');
            }
          }
        }
        if (input.wasPressed('reload')) combat.reload();

        // --- move: the car owns Dani while she drives, her feet own her otherwise
        let killsThisFrame = 0;
        if (ps.inVehicle && currentVehicle) {
          driveVehicle(dt);
        } else {
          player.update(dt, {
            input,
            handles: city,
            rig,
            cameraYaw: rig.state.yaw,
          });
          character.pose({ aiming: !!input.state.aim });
          if (input.state.fire) killsThisFrame += tryFire();
        }

        // --- the world answers
        vehicles.update(dt);
        traffic.update(dt, { playerPos: ps.position });
        peds.update(dt, {
          playerPos: ps.position,
          gunshots: police.state.gunfire > 0 || killsThisFrame > 0,
        });
        police.update(dt, {
          damagePlayer: (amount) => {
            player.damage(amount);
            rig.shake(0.35);
          },
        });
        missions.update(dt, {
          kills: killsThisFrame,
          position: ps.position,
          inVehicle: ps.inVehicle,
          vehicle: currentVehicle,
        });
        combat.update(dt);
        character.update(dt);
        rig.update(dt, {
          player,
          vehicle: currentVehicle,
          input,
          blocked: (x, z) => city.insideBuilding(x, z, 0.5),
          aiming: !!input.state.aim,
        });

        // --- sky, weather, audio
        sky.update(dt);
        sky.followShadow(ps.position);
        weather.state.follow = { x: ps.position.x, z: ps.position.z };
        weather.update(dt);
        beach.update(dt);
        audio.setHour(sky.state.hour);
        const sirens = police.state.units.length > 0;
        if (sirens !== sirenOn) {
          sirenOn = sirens;
          audio.siren(sirens);
        }

        // --- bookkeeping
        drainMissionEvents();
        refreshHudWorld();
        autosaveIn -= dt;
        if (autosaveIn <= 0) {
          autosaveIn = AUTOSAVE_SECONDS;
          autosave();
        }

        // --- death ends the run
        if (!ps.alive) handleDeath();
      }
    }
    // Paused / game-over: the scene stays exactly where it stopped.

    // --- draw
    if (mode === 'playing' || mode === 'title') {
      if (mode === 'playing') {
        refreshHudWorld();
        hud.draw(now);
      }
    }
    if (menu.visible()) menu.draw(now);
    renderer.render(scene, camera);

    if (!firstFrameDone) {
      firstFrameDone = true;
      window.__bootDone = true;
    }
    void elapsed;
  }

  requestAnimationFrame(frame);
  // Render one frame eagerly so start() only resolves with pixels on screen.
  refreshHudWorld();
  renderer.render(scene, camera);
  firstFrameDone = true;
  window.__bootDone = true;
  return game;
}

export default start;
