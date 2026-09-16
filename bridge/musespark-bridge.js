// MuseSpark benchmark bridge — shared-physics boundary (shadow pattern).
//
// Host owns ALL physics (vehicle stepping, tyres, wakes, collisions, track).
// Per host car we keep a same-shape shadow (Muse Vehicle on Muse Track;
// plant files are identical to the host's) synced field-by-field each tick.
// MuseDriver runs ONLY on shadows; resulting controls copy to the host car.
// Core Muse AI is unchanged: same GlobalLine, envelope, belief, strategy,
// trajectory, MPCC, safety, scheduler as the native game.
//
// NOTE ON PROVENANCE: this file is canonical in the MuseSpark repo at
// bridge/musespark-bridge.js (imports '../src/...'). The installer
// (tools/install-benchmark-bridge.mjs) copies it verbatim to
// benchmark/sandbox/bridges/musespark-bridge.js rewriting ONLY the import
// prefix to '../../subjects/musespark/src/...'. No logic differs.
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { optimizeGlobal, GlobalLine } from '../src/muse/global-opt.js';
import { MuseDriver } from '../src/muse/driver.js';

export const MUSE_CANDIDATE = Object.freeze({
  id: 'musespark',
  label: 'MuseSpark',
  color: '#b45cff',
  stack: 'Global optimum → belief → strategy → trajectory → coupled MPCC → safety'
});

const finite = (v, f = 0) => (Number.isFinite(v) ? v : f);

// Host spec → Muse spec. Same SI fields (unit/schema conversion only —
// never pace tuning; values are the host's own declared plant).
export function mapHostSpec(hostSpec = {}, fallback = carSpecFor('gt')) {
  const f = fallback;
  return Object.freeze({
    ...f,
    key: hostSpec.key ?? f.key,
    mass: finite(hostSpec.mass, f.mass),
    wheelbase: finite(hostSpec.wheelbase, f.wheelbase),
    track: finite(hostSpec.track, f.track),
    cg: finite(hostSpec.cg ?? hostSpec.cgHeight, f.cg),
    frontWeight: finite(hostSpec.frontWeight, f.frontWeight),
    yawInertia: finite(hostSpec.yawInertia, f.yawInertia),
    radius: finite(hostSpec.radius, f.radius),
    wheelInertia: finite(hostSpec.wheelInertia, f.wheelInertia),
    maxTorque: finite(hostSpec.maxTorque, f.maxTorque),
    gears: hostSpec.gears ?? f.gears,
    finalDrive: finite(hostSpec.finalDrive, f.finalDrive),
    steeringLock: finite(hostSpec.steeringLock, f.steeringLock),
    area: finite(hostSpec.area, f.area),
    cd: finite(hostSpec.cd, f.cd),
    cl: finite(hostSpec.cl, f.cl),
    brakeTorque: finite(hostSpec.brakeTorque, f.brakeTorque),
    brakeBias: finite(hostSpec.brakeBias ?? hostSpec.setup?.brakeBias, f.brakeBias),
    tyreGrip: finite(hostSpec.tyreGrip, f.tyreGrip),
    frontAero: finite(hostSpec.frontAero, f.frontAero),
    drive: hostSpec.drive ?? f.drive
  });
}

// Offline global line per distinct plant, shared across bridges in-process.
const lineCache = new Map();
export function museLineFor(spec, wetness = 0) {
  const key = JSON.stringify([spec.mass, spec.wheelbase, spec.track, spec.cg, spec.frontWeight, spec.yawInertia, spec.radius, spec.maxTorque, spec.gears, spec.finalDrive, spec.steeringLock, spec.area, spec.cd, spec.cl, spec.brakeTorque, spec.tyreGrip, wetness]);
  if (!lineCache.has(key)) {
    const track = new Track('harbor-ring');
    const envelope = createEnvelope(spec, { fuel: 20, wetness });
    const solution = optimizeGlobal(track, envelope, { widths: [120, 50], amplitudes: [2.0, 0.8], sweeps: 1, step: 5, skill: 1.0 });
    lineCache.set(key, { track, line: new GlobalLine(track, solution), solution, envelope });
  }
  return lineCache.get(key);
}

// Same-shape shadow sync: copy observed host state, never step shadow physics.
export function syncMuseShadow(shadow, host) {
  shadow.x = finite(host.x); shadow.z = finite(host.z); shadow.y = finite(host.y);
  shadow.yaw = finite(host.yaw);
  shadow.vx = finite(host.vx); shadow.vz = finite(host.vz);
  shadow.u = finite(host.u); shadow.v = finite(host.v);
  shadow.speed = finite(host.speed);
  shadow.yawRate = finite(host.yawRate);
  shadow.ax = finite(host.ax); shadow.ay = finite(host.ay);
  shadow.steering = finite(host.steering);
  shadow.fuel = finite(host.fuel, 20); shadow.damage = finite(host.damage);
  shadow.gear = host.gear ?? shadow.gear; shadow.rpm = finite(host.rpm, shadow.rpm);
  shadow.s = finite(host.s); shadow.lateral = finite(host.lateral);
  Object.assign(shadow.controls, host.controls);
  const hw = host.wheels ?? [];
  for (let i = 0; i < shadow.wheels.length; i++) {
    const src = hw[i] ?? {}, st = src.tyre ?? {};
    const w = shadow.wheels[i];
    w.load = finite(src.load, w.load); w.omega = finite(src.omega, w.omega); w.steer = finite(src.steer, w.steer);
    Object.assign(w.tyre, {
      core: finite(st.core, 68), surface: finite(st.surface, 72), pressure: finite(st.pressure, w.tyre.pressure),
      wear: finite(st.wear, 0), alpha: finite(st.alpha, 0), kappa: finite(st.kappa, 0),
      fx: finite(st.fx, 0), fy: finite(st.fy, 0)
    });
  }
  return shadow;
}

export function createMuseBridge({ candidate = MUSE_CANDIDATE, cars, hostTrack, index, options = {} }) {
  if (!cars || !hostTrack) throw new Error('createMuseBridge needs {cars, hostTrack}');
  const hostCar = cars[index];
  const spec = mapHostSpec(hostCar?.spec);
  const built = museLineFor(spec, hostTrack.wetness ?? 0);
  if (Math.abs(built.track.length - hostTrack.length) > 1e-6) {
    throw new Error('Muse/host Harbor Ring geometry mismatch');
  }
  const shadows = cars.map((c, i) => {
    const sh = new Vehicle(c?.id ?? i, c?.name ?? `MUSE-${i}`, c?.color ?? '#b45cff', 'gt');
    sh.spec = mapHostSpec(c?.spec, spec);
    return sh;
  });
  const ego = shadows[index];
  const makeDriver = () => new MuseDriver(index, built.track, built.line, createEnvelope(ego.spec, { fuel: 20 }), {
    skill: options.skill ?? 0.955 + (index % 4) * 0.008,
    aggression: options.aggression ?? 0.72,
    mode: options.mode ?? 'SPRINT',
    spec: ego.spec
  });
  let driver = makeDriver();
  const entry = {
    ...candidate,
    controller: driver,
    shadows,
    errors: 0,
    lastError: null,
    update(car, _cars, dt, context) {
      try {
        for (let i = 0; i < cars.length; i++) syncMuseShadow(shadows[i], cars[i]);
        driver.update(ego, shadows, dt, context ?? null);
        car.controls = { steer: ego.controls.steer, throttle: ego.controls.throttle, brake: ego.controls.brake };
      } catch (error) {
        this.errors += 1;
        this.lastError = error;
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset() {
      driver = makeDriver();
      entry.controller = driver;
      entry.errors = 0;
      entry.lastError = null;
    },
    debug() {
      const m = driver.debug?.maneuver;
      return {
        architecture: 'MuseSpark',
        state: driver.state,
        maneuver: m?.type ?? null,
        flank: m?.flank ?? null,
        targetSpeed: driver.targetSpeed,
        brakeSource: driver.brakeSource,
        theoreticalLap: driver.theoreticalLap,
        planSource: 'Muse GlobalLine (offline time-optimal, host-identical plant)',
        controllerCadence: '120 Hz control · 15-22 Hz trajectory · 7 Hz strategy',
        compute: driver.debug?.ms ?? null,
        explanation: driver.debug?.explanation ?? ''
      };
    },
    visualDebug() {
      const w = driver.debug?.winner;
      return {
        selectedTrajectory: w ? { points: w.points.map((p) => ({ x: p.x, z: p.z })), color: '#b45cff', mode: driver.state } : null,
        trackingPoint: null
      };
    }
  };
  return entry;
}
