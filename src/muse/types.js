// MuseSpark plant-agnostic AI API — core AI never touches Vehicle directly.
// Native Astra-derived game adapts to this contract; later Benchmark adapts
// to the EXACT same contract with zero core changes.
/**
 * @typedef {Object} MuseObservation
 * @property {number} time @property {number} dt
 * @property {{x,z,vx,vz,yaw,yawRate,speed,slip,s,q,steer,throttle,brake,fuel,damage}} ego
 * @property {{length, halfWidth, wetness, curvatureAt:(s)=>number, speedLimitAt:(s)=>number}} track
 * @property {Array<{id,s,q,speed,x,z}>} rivals
 * @property {{lap, mode, phase}} race
 */
/**
 * @typedef {Object} MuseCommand
 * @property {number} steering @property {number} throttle @property {number} brake
 * @property {string} brakeSource @property {string} state
 */
export function observationFromGame({ time, dt, car, track, cars, line, mode = 'SPRINT', phase = 'racing' }) {
  const cur = track.nearest ? track.nearest(car.x, car.z) : track.surface(car.x, car.z);
  const rivals = cars.filter((c) => c !== car).map((c) => {
    const p = track.nearest ? track.nearest(c.x, c.z) : { s: c.s, lateral: c.lateral };
    return { id: c.id, s: p.s ?? c.s, q: p.lateral ?? c.lateral, speed: c.speed, x: c.x, z: c.z };
  });
  return {
    time, dt,
    ego: {
      id: car.id, x: car.x, z: car.z, vx: car.vx, vz: car.vz, yaw: car.yaw, yawRate: car.yawRate,
      u: car.u, v: car.v, speed: car.speed, slip: Math.atan2(car.v, Math.max(4, Math.abs(car.u))),
      s: cur.s ?? car.s, q: cur.lateral ?? car.lateral, steer: car.steering, throttle: car.controls.throttle,
      brake: car.controls.brake, fuel: car.fuel, damage: car.damage,
      // Thermal state (plant-agnostic scalars): hottest core °C, worst wear 0..1.
      tyreMax: maxCore(car), tyreWear: maxWear(car)
    },
    trackRef: track,
    track: {
      length: track.length, halfWidth: track.halfWidth, wetness: track.wetness ?? 0,
      curvatureAt: (s) => track.at(s).curvature,
      speedLimitAt: (s) => (line ? line.speedAt(s) : 60)
    },
    rivals, race: { lap: car.race?.lap ?? 1, mode, phase }
  };
}

export function applyCommand(car, cmd) {
  car.controls = { steer: cmd.steering, throttle: cmd.throttle, brake: cmd.brake };
}

function maxCore(car) {
  try {
    return Math.max(...car.wheels.map((w) => w.tyre?.core ?? 70));
  } catch { return 70; }
}

function maxWear(car) {
  try {
    return Math.max(...car.wheels.map((w) => w.tyre?.wear ?? 0));
  } catch { return 0; }
}

// Thermal pace derate: mirrors the plant's OWN tyreGrip falloff
// (1-((T-85)/105)^2, floor .65) as a pace-margin factor, steepened (^1.5)
// for transient headroom — the limit leaves nothing for bumps/overshoot, and
// a 5% grip loss at zero headroom spins (lap-2 kink, 2026-09-16). Cool rubber
// is unaffected (1.0^1.5 = 1.0): lap-1 attack pace is protected.
// The DRIVER adapts its margin; the plant is never touched.
export function thermalMargin(tyreMax, tyreWear = 0) {
  const plant = Math.min(1, Math.max(0.65, 1 - ((Math.max(0, tyreMax - 85) / 105) ** 2)));
  const temp = plant ** 1.5;
  const wear = 1 - Math.min(0.35, tyreWear * 0.35);
  return Math.min(1, Math.max(0.5, temp * wear));
}
