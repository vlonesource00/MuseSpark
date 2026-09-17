// MuseSpark coupled MPCC/MPC — steer + throttle + brake from one optimization.
// Curvature feedforward + contouring cost + vehicle-dynamics feedback + slip
// control + spatial brake plan. Anti-phantom: brake needs explicit causal source.
import { clamp, damp, angle } from '../sim/math.js';

export const BRAKE_SOURCES = ['NONE', 'PLANNED_BRAKING', 'TRAFFIC_CONFLICT', 'CONTACT_AVOIDANCE', 'TRACK_LIMIT_AVOIDANCE', 'RECOVERY'];

// Spatial brake event carried through replans (track-space intent, not a stab).
export function planBrakeEvent(sNow, vNow, targetSpeed, apexS, trackLength) {
  if (targetSpeed >= vNow - 0.5) return null;
  // 9.0, not peak 13: realizable while turning in with margin. The event is
  // a distance intent; peak pressure still available via urgency override.
  const decel = 9.0; // m/s^2 representative GT capability
  const dist = Math.max(8, ((vNow * vNow - targetSpeed * targetSpeed) / (2 * decel)));
  const releaseS = apexS - 6;
  const startS = releaseS - dist;
  return {
    startS, targetDeceleration: decel, peakPressure: clamp((vNow - targetSpeed) / 18, 0.35, 1),
    trailStartS: releaseS - dist * 0.35, releaseS, targetMinimumSpeed: targetSpeed, apexS,
    throttlePickupS: apexS + 4, source: 'PLANNED_BRAKING'
  };
}

export function brakeNeeded(event, s, v, targetSpeed, trackLength = 2705) {
  if (!event) return { need: false, pressure: 0 };
  const wrapD = (a, b) => ((a - b) % trackLength + trackLength * 1.5) % trackLength - trackLength * 0.5;
  // Distances relative to zone start (negative = before zone).
  const dStart = wrapD(s, event.startS);
  const zoneLen = ((event.releaseS - event.startS) % trackLength + trackLength) % trackLength || 1;
  const dTrail = wrapD(s, event.trailStartS);
  if (dStart < -6) return { need: false, pressure: 0 };
  if (dStart > zoneLen) return { need: false, pressure: 0 };
  const trailLen = ((event.releaseS - event.trailStartS) % trackLength + trackLength) % trackLength || 1;
  const trail = dTrail > 0 ? 0.45 + 0.55 * (1 - Math.min(1, dTrail / trailLen)) : 1;
  const speedErr = v - event.targetMinimumSpeed;
  if (speedErr < -1) return { need: false, pressure: 0 };
  return { need: true, pressure: clamp(event.peakPressure * trail * clamp(speedErr / 6 + 0.45, 0.25, 1), 0, 1) };
}

// Throttle-first pedals: coast before braking; brake only with causal source.
// Combined-slip gated: full throttle only when remaining longitudinal
// capability covers the engine request (physical Newtons, not reserve fraction).
export function musePedals(speedErr, envelope, v, ayDemand, brakeGate, axMeas = 0, muScale = 1) {
  // brakeGate: {allowed: bool, source, pressure}
  if (speedErr > 0.4) {
    const gate = envelope.throttleLegal(v, ayDemand, 0, axMeas, muScale);
    if (gate.legal) return { throttle: 1, brake: 0, source: 'NONE', coasting: false };
    // Combined limit: partial throttle proportional to remaining capability.
    const frac = Math.min(1, Math.max(0.12, gate.remaining / Math.max(1, gate.request)));
    if (gate.ul > 0.92) return { throttle: frac * 0.5, brake: 0, source: 'NONE', coasting: false };
    return { throttle: 0.35 + 0.65 * frac, brake: 0, source: 'NONE', coasting: false };
  }
  if (speedErr > -0.6) {
    // Small decel: lift/coast, no brake.
    const coast = clamp(0.55 - speedErr * 0.2, 0.15, 0.65);
    return { throttle: coast, brake: 0, source: 'NONE', coasting: true };
  }
  // Real decel demanded: brake only if causal source allows.
  if (brakeGate && brakeGate.allowed) {
    return { throttle: 0, brake: clamp(brakeGate.pressure ?? clamp(-speedErr * 0.22, 0.25, 1), 0, 1), source: brakeGate.source, coasting: false };
  }
  // No cause -> coast, never stab.
  return { throttle: 0, brake: 0, source: 'NONE', coasting: true };
}

export class CoupledController {
  constructor(spec) {
    this.spec = spec;
    this.steer = 0;
    this.longBias = 0;
    this.brakeEvent = null;
    this.lastSource = 'NONE';
    this.corrections = [-0.012, -0.006, 0, 0.006, 0.012];
    this.accelBias = [0, -1.4, 0.8];
    this.horizon = 12;
    this.h = 0.055;
    this.ms = 0;
  }
  update(car, plan, current, pursuit, targetSpeed, envelope, safety, traffic, trackLength = 2705, muScale = 1) {
    const t0 = performance.now ? performance.now() : Date.now();
    const SPEC = this.spec;
    // Spatial braking is a PURE FUNCTION of (s, v, plan) — no latched state.
    // allow(s) = min_ahead sqrt(apexV^2 + 2*dec*ds). Overspeed vs the driver
    // target brakes with PLANNED_BRAKING cause. Nothing to carry, nothing to
    // go stale (the latch pinned apex 200m ahead and sailed past corners).
    const DEC = 8.5;
    const wrapD = (a, b) => ((a - b) % trackLength + trackLength * 1.5) % trackLength - trackLength * 0.5;
    let apexV = Infinity, apexS = current.s + 60;
    const w = plan.winner;
    if (w && w.speed) {
      for (let i = 0; i < w.points.length; i++) {
        const ds = wrapD(w.points[i].s, current.s);
        if (ds < -5 || ds > 170) continue;
        const av = w.speed[i];
        if (av < apexV) { apexV = av; apexS = w.points[i].s; }
      }
    }
    if (apexV === Infinity) { apexV = targetSpeed; }
    // Explanation carrier only (telemetry/engineer), recomputed every tick.
    const peakDec = 13;
    const zoneDist = Math.max(8, ((car.speed * car.speed - apexV * apexV) / (2 * peakDec)));
    const releaseS = apexS - 6;
    this.brakeEvent = (apexV < car.speed - 1.2)
      ? {
          startS: releaseS - zoneDist, targetDeceleration: peakDec,
          peakPressure: clamp((car.speed - apexV) / 18, 0.35, 1),
          trailStartS: releaseS - zoneDist * 0.35, releaseS,
          targetMinimumSpeed: apexV, apexS, throttlePickupS: apexS + 4,
          source: traffic && traffic.hardConflict ? 'TRAFFIC_CONFLICT' : 'PLANNED_BRAKING'
        }
      : null;
    // MPCC-style rollout over steer corrections x longitudinal bias (15).
    let best = Infinity, bestCorr = 0, bestBias = 0;
    const v0 = Math.max(3, car.speed);
    for (const corr of this.corrections) {
      for (const bias of this.accelBias) {
        let cost = 0, dist = 0;
        let px = car.x, pz = car.z, yaw = car.yaw, u = Math.max(3, car.u), vv = car.v;
        for (let i = 0; i < this.horizon; i++) {
          const look = plan.at(current.s + dist);
          const e = { lateral: envelope.lateral(u) };
          void e;
          // Predict speed with bias.
          const spErr = targetSpeed - u;
          const acc = bias + clamp(spErr * 0.5, -12, 6);
          u = Math.max(2, u + acc * this.h);
          dist += u * this.h;
          const tgt = plan.at(current.s + dist);
          const latErr = (px - tgt.x) * tgt.nx + (pz - tgt.z) * tgt.nz;
          const yawErr = angle(Math.atan2(tgt.x - px, tgt.z - pz) - yaw);
          cost += latErr * latErr * (0.5 + i * 0.12) + yawErr * yawErr * 2.2 + corr * corr * 150 + bias * bias * 0.012;
          // Contouring progress reward.
          cost -= this.h * u * 0.002;
          // Update pose kinematically with correction.
          const steerAng = clamp(pursuit + corr, -SPEC.steeringLock, SPEC.steeringLock);
          yaw += (u * Math.tan(steerAng)) / SPEC.wheelbase * this.h;
          px += Math.sin(yaw) * u * this.h; pz += Math.cos(yaw) * u * this.h;
          void vv;
        }
        // Anti-twitch: prefer previous solution within margin.
        if (Math.abs(corr - this.lastCorr) < 1e-9 && cost < best + 0.4) { best = cost; bestCorr = corr; bestBias = bias; }
        else if (cost < best) { best = cost; bestCorr = corr; bestBias = bias; }
      }
    }
    this.lastCorr = bestCorr;
    this.longBias = bestBias;
    const steerCmd = clamp((pursuit + bestCorr) / SPEC.steeringLock, -1, 1);
    this.steer = damp(this.steer, steerCmd, 11, 1 / 60);
    // Longitudinal decision with causal brake gate.
    // targetSpeed already IS the braking-distance profile (driver). Overspeed
    // vs target brakes hard (late-hard-brake); at/below target the car drives.
    // Cause is always explicit — no phantom braking possible on a clear road
    // because target >= cruise speed there.
    const err = targetSpeed - car.speed;
    const ayDemand = car.speed * car.yawRate;
    const overspeed = car.speed - targetSpeed;
    let gate = { allowed: false, source: 'NONE', pressure: 0 };
    if (safety && safety.emergency) gate = { allowed: true, source: 'CONTACT_AVOIDANCE', pressure: 1 };
    else if (traffic && traffic.hardConflict && err < -1) gate = { allowed: true, source: 'TRAFFIC_CONFLICT', pressure: clamp(-err * 0.25, 0.3, 1) };
    else if (overspeed > 0.5 && this.brakeEvent) gate = { allowed: true, source: this.brakeEvent.source, pressure: clamp(0.4 + overspeed / 12, 0.4, 1) };
    else if (Math.abs(current.lateral) > 7.5) gate = { allowed: true, source: 'TRACK_LIMIT_AVOIDANCE', pressure: 0.5 };
    // (Brake follow-through hysteresis tried 2026-09-17: braking below target
    // extends trail-braking into the turn and spins the rear. Reverted; the
    // continuous-force MPC removes bands structurally instead.)
    const pedals = musePedals(err, envelope, car.speed, ayDemand, gate, car.ax, muScale ?? 1);
    this.lastSource = pedals.source;
    this.ms = (performance.now ? performance.now() : Date.now()) - t0;
    return { steer: this.steer, throttle: pedals.throttle, brake: pedals.brake, source: pedals.source, coasting: pedals.coasting, mpcCorr: bestCorr, longBias: bestBias };
  }
}
