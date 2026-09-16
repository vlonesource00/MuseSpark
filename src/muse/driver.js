// MuseSpark driver — full pipeline wiring. LIVE, WIRED, MEASURED.
// GLOBAL KNOWLEDGE -> BELIEF -> STRATEGY -> TRAJECTORY -> MPCC -> SAFETY.
import { clamp, damp, angle, wrap } from '../sim/math.js';
import { pathCurvature } from '../sim/path-geometry.js';
import { BeliefBank } from './belief.js';
import { StrategyBrain } from './strategy.js';
import { TrajectorySearch } from './trajectory.js';
import { CoupledController } from './mpcc.js';
import { SafetySupervisor } from './safety.js';
import { Scheduler } from './scheduler.js';
import { Telemetry } from './telemetry.js';
import { observationFromGame, applyCommand, thermalMargin } from './types.js';

export class MuseDriver {
  constructor(id, track, line, envelope, opts = {}) {
    this.id = id;
    this.track = track;
    this.line = line;
    this.envelope = envelope;
    this.skill = opts.skill ?? 0.97;
    this.mode = opts.mode ?? 'SPRINT';
    // Pace margin by objective horizon (same plant, different risk):
    // QUALIFYING attacks at full envelope, SPRINT keeps 2%, ENDURANCE manages.
    this.paceMargin = this.mode === 'QUALIFYING' ? 1.0 : this.mode === 'ENDURANCE' ? 0.94 : 0.98;
    this.beliefs = new BeliefBank(track.length);
    this.strategy = new StrategyBrain(track.length, { aggression: opts.aggression ?? 0.72, mode: this.mode });
    this.search = new TrajectorySearch(track, line, envelope);
    this.controller = new CoupledController(opts.spec);
    this.safety = new SafetySupervisor(track);
    this.scheduler = new Scheduler();
    this.telemetry = new Telemetry();
    this.state = 'PACE';
    this.targetSpeed = 0;
    this.debug = { maneuver: null, winner: null, finalists: [], rejected: [], beliefs: null, ms: {} };
    this.plan = null;
    this.planAge = 1;
    this.recovery = 0;
    this.reverseTimer = 0;
    this.wasRecovering = false;
    this.brakeSource = 'NONE';
    this.theoreticalLap = line.theoreticalLap;
    this.realizedLap = null;
    this.spec = opts.spec;
  }
  currentPlan() {
    const winner = this.plan?.winner ?? null;
    const line = this.line;
    const search = this.search;
    const track = this.track;
    return {
      winner,
      apexS: this.plan?.apexS ?? 0,
      at: (s) => {
        if (winner) {
          let best = winner.points[0], bd = Infinity;
          for (const p of winner.points) {
            const d = Math.abs(wrap(p.s - s + track.length / 2, track.length) - track.length / 2);
            if (d < bd) { bd = d; best = p; }
          }
          if (bd < 14) {
            const p = track.at(wrap(s, track.length), best.offset);
            p.offset = best.offset;
            // attach winner speed
            const idx = winner.points.indexOf(best);
            p.speed = winner.speed ? winner.speed[idx] : line.speedAt(s);
            p.curvature = best.curvature ?? p.curvature;
            return p;
          }
        }
        return line.at(s);
      }
    };
  }
  update(car, cars, dt, context = null) {
    const t0 = performance.now ? performance.now() : Date.now();
    this.scheduler.tick(dt);
    const time = this.scheduler.t;
    const current = this.track.nearest(car.x, car.z);
    const headingError = angle(current.heading - car.yaw);
    const edge = this.track.halfWidth;
    // Recovery (same physical rules for all drivers).
    if ((Math.abs(current.lateral) > edge + 0.7 && car.speed < 16) || Math.abs(headingError) > 1.3 || this.reverseTimer > 0 ||
      (this.wasRecovering && (Math.abs(current.lateral) > edge - 0.7 || Math.abs(headingError) > 0.6))) {
      if (!this.wasRecovering) { this.plan = null; this.controller.brakeEvent = null; }
      this.wasRecovering = true;
      this.recover(car, cars, current, dt);
      return;
    }
    this.wasRecovering = false;
    // Observation (plant-agnostic contract).
    const obs = observationFromGame({ time, dt, car, track: this.track, cars, line: this.line, mode: this.mode });
    const rivals = obs.rivals.map((r) => ({ ...r }));
    const egoObs = { id: car.id, s: obs.ego.s, q: obs.ego.q, speed: obs.ego.speed };
    // Multi-rate: beliefs 15Hz.
    if (this.scheduler.due('belief')) {
      this.scheduler.mark('belief', 1 / 15);
      this.beliefs.update(time, car.id, [egoObs, ...rivals]);
    }
    // Strategy 7Hz + event (new close rival).
    const needStrategy = this.scheduler.due('strategy') || (rivals.some((r) => Math.abs(wrap(r.s - egoObs.s + this.track.length / 2, this.track.length) - this.track.length / 2) < 12) && this.planAge > 0.4);
    let strat = { maneuver: this.debug.maneuver ?? { type: 'HOLD_LINE', flank: 'NONE' } };
    if (needStrategy) {
      const s0 = performance.now ? performance.now() : Date.now();
      this.scheduler.mark('strategy', 1 / 7);
      strat = this.strategy.update(time, 1 / 7, egoObs, rivals, this.beliefs, this.line);
      this.debug.maneuver = strat.maneuver;
      this.debug.strategyMs = (performance.now ? performance.now() : Date.now()) - s0;
    } else {
      strat = { maneuver: this.debug.maneuver ?? { type: 'HOLD_LINE', flank: 'NONE' }, target: null };
    }
    const maneuver = this.debug.maneuver ?? { type: 'HOLD_LINE', flank: 'NONE' };
    // Trajectory 15Hz adaptive.
    this.scheduler.adapt(rivals.map((r) => ({ id: r.id, s: r.s, q: r.q })), egoObs, this.track.length);
    if (this.scheduler.due('traj') || !this.plan) {
      const s0 = performance.now ? performance.now() : Date.now();
      this.scheduler.mark('traj', 1 / (this.scheduler.detail === 0 ? 10 : this.scheduler.detail === 1 ? 15 : 22));
      const res = this.search.search(obs.ego.s, obs.ego.speed, maneuver, rivals, this.beliefs, { detail: this.scheduler.detail, egoQ: obs.ego.q });
      // Apex = min-speed station ahead.
      let apexS = obs.ego.s + 60, minV = Infinity;
      for (let i = 0; i < res.winner.points.length; i++) {
        if (res.winner.speed[i] < minV) { minV = res.winner.speed[i]; apexS = res.winner.points[i].s; }
      }
      this.plan = { ...res, apexS };
      this.planAge = 0;
      this.debug.winner = res.winner; this.debug.finalists = res.finalists; this.debug.rejected = res.rejected;
      this.debug.trajMs = (performance.now ? performance.now() : Date.now()) - s0;
    } else {
      this.planAge += dt;
    }
    const plan = this.currentPlan();
    // Target speed: winner profile + global skill + wet factor + control margin.
    // 0.97 margin (was 0.94): theory 76s must be reachable; safety + combined
    // gating already protect the corner. Braking-limited (late-hard-brake):
    // target = min_ahead sqrt(v_apex^2 + 2*dec*dist), NOT min speed in window.
    const aheadS = obs.ego.s + Math.max(4, car.speed * 0.2);
    // Thermal adaptation: hot/worn rubber gets a smaller envelope slice.
    const margin = this.paceMargin * thermalMargin(obs.ego.tyreMax ?? 70, obs.ego.tyreWear ?? 0);
    let targetSpeed = this.line.speedAt(aheadS) * this.skill * margin * (1 - this.track.wetness * 0.24);
    // Trajectory braking target: pure braking-distance limit (late-hard-brake).
    // target = min_ahead sqrt(apexV^2 + 2*dec*ds). minNear window REMOVED with
    // the latch (2026-09-16): the latch pinned a stale apex 200m ahead and the
    // window+fallback guards conspired to sail past corners. Pure-function
    // braking on both sides now: target and pedal agree by construction.
    if (this.plan?.winner) {
      const w = this.plan.winner;
      const dec = 9.0;
      let limited = Infinity;
      for (let i = 0; i < w.points.length; i++) {
        const ds = wrap(w.points[i].s - obs.ego.s + this.track.length * 1.5, this.track.length) - this.track.length * 0.5;
        if (ds < -5 || ds > 170) continue;
        const apexV = w.speed[i] * this.skill * margin;
        const allow = Math.sqrt(apexV * apexV + 2 * dec * Math.max(0, ds));
        if (allow < limited) limited = allow;
      }
      if (limited < Infinity) targetSpeed = Math.min(targetSpeed, limited);
    }
    // Pursuit steering.
    const lookahead = clamp(6 + car.speed * 0.45, 8, 34);
    const target = plan.at(obs.ego.s + lookahead);
    const dx = target.x - car.x, dz = target.z - car.z;
    const lx = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw);
    const dist2 = dx * dx + dz * dz;
    const slip = Math.atan2(car.v, Math.max(4, car.u));
    const pathHere = plan.at(obs.ego.s);
    const trackingError = obs.ego.q - (pathHere.offset ?? 0);
    const trackingCorrection = clamp(-Math.atan2(trackingError * 0.5, Math.max(14, car.speed)), -0.04, 0.04);
    const middle = plan.at(obs.ego.s + 3), after = plan.at(obs.ego.s + 6);
    const localCurvature = pathCurvature(pathHere, middle, after);
    const rotation = clamp((localCurvature * car.speed - car.yawRate) * this.spec.wheelbase / Math.max(8, car.speed) * 0.7, -0.03, 0.03);
    const pursuit = Math.atan2(2 * this.spec.wheelbase * lx, Math.max(5, dist2)) + slip * 0.4 + trackingCorrection + rotation;
    // Safety (120Hz independent).
    const safety = this.safety.update(car, cars, { s: obs.ego.s, lateral: obs.ego.q }, dt, time);
    targetSpeed = Math.min(targetSpeed, safety.maxSpeed);
    if (Math.abs(obs.ego.q) > edge + 0.8) targetSpeed = Math.min(targetSpeed, 11);
    if (Math.abs(slip) > 0.2) targetSpeed = Math.min(targetSpeed, car.speed * (1 - clamp((Math.abs(slip) - 0.2) * 1.1, 0, 0.45)));
    this.targetSpeed = targetSpeed;
    this.state = safety.emergency ? 'COLLISION AVOIDANCE' : (maneuver.type ?? 'PACE');
    // Coupled control (MPCC 40Hz cached correction, pedals every tick).
    const traffic = { hardConflict: !!(this.plan?.winner?.hardConflict) };
    const cmd = this.controller.update(car, plan, { s: obs.ego.s, lateral: obs.ego.q }, pursuit, targetSpeed, this.envelope, safety, traffic, this.track.length);
    if (safety.emergency) { cmd.throttle = 0; cmd.brake = 1; cmd.source = 'CONTACT_AVOIDANCE'; }
    this.brakeSource = cmd.source;
    applyCommand(car, { steering: cmd.steer, throttle: cmd.throttle, brake: cmd.brake });
    // Telemetry @ decimated 60Hz to bound memory.
    if ((this.teleCount = (this.teleCount || 0) + 1) % 2 === 0) {
      this.telemetry.record({
        t: time, s: obs.ego.s, q: obs.ego.q, x: car.x, z: car.z, speed: car.speed,
        yaw: car.yaw, yawRate: car.yawRate, slip, steer: cmd.steer, throttle: cmd.throttle,
        brake: cmd.brake, brakeSource: cmd.source, targetSpeed, curvature: localCurvature,
        latG: car.ay / 9.81, longG: car.ax / 9.81, maneuver: maneuver.type, flank: maneuver.flank,
        risk: this.plan?.winner?.risk ?? 0, trajMs: this.debug.trajMs ?? 0, strategyMs: this.debug.strategyMs ?? 0
      });
    }
    const totalMs = (performance.now ? performance.now() : Date.now()) - t0;
    this.scheduler.record(totalMs);
    this.debug.ms = { total: totalMs, p95: this.scheduler.p95(), detail: this.scheduler.detail, screened: this.search.stats.screened, finalists: this.search.stats.finalists };
    this.debug.beliefs = this.beliefs.map.size;
    this.debug.explanation = this.strategy.explanation;
    this.debug.safety = safety;
  }
  recover(car, cars, current, dt) {
    const edge = this.track.halfWidth;
    const headingError = angle(current.heading - car.yaw);
    const outside = Math.abs(current.lateral) > edge + 0.3;
    const target = this.track.at(current.s + (outside ? 6 : 12), clamp(current.lateral * 0.35, -3, 3));
    const dx = target.x - car.x, dz = target.z - car.z;
    const lx = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw), lz = dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
    this.reverseTimer = Math.max(0, this.reverseTimer - dt);
    this.recovery = car.speed < 0.7 ? this.recovery + dt : 0;
    if ((lz < 0 || this.recovery > 1.7) && car.speed < 2 && this.reverseTimer === 0) { this.reverseTimer = 2.0; this.recovery = 0; }
    if (this.reverseTimer > 0 && Math.abs(headingError) < 0.65) this.reverseTimer = 0;
    const reverse = this.reverseTimer > 0;
    const steer = reverse ? -clamp(headingError / 1.2, -0.85, 0.85) : clamp(Math.atan2(2 * this.spec.wheelbase * lx, Math.max(12, dx * dx + dz * dz)) / this.spec.steeringLock, -0.85, 0.85);
    car.controls = { steer, throttle: car.speed < (reverse ? 2.8 : outside ? 4.5 : 8) ? (outside ? 0.25 : 0.34) : 0, brake: car.speed > (reverse ? 3.8 : outside ? 5.5 : 9) ? 0.65 : 0, reverse };
    this.state = reverse ? 'REVERSE RECOVERY' : 'SAFE REJOIN';
    this.targetSpeed = reverse ? 2.8 : 4.5;
    this.brakeSource = 'RECOVERY';
  }
}
