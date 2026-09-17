// M2h-a — Identify the reduced control model (M_CONTROL) against M_PLANT.
// Experiments: steering actuator, steady-state bicycle fit (Cf/Cr), transient
// step response, straight accel/brake, combined circle, steer-rate capability.
// Prints fitted params + open-loop RMSE at 0.25/0.5/1/1.5/2.0s + capability
// factors consumed by T_PROFILE accounting and the predictive controller.
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { createVehicleModel, FIT_GT } from '../src/muse/vehicle-model.js';

const SPEC = carSpecFor('gt');
const envelope = createEnvelope(SPEC, { fuel: 20 });
const model = createVehicleModel(SPEC, envelope); // M_CONTROL under test
const track = new Track('harbor-ring');
const DT = 1 / 120;
const lf = (1 - SPEC.frontWeight) * SPEC.wheelbase; // CG to front axle
const lr = SPEC.frontWeight * SPEC.wheelbase;

function freshCar(s = 100, q = 0, v = 20) {
  const c = new Vehicle(0, 'IDENT', '#fff', 'gt');
  c.place(track, s, q, v);
  return c;
}
// Straight-pavement guard: Harbor main straight only (s in [80,560]).
function checkAsphalt(c, tag) {
  const p = track.surface(c.x, c.z);
  if (p.zone !== 'asphalt' || Math.abs(p.lateral) > 7.5) {
    console.log(`  !! ${tag} left usable asphalt (zone=${p.zone} lat=${p.lateral.toFixed(1)}) — result suspect`);
    return false;
  }
  return true;
}
// ------------------------------------------------ 2b. longitudinal force lag
// Rolling step throttle 0->1 (gear held, no shift): how fast does ax arrive?
// Covers wheel spin-up + TC + torque-damp — the lag every pickup/release pays.
{
  const c = freshCar(150, 0, 25);
  for (let i = 0; i < 60; i++) { c.controls = { steer: 0, throttle: 0.3, brake: 0 }; c.step(DT, track, 0); }
  const ax0 = c.ax;
  const log = [];
  for (let i = 0; i < 60; i++) { c.controls = { steer: 0, throttle: 1, brake: 0 }; c.step(DT, track, 0); log.push(c.ax); }
  const axF = log.at(-1);
  const t63 = log.findIndex((a) => a >= ax0 + (axF - ax0) * 0.632) * DT;
  console.log(`FORCE-LAG throttle tau63=${t63.toFixed(3)}s (${ax0.toFixed(1)} -> ${axF.toFixed(1)} m/s^2, gear ${c.gear})`);
}
function stepCar(c, steer, thr, brk, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    c.controls = { steer, throttle: thr, brake: brk };
    c.step(DT, track, 0);
    out.push({ t: i * DT, steer: c.steering, yawRate: c.yawRate, u: c.u, v: c.v, speed: c.speed, ax: c.ax, ay: c.ay, x: c.x, z: c.z, yaw: c.yaw });
  }
  return out;
}
const beta = (r) => Math.atan2(r.v, Math.max(4, Math.abs(r.u)));

// ------------------------------------------------ 1. steering actuator
let tauMeas = 0;
{
  const c = freshCar(100, 0, 30);
  const log = stepCar(c, 1, 0.3, 0, 120);
  // fit first-order tau to reach 63.2% of final
  const fin = log.at(-1).steer;
  const t63 = log.find((r) => r.steer >= fin * 0.632)?.t ?? NaN;
  tauMeas = t63;
  console.log(`ACTUATOR tau63=${tauMeas.toFixed(4)}s (plant rate 12 => 1/12=${(1 / 12).toFixed(4)}s)`);
}
// ------------------------------------------------ 2. steady-state Cf/Cr fit
// Small steers, short settle, straight pavement, linear window ay in 2..6.
// Higher speeds need tiny steers to stay linear.
const runs = [];
for (const [V, fracs] of [[20, [0.03, 0.05, 0.07]], [30, [0.015, 0.025, 0.035]], [38, [0.01, 0.018, 0.026]]]) {
  for (const frac of fracs) {
    const c = freshCar(200, 0, V);
    const log = stepCar(c, frac, 0.3, 0, 100); // settle 0.83s
    const e = log.at(-1);
    const ok = checkAsphalt(c, `fit V=${V} d=${frac}`);
    const ay = Math.abs(e.ay);
    if (!ok || ay < 2 || ay > 6) { console.log(`  skip V=${V} d=${frac} ay=${e.ay.toFixed(1)}`); continue; }
    runs.push({ v: Math.abs(e.u), delta: e.steer, vy: e.v, r: e.yawRate, ay: e.ay });
    console.log(`  run V=${V} d=${frac}: r=${e.yawRate.toFixed(3)} beta=${beta(e).toFixed(3)} ay=${e.ay.toFixed(1)}`);
  }
}
// steady-state bicycle: [m*v*r] = Cf*aF + Cr*aR ; [0] = lf*Cf*aF - lr*Cr*aR
// with aF = delta-(vy+lf*r)/v, aR = -(vy-lr*r)/v. Solve normal equations.
let Cf = 0, Cr = 0;
{
  // unknowns x=[Cf,Cr]; rows: [aF, aR] -> m*v*r ; [lf*aF, -lr*aR] -> 0
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  const m = SPEC.mass + 20 * 0.75;
  for (const r of runs) {
    const aF = r.delta - (r.vy + lf * r.r) / r.v, aR = -(r.vy - lr * r.r) / r.v;
    const rows = [
      { j1: aF, j2: aR, y: m * r.v * r.r },
      { j1: lf * aF, j2: -lr * aR, y: 0 }
    ];
    for (const { j1, j2, y } of rows) { a11 += j1 * j1; a12 += j1 * j2; a22 += j2 * j2; b1 += j1 * y; b2 += j2 * y; }
  }
  const det = a11 * a22 - a12 * a12;
  Cf = (b1 * a22 - b2 * a12) / det;
  Cr = (a11 * b2 - a12 * b1) / det;
  console.log(`BICYCLE fit over ${runs.length} runs: Cf=${(Cf / 1000).toFixed(1)}kN/rad Cr=${(Cr / 1000).toFixed(1)}kN/rad`);
}
// ------------------------------------------------ 3. transient step RMSE
// Validates the MODULE (M_CONTROL) open-loop vs plant. Longitudinal forced to
// recorded ax (lateral/yaw isolation).
function rolloutModule(x0, controls, h) {
  let s = { ...x0, axPrev: 0 };
  const out = [];
  for (let k = 0; k < controls.length; k++) {
    s = model.step(s, { deltaCmd: controls[k].deltaCmd, F: 0, axCmd: controls[k].forceAx }, h);
    out.push(s);
  }
  return out;
}
const horizons = [0.25, 0.5, 1.0, 1.5, 2.0];
{
  // plant: step steer 0 -> 0.08 lock at 30 m/s, stays on asphalt throughout.
  // Model is driven longitudinally by RECORDED plant ax: isolates lateral/yaw.
  const c = freshCar(150, 0, 30);
  const plant = [];
  for (let i = 0; i < 180; i++) {
    c.controls = { steer: i < 12 ? 0 : 0.08, throttle: 0.45, brake: 0 };
    c.step(DT, track, 0);
    if (i >= 12) plant.push({ x: c.x, z: c.z, yaw: c.yaw, vx: c.u, vy: c.v, r: c.yawRate, ax: c.ax });
  }
  const ok = checkAsphalt(c, 'transient');
  // yaw-lag tau: time for r to reach 63% of its 0.5s value
  const rRef = plant[Math.min(60, plant.length - 1)].r;
  const t63y = plant.findIndex((p) => Math.abs(p.r) >= Math.abs(rRef) * 0.632) * DT;
  console.log(`YAW-LAG tau63=${t63y.toFixed(3)}s to r=${rRef.toFixed(3)} ${ok ? '' : '(suspect)'}`);
  const p0 = plant[0];
  const x0 = { x: p0.x, z: p0.z, yaw: p0.yaw, vx: p0.vx, vy: p0.vy, r: p0.r, delta: 0 };
  const h = 1 / 120;
  // model lateral/yaw free, longitudinal FORCED to recorded ax (isolation)
  const controls = plant.map((p) => ({ deltaCmd: 0.08 * SPEC.steeringLock, forceAx: p.ax }));
  const model = rolloutModule(x0, controls, h);
  console.log('TRANSIENT step-steer RMSE (model open-loop vs plant):');
  for (const H of horizons) {
    const k = Math.min(Math.round(H / h), plant.length - 1, model.length - 1);
    const p = plant[k], m = model[k]; // model[0] is the initial state = plant pre-state; M[j]~plant[j]
    const dx = p.x - m.x, dz = p.z - m.z;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const fwd = dx * fx + dz * fz, lat = dx * fz - dz * fx;
    const d = { pos: Math.hypot(dx, dz), yaw: Math.abs(p.yaw - m.yaw), v: Math.abs(Math.hypot(p.vx, p.vy) - Math.hypot(m.vx, m.vy)), r: Math.abs(p.r - m.r) };
    console.log(`  t=${H.toFixed(2)}s pos=${d.pos.toFixed(3)}m (fwd=${fwd.toFixed(3)} lat=${lat.toFixed(3)}) yaw=${d.yaw.toFixed(4)} v=${d.v.toFixed(2)} r=${d.r.toFixed(3)}`);
  }
}
// ------------------------------------------------ 4/5. straight accel/brake
// Main straight ONLY (s=150..560). Diagnose per speed, not just the mean.
{
  let c = freshCar(150, 0, 15);
  console.log('DRIVE straight full-throttle:');
  for (let i = 0; i < 500 && c.speed < 48; i++) {
    c.controls = { steer: 0, throttle: 1, brake: 0 };
    c.step(DT, track, 0);
    if (i % 100 === 0) console.log(`  v=${c.speed.toFixed(1)} ax=${c.ax.toFixed(2)} pred=${envelope.drive(c.speed).toFixed(2)} gear=${c.gear} rpm=${c.rpm.toFixed(0)}`);
  }
  checkAsphalt(c, 'drive');
  c = freshCar(150, 0, 45);
  console.log('BRAKE straight full:');
  for (let i = 0; i < 400 && c.speed > 10; i++) {
    c.controls = { steer: 0, throttle: 0, brake: 1 };
    c.step(DT, track, 0);
    if (i % 60 === 0) console.log(`  v=${c.speed.toFixed(1)} decel=${(-c.ax).toFixed(2)} pred=${envelope.brake(c.speed).toFixed(2)}`);
  }
  checkAsphalt(c, 'brake');
}
// ------------------------------------------------ 6. combined circle
// Steady arc on straight pavement (short settle, small steer), then throttle
// ramp. Verifies the friction-circle split, not absolute pace.
{
  const c = freshCar(200, 0, 25);
  for (let i = 0; i < 100; i++) { c.controls = { steer: 0.06, throttle: 0.3, brake: 0 }; c.step(DT, track, 0); }
  const ay0 = c.ay, v0 = c.speed;
  checkAsphalt(c, 'combined-settle');
  let axMax = 0;
  for (let i = 0; i < 100; i++) { c.controls = { steer: 0.06, throttle: 1, brake: 0 }; c.step(DT, track, 0); axMax = Math.max(axMax, c.ax); }
  checkAsphalt(c, 'combined-power');
  const latCap = envelope.lateral(v0);
  const ul = Math.abs(ay0) / latCap;
  const predLong = envelope.drive(v0) * Math.sqrt(Math.max(0, 1 - ul * ul));
  console.log(`COMBINED arc ay=${ay0.toFixed(1)} (ul=${ul.toFixed(2)}): max ax=${axMax.toFixed(2)} vs circle-pred ${predLong.toFixed(2)}`);
}
// ------------------------------------------------ 7. steer-rate capability
{
  const c = freshCar(200, 0, 30);
  let maxRate = 0, prev = 0;
  for (let i = 0; i < 120; i++) {
    c.controls = { steer: i < 60 ? -1 : 1, throttle: 0.4, brake: 0 };
    c.step(DT, track, 0);
    maxRate = Math.max(maxRate, Math.abs(c.steering - prev) / DT);
    prev = c.steering;
  }
  console.log(`STEER-RATE max road-wheel rate: ${maxRate.toFixed(2)} rad/s (lock ${SPEC.steeringLock})`);
}
