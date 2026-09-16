// MuseSpark driver belief state — probabilistic opponent intent, not kinematics.
// Per rival: line stability, lateral velocity, braking habit, inside/outside
// defense tendency, late-move tendency, response to attacks, exit weakness.
// Body envelope and prediction uncertainty are stored INDEPENDENTLY.
import { clamp, wrap } from '../sim/math.js';

const HYPOTHESES = ['HOLD_LINE', 'DEFEND_INSIDE', 'DEFEND_OUTSIDE', 'MOVE_OUTSIDE', 'BRAKE_EARLY', 'LATE_DEFEND'];

export class OpponentBelief {
  constructor(id, trackLength) {
    this.id = id;
    this.trackLength = trackLength;
    this.history = []; // {t, s, q, speed, lateralVel}
    this.maxHistory = 120;
    this.prior = { HOLD_LINE: 0.45, DEFEND_INSIDE: 0.18, DEFEND_OUTSIDE: 0.12, MOVE_OUTSIDE: 0.08, BRAKE_EARLY: 0.09, LATE_DEFEND: 0.08 };
    this.posterior = { ...this.prior };
    this.stats = {
      lineStability: 1, lateralVel: 0, brakingHabit: 0, insideDefense: 0,
      outsideDefense: 0, lateMove: 0, attackResponse: 0, exitWeakness: 0, samples: 0
    };
    this.lastS = 0; this.lastQ = 0; this.lastT = 0;
    this.sigmaS = 2; this.sigmaQ = 0.5;
  }
  observe(t, s, q, speed, egoS = 0) {
    const dt = Math.max(1e-3, t - this.lastT);
    const latVel = this.lastT ? (q - this.lastQ) / dt : 0;
    const ds = wrap(s - this.lastS + this.trackLength / 2, this.trackLength) - this.trackLength / 2;
    this.history.push({ t, s, q, speed, lateralVel: clamp(latVel, -8, 8), ds });
    if (this.history.length > this.maxHistory) this.history.shift();
    const st = this.stats;
    st.samples++;
    const a = 1 / Math.min(st.samples, 60);
    st.lateralVel += (clamp(latVel, -6, 6) - st.lateralVel) * a;
    // Line stability: variance of q over recent window.
    const win = this.history.slice(-20);
    if (win.length > 5) {
      const mean = win.reduce((x, h) => x + h.q, 0) / win.length;
      const variance = win.reduce((x, h) => x + (h.q - mean) ** 2, 0) / win.length;
      st.lineStability += ((1 / (1 + variance)) - st.lineStability) * a;
    }
    // Inside/outside defense: rival moves toward ego's attack side when ego close behind.
    const gap = wrap(s - egoS + this.trackLength * 1.5, this.trackLength) - this.trackLength * 0.5;
    if (gap > 0 && gap < 60) {
      if (q < -1.5) st.insideDefense += (1 - st.insideDefense) * a * 0.5;
      if (q > 1.5) st.outsideDefense += (1 - st.outsideDefense) * a * 0.5;
      if (Math.abs(latVel) > 2.5) st.lateMove += (1 - st.lateMove) * a * 0.6;
    } else {
      st.insideDefense *= (1 - a * 0.05);
      st.outsideDefense *= (1 - a * 0.05);
    }
    this.lastS = s; this.lastQ = q; this.lastT = t;
    this.updatePosterior();
    // Uncertainty grows with prediction horizon; set base from stability.
    this.sigmaQ = clamp(0.35 + (1 - st.lineStability) * 1.6 + Math.abs(st.lateralVel) * 0.15, 0.3, 2.5);
    this.sigmaS = clamp(1.5 + (1 - st.lineStability) * 4, 1.2, 8);
  }
  updatePosterior() {
    const st = this.stats;
    // Likelihood-flavored scoring, normalized. Evidence-driven, never certain.
    const scores = {
      HOLD_LINE: 0.45 * (0.5 + st.lineStability),
      DEFEND_INSIDE: 0.18 + st.insideDefense * 0.9,
      DEFEND_OUTSIDE: 0.12 + st.outsideDefense * 0.9,
      MOVE_OUTSIDE: 0.08 + Math.max(0, st.lateralVel) * 0.08,
      BRAKE_EARLY: 0.09 + st.brakingHabit * 0.5,
      LATE_DEFEND: 0.08 + st.lateMove * 0.9
    };
    const sum = Object.values(scores).reduce((x, y) => x + y, 0);
    for (const h of HYPOTHESES) {
      // Slow Bayesian drift: posterior = 0.85*prior + 0.15*likelihood.
      const like = scores[h] / sum;
      this.posterior[h] = clamp(this.posterior[h] * 0.92 + like * 0.08, 0.02, 0.8);
    }
    const renorm = Object.values(this.posterior).reduce((x, y) => x + y, 0);
    for (const h of HYPOTHESES) this.posterior[h] /= renorm;
  }
  // Predict rival station/lateral at horizon t+dt under hypothesis h.
  predict(s, q, speed, dt, hypothesis = 'HOLD_LINE') {
    let ps = s + speed * dt;
    let pq = q;
    if (hypothesis === 'DEFEND_INSIDE') pq = Math.min(q, -2.2) - 0.4 * Math.min(1, dt);
    else if (hypothesis === 'DEFEND_OUTSIDE') pq = Math.max(q, 2.2) + 0.4 * Math.min(1, dt);
    else if (hypothesis === 'MOVE_OUTSIDE') pq = q + 1.2 * Math.min(1, dt);
    else if (hypothesis === 'BRAKE_EARLY') ps = s + Math.max(0, speed - 4 * dt) * dt;
    // Uncertainty envelope (NOT body width).
    return { s: ps, q: pq, sigmaS: this.sigmaS * (1 + dt * 0.6), sigmaQ: this.sigmaQ * (1 + dt * 0.5) };
  }
  expectedPrediction(s, q, speed, dt) {
    // Posterior-weighted mean + total variance.
    let ms = 0, mq = 0;
    for (const h of HYPOTHESES) {
      const p = this.predict(s, q, speed, dt, h);
      ms += p.s * this.posterior[h]; mq += p.q * this.posterior[h];
    }
    return { s: ms, q: mq, sigmaS: this.sigmaS * (1 + dt * 0.6), sigmaQ: this.sigmaQ * (1 + dt * 0.5), posterior: { ...this.posterior } };
  }
}

export class BeliefBank {
  constructor(trackLength) {
    this.trackLength = trackLength;
    this.map = new Map();
  }
  get(id) {
    if (!this.map.has(id)) this.map.set(id, new OpponentBelief(id, this.trackLength));
    return this.map.get(id);
  }
  update(t, egoId, rivals) {
    // rivals: [{id, s, q, speed}]
    for (const r of rivals) {
      if (r.id === egoId) continue;
      const ego = rivals.find((x) => x.id === egoId);
      this.get(r.id).observe(t, r.s, r.q, r.speed, ego ? ego.s : 0);
    }
  }
}
