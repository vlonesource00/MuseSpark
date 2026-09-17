// M_CONTROL validation: fitted params sane + open-loop vs plant RMSE bounds.
// Bounds come from tools/identify-model.mjs with headroom (see FIT provenance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { createVehicleModel, FIT_GT, axleGeometry } from '../src/muse/vehicle-model.js';

const SPEC = carSpecFor('gt');
const envelope = createEnvelope(SPEC, { fuel: 20 });
const model = createVehicleModel(SPEC, envelope);

test('fit provenance: actuator = plant rate, stiffness sane, brake factor measured', () => {
  assert.equal(FIT_GT.tauS, 1 / 12);
  assert.ok(FIT_GT.Cf > 40000 && FIT_GT.Cf < 200000, `Cf=${FIT_GT.Cf}`);
  assert.ok(FIT_GT.Cr > 40000 && FIT_GT.Cr < 220000, `Cr=${FIT_GT.Cr}`);
  assert.ok(FIT_GT.brakeReal > 0.7 && FIT_GT.brakeReal <= 1, `brakeReal=${FIT_GT.brakeReal}`);
  assert.ok(FIT_GT.tauF > 0.03 && FIT_GT.tauF < 0.2, `tauF=${FIT_GT.tauF}`);
  const { lf, lr } = axleGeometry(SPEC);
  assert.ok(Math.abs(lf + lr - SPEC.wheelbase) < 1e-9);
  assert.ok(Math.abs(lr / SPEC.wheelbase - SPEC.frontWeight) < 1e-9);
});

test('engine force is Newtons at the contact patch (axle torque / radius)', () => {
  // Gear 1 @ 15 m/s: crank 575Nm x 11.59 x 0.91 / 0.335m ≈ 17-18kN (tire-limited
  // in practice; the transient combined model, not this number, caps it).
  const f = model.engineForceGear(15, 1);
  assert.ok(f > 14000 && f < 22000, `F=${f}`);
  // High gear cruise: force falls with speed.
  assert.ok(model.engineForceGear(60, 6) < model.engineForceGear(20, 2));
});

test('drive() is traction-capped at low speed, engine-limited at high speed', () => {
  const a15 = envelope.drive(15), a45 = envelope.drive(45);
  assert.ok(a15 > 6 && a15 < 11, `drive(15)=${a15} (plant measured ~8.4)`);
  assert.ok(a45 > 3 && a45 < 6, `drive(45)=${a45} (plant 4th-gear ~4.5)`);
});

test('open-loop step-steer RMSE bounds (lateral isolation, straight pavement)', () => {
  const track = new Track('harbor-ring');
  const DT = 1 / 120;
  const c = new Vehicle(0, 'T', '#fff', 'gt');
  c.place(track, 150, 0, 30);
  const plant = [];
  for (let i = 0; i < 140; i++) {
    c.controls = { steer: i < 12 ? 0 : 0.08, throttle: 0.45, brake: 0 };
    c.step(DT, track, 0);
    if (i >= 12) plant.push({ x: c.x, z: c.z, yaw: c.yaw, vx: c.u, vy: c.v, r: c.yawRate, ax: c.ax });
  }
  const p0 = plant[0];
  const h = DT;
  const check = (H, posLim, yawLim) => {
    const k = Math.min(Math.round(H / h), plant.length - 1);
    // NOTE: fresh rollout per horizon (open-loop from t0, the MPC use case).
    let t = { x: p0.x, z: p0.z, yaw: p0.yaw, vx: p0.vx, vy: p0.vy, r: p0.r, delta: 0, axPrev: 0 };
    for (let j = 0; j < k; j++) t = model.step(t, { deltaCmd: 0.08 * SPEC.steeringLock, F: 0, axCmd: plant[j].ax }, h);
    const p = plant[k];
    assert.ok(Math.hypot(p.x - t.x, p.z - t.z) < posLim, `pos@${H}s`);
    assert.ok(Math.abs(p.yaw - t.yaw) < yawLim, `yaw@${H}s`);
  };
  check(0.5, 0.5, 0.05);
  check(1.0, 1.0, 0.08);
});

test('force mapping is complementary (never throttle+brake together)', () => {
  const m = SPEC.mass + 20 * 0.75;
  const mapPedals = (F, v) => {
    if (F >= 0) return { throttle: Math.min(1, F / Math.max(1, model.engineForceGear(v, 3))), brake: 0 };
    return { throttle: 0, brake: Math.min(1, -F / Math.max(1, model.forceLimits(v).brakeMax)) };
  };
  for (const F of [-20000, -5000, -100, 0, 100, 5000, 15000]) {
    const p = mapPedals(F, 30);
    assert.ok(!(p.throttle > 0 && p.brake > 0), `overlap at F=${F}`);
    assert.ok(p.throttle >= 0 && p.throttle <= 1 && p.brake >= 0 && p.brake <= 1);
  }
});
