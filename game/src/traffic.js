// Ambient traffic for Puerto Fuego.
//
// Cars here are not a separate kind of object: each one is a vehicle from the
// shared vehicle system, driven by the same stepVehicle the player uses. This
// module only decides what the throttle, brake and steering inputs should be,
// so density and handling stay in one place.
//
// The city grid: roads run north-south and east-west on ROAD_LINES, pitch
// block + road. Traffic keeps to the right-hand lane, stops for red lights at
// junctions, and queues behind slower cars instead of rear-ending them.

import { GRID, TRAFFIC_PAINT, WORLD } from './config.js';
import { ROAD_LINES } from './city.js';
import { clamp, createRandom, pick, range, wrapAngle } from './mathutil.js';
import { stepVehicle } from './vehicles.js';

const PITCH = GRID.block + GRID.road;
const HALF_ROAD = GRID.road * 0.5;
// A quarter of the carriageway from the centre line: the middle of the
// right-hand lane, which is what makes the two directions read as traffic
// rather than two rows of parked cars.
const LANE_OFFSET = GRID.road * 0.25;

/** How long one axis holds green before the other takes it. */
const LIGHT_CYCLE = 11;
/** The last stretch of a green counts as red, so cars stop instead of
 *  entering on the change. */
const AMBER_TAIL = 2;
/** How far ahead a driver looks when picking a steering target. */
const AIM_AHEAD = 9;

/** Kinds of car that appear in ambient traffic, weighted by repetition. */
const TRAFFIC_KINDS = ['sedan', 'sedan', 'taxi', 'van', 'pickup', 'sports'];

/** Unit vector along the road, in world XZ. */
function alongVector(axis, dir) {
  return axis === 'z' ? { x: 0, z: dir } : { x: dir, z: 0 };
}

/** Right-hand side of the direction of travel, in world XZ. */
function sideVector(axis, dir) {
  return axis === 'z' ? { x: -dir, z: 0 } : { x: 0, z: dir };
}

/** Yaw that faces along (axis, dir). Forward is (sin yaw, -cos yaw): north
 *  is 0, east is +PI/2, south is PI, west is -PI/2. */
function headingFor(axis, dir) {
  if (axis === 'z') return dir > 0 ? Math.PI : 0;
  return dir > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
}

export function createTraffic(vehicles, handles) {
  const cars = [];
  const random = createRandom(0x51c7a3);

  // One shared clock for the junction lights: a single phase every car reads,
  // so the two axes are always in opposition instead of each car inventing
  // its own light.
  let clock = 0;

  /** True while the light is green for `axis` — amber tail counts as red. */
  function isGreen(axis) {
    const phase = clock % (LIGHT_CYCLE * 2);
    const firstHalf = phase < LIGHT_CYCLE;
    const remaining = firstHalf ? LIGHT_CYCLE - phase : LIGHT_CYCLE * 2 - phase;
    const greenNow = axis === 'z' ? firstHalf : !firstHalf;
    return greenNow && remaining > AMBER_TAIL;
  }

  /** A point in the car's lane, `along` metres down its road. */
  function lanePoint(car, along, extra = 0) {
    const side = sideVector(car.axis, car.dir);
    const offset = LANE_OFFSET + extra;
    if (car.axis === 'z') return { x: car.line + side.x * offset, z: along };
    return { x: along, z: car.line + side.z * offset };
  }

  /** Teleport a car onto its lane at `along`, stopped, facing its direction. */
  function place(car, along) {
    const point = lanePoint(car, along, car.swerve);
    car.state.x = point.x;
    car.state.z = point.z;
    car.state.yaw = headingFor(car.axis, car.dir);
    car.state.speed = 0;
    car.state.lateral = 0;
    car.state.y = handles?.groundHeight ? handles.groundHeight(point.x, point.z) : 0;
    vehicles.sync(car, 0);
  }

  /** True when (x, z) is unusable for a spawn: inside a building, too close
   *  to `avoid`, or too close to another traffic car. */
  function spawnBlocked(x, z, avoid, minGap) {
    if (handles?.insideBuilding && handles.insideBuilding(x, z, 1.2)) return true;
    if (avoid) {
      const ax = x - avoid.x;
      const az = z - avoid.z;
      if (Math.sqrt(ax * ax + az * az) < minGap) return true;
    }
    for (let i = 0; i < cars.length; i++) {
      const dx = cars[i].state.x - x;
      const dz = cars[i].state.z - z;
      if (Math.sqrt(dx * dx + dz * dz) < 7) return true;
    }
    return false;
  }

  // Direction alternates by rule, not by coin flip: two cars nose to nose in
  // the same lane is what a random draw eventually produces, and it reads as
  // broken traffic rather than a street.
  let spawnCount = 0;

  function addCar(centre) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const axis = random() < 0.5 ? 'z' : 'x';
      const line = pick(random, ROAD_LINES);
      const dir = spawnCount % 2 === 0 ? -1 : 1;
      // Most cars land within a few blocks of the staging point, because
      // ambient traffic 200 m away is invisible in a third-person shot; the
      // odd one still lands anywhere so the far grid is not empty if the
      // player drives out there.
      const centreAlong = centre ? (axis === 'z' ? centre.z : centre.x) : 0;
      const spread = random() < 0.75 ? 90 : WORLD.extent * 0.82;
      const along = clamp(
        centreAlong + range(random, -spread, spread),
        -WORLD.extent * 0.82,
        WORLD.extent * 0.82,
      );

      const probe = { axis, line, dir, swerve: 0 };
      const point = lanePoint(probe, along);
      if (spawnBlocked(point.x, point.z, centre, 9)) continue;

      const kind = pick(random, TRAFFIC_KINDS);
      const vehicle = vehicles.spawn(kind, point.x, point.z, headingFor(axis, dir), {
        driver: 'traffic',
        paint: pick(random, TRAFFIC_PAINT),
      });
      // Traffic supplies its own inputs, so the vehicle system must not
      // integrate this body twice.
      vehicle.autoStep = false;

      vehicle.axis = axis;
      vehicle.line = line;
      vehicle.dir = dir;
      vehicle.swerve = 0;
      vehicle.swerveTarget = 0;
      vehicle.swerveTimer = range(random, 4, 14);
      vehicle.cruise = range(random, 8, 13.5);
      vehicle.targetSpeed = vehicle.cruise;

      spawnCount++;
      cars.push(vehicle);
      return vehicle;
    }
    return null;
  }

  function populate(centre) {
    clear();
    spawnCount = 0;
    for (let i = 0; i < 18; i++) addCar(centre ?? { x: 0, z: 0 });
    return cars;
  }

  function clear() {
    for (let i = cars.length - 1; i >= 0; i--) vehicles.despawn(cars[i]);
    cars.length = 0;
  }

  /** Distance to the next junction on this car's road, in metres ahead. */
  function nextJunction(car, along) {
    let best = Infinity;
    for (let i = 0; i < ROAD_LINES.length; i++) {
      const gap = (ROAD_LINES[i] - along) * car.dir;
      // Only junctions still in front count. A small positive floor keeps a
      // car that has just rolled over the line from reading it as "0 m ahead"
      // and braking to a standstill there.
      if (gap > 0.5 && gap < best) best = gap;
    }
    return best;
  }

  /** Move a car to a fresh random road, far from the focus point. */
  function recycle(car, focus) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const axis = random() < 0.5 ? 'z' : 'x';
      const line = pick(random, ROAD_LINES);
      const dir = random() < 0.5 ? -1 : 1;
      const along = range(random, -WORLD.extent * 0.82, WORLD.extent * 0.82);
      const probe = { axis, line, dir, swerve: 0 };
      const point = lanePoint(probe, along);
      if (spawnBlocked(point.x, point.z, focus, 24)) continue;

      car.axis = axis;
      car.line = line;
      car.dir = dir;
      car.swerve = 0;
      car.swerveTarget = 0;
      car.swerveTimer = range(random, 4, 14);
      car.cruise = range(random, 8, 13.5);
      car.targetSpeed = car.cruise;
      place(car, along);
      return;
    }
  }

  /** Speed cap from the car ahead in the same lane, if any is close. */
  function followLimit(car, along) {
    let limit = Infinity;
    for (let j = 0; j < cars.length; j++) {
      const other = cars[j];
      if (other === car) continue;
      if (other.axis !== car.axis || other.line !== car.line || other.dir !== car.dir) continue;
      const otherAlong = car.axis === 'z' ? other.state.z : other.state.x;
      const gap = (otherAlong - along) * car.dir;
      if (gap <= 0.5 || gap > 12) continue;
      const lateral = car.axis === 'z' ? other.state.x - car.state.x : other.state.z - car.state.z;
      if (Math.abs(lateral) > 2.6) continue;
      // Closing speed is folded in so a fast car eases off earlier than a
      // crawling one.
      const cap = Math.max(
        0,
        (gap - 4.5) * 1.6 - Math.max(0, car.state.speed - other.state.speed) * 0.5,
      );
      limit = Math.min(limit, cap);
    }
    return limit;
  }

  function update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    clock += dt;

    const focus = ctx.playerPos ?? ctx.focus ?? null;

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const state = car.state;
      const along = car.axis === 'z' ? state.z : state.x;

      // --- target speed ---------------------------------------------------
      let target = Math.min(car.cruise, followLimit(car, along));

      // Red light: stop at the stop line, a junction half-width plus a car's
      // nose back from the centre. A car already inside the box (gap under
      // HALF_ROAD) is committed and drives on rather than freezing across
      // oncoming traffic.
      const junctionGap = nextJunction(car, along);
      if (!isGreen(car.axis)) {
        const stopLine = junctionGap - (HALF_ROAD + 3);
        if (stopLine > -0.5 && stopLine < 16) {
          target = Math.min(target, Math.max(0, stopLine * 1.1));
        }
      }

      // --- swerve -----------------------------------------------------------
      car.swerveTimer -= dt;
      if (car.swerveTimer <= 0) {
        // About one car in three nudges sideways, around a pothole or a
        // stopped van. The offset is capped well inside half a lane so body
        // plus swerve never overhangs the kerb.
        car.swerveTarget = random() < 0.35 ? range(random, -LANE_OFFSET * 0.55, LANE_OFFSET * 0.55) : 0;
        car.swerveTimer = range(random, 6, 18);
      }
      car.swerve += (car.swerveTarget - car.swerve) * clamp(dt * 1.6, 0, 1);

      // --- steering ---------------------------------------------------------
      const travel = alongVector(car.axis, car.dir);
      const base = lanePoint(car, along, car.swerve);
      const aimX = base.x + travel.x * AIM_AHEAD;
      const aimZ = base.z + travel.z * AIM_AHEAD;
      const wantedYaw = Math.atan2(aimX - state.x, -(aimZ - state.z));
      const headingError = wrapAngle(wantedYaw - state.yaw);

      const speedError = target - state.speed;
      car.input.steer = clamp(headingError * 2.6, -1, 1);
      car.input.throttle = speedError > 0 ? clamp(speedError * 0.55, 0, 1) : 0;
      car.input.brake = speedError < -1.2 || target < 0.4;
      car.input.handbrake = false;

      stepVehicle(state, car.input, dt);
      vehicles.sync(car, dt);

      // Out of the world, or shoved into a shop front: recycle it instead of
      // dropping a car, so the density the scene was populated with survives
      // a long session.
      if (
        Math.abs(state.x) > WORLD.extent ||
        Math.abs(state.z) > WORLD.extent ||
        (handles?.insideBuilding && handles.insideBuilding(state.x, state.z, 0))
      ) {
        recycle(car, focus);
      }
    }
  }

  return { cars, populate, clear, update };
}
