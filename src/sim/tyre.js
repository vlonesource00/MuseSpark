import { clamp, damp } from './math.js';

export function createTyre(pressure = 1.65) {
  return { surface: 72, core: 68, inner: 73, outer: 71, coldPressure: pressure, pressure: pressure, wear: 0, alpha: 0, kappa: 0, fx: 0, fy: 0, utilisation: 0, slipPower: 0 };
}

// Shared by the force solver and the driver's performance estimator.
export function tyreGrip(t, load) {
  return 1.48 * clamp(1 - ((t.core - 85) / 105) ** 2, .65, 1)
    * clamp(1 - Math.abs(t.pressure - 2.15) * .13, .8, 1)
    * clamp(1 - .13 * Math.log(Math.max(.1, load / 3300)), .68, 1.18)
    * (1 - t.wear * .35);
}

// Transient combined-slip tyre, SI forces and velocities, bar gauge pressures.
// Analytic saturation + relaxation lengths; no proprietary tyre measurements.
export function tyreForce(t, { vx, vy, omega, radius, load, grip, camber = -0.035, ambient = 24 }, dt) {
  const speed = Math.max(2.5, Math.abs(vx));
  t.kappa = damp(t.kappa, clamp((omega * radius - vx) / speed, -2, 2), speed / 0.32, dt);
  t.alpha = damp(t.alpha, Math.atan2(vy, speed), speed / 0.45, dt);
  const peak = Math.max(0, grip * load * tyreGrip(t, load));
  const sx = t.kappa * 10.5, sy = Math.tan(clamp(t.alpha, -1.2, 1.2)) * 8.6;
  const slip = Math.hypot(sx, sy);
  // Saturation is continuous through zero and retains sliding friction.
  const shape = Math.tanh(slip) * (1 - 0.16 * clamp((slip - 1.4) / 5, 0, 1));
  t.fx = slip > 0.00001 ? peak * shape * sx / slip : 0;
  t.fy = slip > 0.00001 ? -peak * shape * sy / slip : 0;
  t.fy -= camber * load * 0.035;
  if (load < 1) { t.fx = 0; t.fy = 0; }
  t.utilisation = peak > 0 ? Math.hypot(t.fx, t.fy) / peak : 0;
  const sliding = Math.abs(t.fx * (omega * radius - vx)) + Math.abs(t.fy * vy);
  t.slipPower = clamp(sliding, 0, 180000);
  const rolling = load * Math.abs(vx) * 0.012;
  const cooling = (t.surface - ambient) * (23 + Math.abs(vx) * 1.1);
  t.surface = clamp(t.surface + (t.slipPower * 0.55 + rolling - cooling - (t.surface - t.core) * 75) / 6000 * dt, ambient, 210);
  t.core = clamp(t.core + ((t.surface - t.core) * 75 + rolling * 0.3 - (t.core - ambient) * 4) / 18000 * dt, ambient, 170);
  t.inner = t.surface + Math.abs(camber) * 75;
  t.outer = t.surface - Math.abs(camber) * 45;
  // Ideal gas law must use absolute pressure and absolute temperature.
  t.pressure = (t.coldPressure + 1.01325) * ((t.core + 273.15) / (ambient + 273.15)) - 1.01325;
  t.wear = clamp(t.wear + t.slipPower * dt * 1.7e-10 * (1 + Math.max(0, t.surface - 115) / 35), 0, 1);
  return t;
}
