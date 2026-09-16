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
      brake: car.controls.brake, fuel: car.fuel, damage: car.damage
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
