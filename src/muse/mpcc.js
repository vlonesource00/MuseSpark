// MuseSpark coupled MPCC/MPC — steer + throttle + brake from one optimization.
// Curvature feedforward + contouring cost + vehicle-dynamics feedback + slip
// control + spatial brake plan. Anti-phantom: brake needs explicit causal source.
import { clamp, damp, angle } from '../sim/math.js';

export const BRAKE_SOURCES = ['NONE', 'PLANNED_BRAKING', 'TRAFFIC_CONFLICT', 'CONTACT_AVOIDANCE', 'TRACK_LIMIT_AVOIDANCE', 'RECOVERY'];

// Spatial brake event carried through replans (track-space intent, not a stab).
export function planBrakeEvent(sNow, vNow, targetSpeed, apexS, trackLength) {
  if (targetSpeed >= vNow - 0.5) return null;
  const decel = 13; // m/s^2 representative GT capability
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
export function musePedals(speedErr, envelope, v, ayDemand, brakeGate) {
  // brakeGate: {allowed: bool, source, pressure}
  if (speedErr > 0.4) {
    const gate = envelope.throttleLegal(v, ayDemand);
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
  update(car, plan, current, pursuit, targetSpeed, envelope, safety, traffic, trackLength = 2705) {
    const t0 = performance.now ? performance.now() : Date.now();
    const SPEC = this.spec;
    // Spatial brake events are track-space intents: latch the EARLIEST startS
    // and never chase it forward as speed falls. Recreate only for a genuinely
    // new corner (apex moved far AND target much lower) or when no event.
    const cornerAhead = targetSpeed < car.speed - 1.2;
    const planApex = plan.apexS ?? current.s + 60;
    if (cornerAhead) {
      const needNew = !this.brakeEvent ||
        (Math.abs(planApex - this.brakeEvent.apexS) > 60 && targetSpeed < this.brakeEvent.targetMinimumSpeed - 3);
      if (needNew) {
        // Compute from a conservative entry speed so the zone starts early enough.
        const entryV = Math.max(car.speed, targetSpeed + 6);
        this.brakeEvent = planBrakeEvent(current.s, entryV, targetSpeed, planApex, 5400);
        if (this.brakeEvent && traffic && traffic.hardConflict) this.brakeEvent.source = 'TRAFFIC_CONFLICT';
      } else {
        // Refresh target/apex without moving start later (take earliest).
        this.brakeEvent.targetMinimumSpeed = Math.min(this.brakeEvent.targetMinimumSpeed, targetSpeed);
        this.brakeEvent.apexS = planApex;
      }
    }
    if (!cornerAhead && this.brakeEvent && car.speed < this.brakeEvent.targetMinimumSpeed + 1.5) {
      this.brakeEvent = null;
    }
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
    // Hard rule: large overspeed with an active spatial event => full braking
    // regardless of trail shaping (late-hard-brake, not gentle drag).
    const err = targetSpeed - car.speed;
    const ayDemand = car.speed * car.yawRate;
    let gate = { allowed: false, source: 'NONE', pressure: 0 };
    const spatial = brakeNeeded(this.brakeEvent, current.s, car.speed, targetSpeed, trackLength);
    if (safety && safety.emergency) gate = { allowed: true, source: 'CONTACT_AVOIDANCE', pressure: 1 };
    else if (traffic && traffic.hardConflict && err < -1) gate = { allowed: true, source: 'TRAFFIC_CONFLICT', pressure: clamp(-err * 0.25, 0.3, 1) };
    else if (spatial.need) {
      const urgency = clamp(-err * 0.18, 0, 1);
      gate = { allowed: true, source: this.brakeEvent.source, pressure: clamp(Math.max(spatial.pressure, urgency), 0.25, 1) };
    } else if (this.brakeEvent && err < -6) {
      // Approaching a latched zone fast: brake only when the zone is near
      // (within ~45m). Far-away corners must NOT trigger early braking —
      // the braking-limited target already handles the approach.
      const dStart = ((((current.s - this.brakeEvent.startS) % trackLength) + trackLength * 1.5) % trackLength) - trackLength * 0.5;
      if (dStart > -45) gate = { allowed: true, source: this.brakeEvent.source, pressure: clamp(-err * 0.2, 0.4, 1) };
    } else if (Math.abs(current.lateral) > 7.5) gate = { allowed: true, source: 'TRACK_LIMIT_AVOIDANCE', pressure: 0.5 };
    const pedals = musePedals(err, envelope, car.speed, ayDemand, gate);
    this.lastSource = pedals.source;
    this.ms = (performance.now ? performance.now() : Date.now()) - t0;
    return { steer: this.steer, throttle: pedals.throttle, brake: pedals.brake, source: pedals.source, coasting: pedals.coasting, mpcCorr: bestCorr, longBias: bestBias };
  }
}
