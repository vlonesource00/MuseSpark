// MuseSpark physical performance envelope — real forces, no arcade scaling.
// Inherited plant constants come from ../sim/car-specs.js + tyre.js + vehicle.js
// (Astra GT validated specification). This module only READS the plant; it never
// grants power, grip or braking force.
import { clamp } from '../sim/math.js';
import { tyreGrip } from '../sim/tyre.js';

export const NOMINAL_TYRE = { core: 90, pressure: 2.15, wear: 0 };

function loadFactor(load) {
  return clamp(1 - 0.13 * Math.log(Math.max(0.1, load / 3300)), 0.68, 1.18);
}

// Best-gear engine force at speed v (full throttle, shifts like Vehicle.automatic).
export function engineForceAt(spec, v, damage = 0) {
  const u = Math.max(0.5, Math.abs(v));
  let best = 0;
  for (let g = 1; g <= 6; g++) {
    const ratio = spec.gears[g] * spec.finalDrive;
    const rpm = clamp((u / spec.radius) * ratio * 9.5493, 1100, 8300);
    if (rpm > 8100) continue;
    const curve = clamp(1 - ((rpm - 5500) / 6700) ** 2, 0.45, 1);
    const f = spec.maxTorque * curve * ratio * 0.91 * (1 - damage * 0.28);
    if (f > best) best = f;
  }
  return best;
}

export function aeroForces(spec, v, wingDelta = 0, wake = 0, damage = 0) {
  const q = 0.5 * 1.225 * v * v;
  const downforce = q * spec.area * (spec.cl + wingDelta * 0.11) * (1 - wake * 0.32);
  const drag = q * spec.area * (spec.cd + wingDelta * 0.013) * (1 - wake * 0.24) * (1 + damage * 0.2);
  return { q, downforce, drag };
}

export function createEnvelope(spec, opts = {}) {
  const fuel = opts.fuel ?? 20;
  const gripScale = opts.gripScale ?? (spec.tyreGrip ?? 1);
  const wetness = opts.wetness ?? 0;
  const surfaceGrip = (opts.surfaceGrip ?? 1) * (1 - wetness * 0.36);
  const mass = () => spec.mass + fuel * 0.75;

  function totalNormal(v) {
    const m = mass();
    const { downforce } = aeroForces(spec, v);
    return m * 9.81 + downforce;
  }
  // Peak lateral acceleration (m/s^2) at speed v, steady state, asphalt.
  function lateral(v) {
    const N = totalNormal(v);
    const avgLoad = N / 4;
    // tyreGrip() at nominal temp/pressure/wear gives ~1.48 * loadFactor.
    const mu = 1.48 * loadFactor(avgLoad) * gripScale * surfaceGrip;
    return (mu * N) / mass();
  }
  function drive(v, damage = 0) {
    const m = mass();
    const F = engineForceAt(spec, v, damage);
    const { drag } = aeroForces(spec, v, 0, 0, damage);
    // Rolling resistance ~0.013 * N (matches Vehicle).
    const N = totalNormal(v);
    return Math.max(0, (F - drag) / m - 0.013 * 9.81);
  }
  function brake(v, damage = 0) {
    const m = mass();
    const N = totalNormal(v);
    const avgLoad = N / 4;
    const mu = 1.48 * loadFactor(avgLoad) * gripScale * surfaceGrip;
    const tyreLimit = (mu * N) / m;
    // Actuator path: total brake torque 2*spec.brakeTorque -> force.
    const actuator = ((2 * spec.brakeTorque) / spec.radius) / m;
    const { drag } = aeroForces(spec, v);
    return Math.min(actuator, tyreLimit) + drag / m + 0.013 * 9.81;
  }
  // Combined-slip availability: given lateral demand ay (m/s^2), how much
  // longitudinal accel remains. Returns {latAvail, longAvail, ul}.
  function combined(v, ayDemand, kind = 'drive') {
    const lat = lateral(v);
    const ul = clamp(Math.abs(ayDemand) / Math.max(1, lat), 0, 0.999);
    const scale = Math.sqrt(1 - ul * ul);
    const cap = kind === 'brake' ? brake(v) : drive(v);
    return { lateral: lat, longitudinal: cap * scale, utilization: ul, scale };
  }
  // Throttle physics gate: full engine torque requests F_eng; if remaining
  // longitudinal tyre capability exceeds it, FULL THROTTLE IS LEGAL even when
  // normalized reserve looks small. Never scale throttle by reserve fraction.
  function throttleLegal(v, ayDemand, damage = 0) {
    const m = mass();
    const N = totalNormal(v);
    const avgLoad = N / 4;
    const mu = 1.48 * loadFactor(avgLoad) * gripScale * surfaceGrip;
    const peakLong = (mu * N) / 2; // rear-axle limited for RWD GT (conservative half)
    const lat = lateral(v);
    const ul = clamp(Math.abs(ayDemand) / Math.max(1, lat), 0, 0.999);
    const remaining = peakLong * Math.sqrt(1 - ul * ul);
    const request = engineForceAt(spec, v, damage);
    return { legal: remaining >= request, remaining, request, ul };
  }
  return { spec, lateral, drive, brake, combined, throttleLegal, totalNormal, engineForceAt: (v, d) => engineForceAt(spec, v, d), aeroForces: (v) => aeroForces(spec, v) };
}
