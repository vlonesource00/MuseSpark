// M_CONTROL — reduced-order predictive model, identified against M_PLANT.
// 7-state dynamic bicycle + first-order steering actuator + axle-split
// combined-slip + exact-gear engine force. Provenance: tools/identify-model.mjs
// (closed-loop headless experiments on the real plant, Harbor main straight).
// FIT defaults are GT measurements; override per class/mode. Pure + deterministic.
import { clamp } from '../sim/math.js';

export const FIT_GT = Object.freeze({
  tauS: 1 / 12, // steering actuator lag: exact plant rate (measured tau63 0.075s)
  tauF: 0.075, // longitudinal force lag: wheel spin-up + TC + torque damp (measured)
  Cf: 89000, // front cornering stiffness N/rad (LSQ over 8 linear-window runs)
  Cr: 106000, // rear cornering stiffness N/rad (same fit)
  brakeReal: 0.9, // steady full-brake decel / envelope peak (ABS+transfer lag)
  tcRear: 0.9, // traction-circle factor at the driven axle (TC modulation)
  yawLag: 0.217 // emergent yaw-buildup tau63 (s) — for reference shaping, not state
});

export function axleGeometry(spec) {
  const lf = (1 - spec.frontWeight) * spec.wheelbase; // CG to front axle
  const lr = spec.frontWeight * spec.wheelbase;
  return { lf, lr };
}

export function createVehicleModel(spec, envelope, overrides = {}) {
  const P = { ...FIT_GT, ...(overrides.params ?? {}) };
  const { lf, lr } = axleGeometry(spec);
  const L = spec.wheelbase;
  const mass = () => spec.mass + 20 * 0.75;

  // Per-axle normal loads with aero + measured longitudinal transfer.
  function axleLoads(v, axMeas = 0) {
    const m = mass();
    const { downforce } = envelope.aeroForces(v);
    const transfer = clamp(m * axMeas * spec.cg / L, -m * 9.81 * 0.4, m * 9.81 * 0.4);
    const front = Math.max(0, m * 9.81 * (lr / L) + downforce * spec.frontAero - transfer);
    const rear = Math.max(0, m * 9.81 * (lf / L) + downforce * (1 - spec.frontAero) + transfer);
    return { front, rear };
  }

  // Exact-gear engine force (N). Falls back to best-gear when gear unknown.
  // Above 7300rpm the plant is in shift-cut territory: derate (the cut lasts
  // 0.11s and the automatic fires at 7450). Planning uses best-gear ≤7450.
  // Over-rev (rpm>8000, e.g. teleport/wrong gear): best-gear fallback, since
  // the automatic will shift within ~0.3s — never plan on zero authority.
  function engineForceGear(v, gear = 0, rpm = 0) {
    const u = Math.max(0.5, Math.abs(v));
    const force = (g) => {
      const ratio = spec.gears[g] * spec.finalDrive;
      const r = rpm > 500 ? rpm : clamp((u / spec.radius) * ratio * 9.5493, 1100, 8300);
      if (r > 8100) return -1; // signal over-rev to caller below
      const curve = clamp(1 - ((r - 5500) / 6700) ** 2, 0.45, 1);
      const f = (spec.maxTorque * curve * ratio * 0.91) / spec.radius;
      return r > 7300 ? f * 0.5 : f;
    };
    if (gear >= 1 && gear <= 6) {
      const f = force(gear);
      return f < 0 ? envelope.engineForceAt(v) : f;
    }
    return envelope.engineForceAt(v);
  }

  // Force authority at (v, axMeas, gear): {driveMax, brakeMax} in Newtons.
  function forceLimits(v, axMeas = 0, gear = 0) {
    const m = mass();
    const { front, rear } = axleLoads(v, axMeas);
    return { driveMax: engineForceGear(v, gear), brakeMax: envelope.brake(v) * m * P.brakeReal, front, rear, m };
  }

  // One step. state {x,z,yaw,vx,vy,r,delta}; control {deltaCmd (road rad), F (N)}.
  // Axle-split combined slip: front purely lateral, rear shares with F_long.
  // u.axCmd (m/s^2) overrides longitudinal (validation isolation): the circle
  // then uses |m*axCmd| as the longitudinal demand.
  // Integrator guard: explicit Euler on yaw/sideslip modes goes unstable past
  // h~0.1 (measured: model yaw explodes at h=0.12). Long MPC steps subdivide
  // transparently (controls held); API and 120Hz validation unaffected.
  function step(s, u, h, muScale = 1) {
    if (h > 0.07) {
      const n = Math.ceil(h / 0.06);
      let st = s;
      for (let k = 0; k < n; k++) st = stepInner(st, u, h / n, muScale);
      return st;
    }
    return stepInner(s, u, h, muScale);
  }
  function stepInner(s, u, h, muScale = 1) {
    const m = mass(), Iz = spec.yawInertia;
    const delta = s.delta + ((u.deltaCmd - s.delta) / P.tauS) * h;
    const FlongReq = u.axCmd !== undefined ? m * u.axCmd : u.F;
    const F = s.F ?? FlongReq;
    const FlongLag = F + ((FlongReq - F) / P.tauF) * h;
    const v = Math.max(3, s.vx);
    const aF = delta - (s.vy + lf * s.r) / v;
    const aR = -(s.vy - lr * s.r) / v;
    const grip = muScale; // caller folds surface/thermal/tyre factors (1 = nominal)
    const loadF = (N) => clamp(1 - 0.13 * Math.log(Math.max(0.1, N / 2 / 3300)), 0.68, 1.18);
    const { front: Fzf, rear: Fzr } = axleLoads(v, s.axPrev ?? 0);
    const muF = 1.48 * loadF(Fzf) * grip, muR = 1.48 * loadF(Fzr) * grip;
    let Fyf = P.Cf * aF, Fyr = P.Cr * aR;
    // Axle-split combined slip with brake-bias distribution (measured plant:
    // 58% front brake torque). Drive (F>=0, RWD) loads the rear only;
    // braking splits front/rear. Front wash under trail-braking is invisible
    // to a rear-only circle (full-lap understeer runoff with F pinned).
    const biasF = spec.brakeBias ?? 0.58;
    const FfReq = FlongLag < 0 ? biasF * FlongLag : 0;
    const FrReq = FlongLag < 0 ? (1 - biasF) * FlongLag : FlongLag;
    const fMaxF = muF * Fzf;
    const useF = Math.hypot(Fyf, FfReq);
    const kF = useF > fMaxF && useF > 1e-6 ? fMaxF / useF : 1;
    Fyf *= kF;
    const Ff = FfReq * kF;
    // Rear: combined circle with longitudinal force.
    const fMaxR = muR * Fzr;
    const useR = Math.hypot(Fyr, FrReq);
    const kR = useR > fMaxR && useR > 1e-6 ? fMaxR / useR : 1;
    Fyr *= kR;
    const Fr = FrReq * kR;
    const Flong = Ff + Fr;
    const q = 0.5 * 1.225 * v * v;
    const drag = q * spec.area * spec.cd, rr = 0.013 * m * 9.81;
    const ax = u.axCmd !== undefined
      ? u.axCmd
      : (Flong - drag * Math.sign(s.vx) - rr * Math.sign(s.vx)) / m;
    const ay = (Fyf + Fyr) / m;
    const dr = (lf * Fyf - lr * Fyr) / Iz;
    const vx = s.vx + (ax + s.r * s.vy) * h;
    const vy = s.vy + (ay - s.r * s.vx) * h;
    const r = s.r + dr * h;
    const yaw = s.yaw + r * h;
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    return {
      x: s.x + (s.vx * sn + s.vy * c) * h,
      z: s.z + (s.vx * c - s.vy * sn) * h,
      yaw, vx, vy, r, delta, F: FlongLag, axPrev: ax, ax, ay,
      utilF: Math.abs(Fyf) / Math.max(1, fMaxF),
      utilR: Math.hypot(Fyr, Flong) / Math.max(1, fMaxR)
    };
  }

  function rollout(x0, useq, h) {
    let s = { ...x0 };
    const out = [{ ...s, t: 0 }];
    for (let k = 0; k < useq.length; k++) { s = step(s, useq[k], h); out.push({ ...s, t: (k + 1) * h }); }
    return out;
  }

  function fromCar(car) {
    const m = mass();
    const v = Math.max(3, Math.abs(car.u));
    const q = 0.5 * 1.225 * v * v;
    const Fest = m * car.ax + q * spec.area * spec.cd * Math.sign(car.u) + 0.013 * m * 9.81 * Math.sign(car.u);
    return {
      x: car.x, z: car.z, yaw: car.yaw, vx: car.u, vy: car.v, r: car.yawRate,
      delta: car.steering, F: Fest, axPrev: car.ax, ax: car.ax, ay: car.ay
    };
  }

  return { params: P, lf, lr, step, rollout, axleLoads, engineForceGear, forceLimits, fromCar };
}
