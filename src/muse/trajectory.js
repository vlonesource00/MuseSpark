// MuseSpark space-time kinodynamic trajectory search.
// Two-stage (broad cheap screen -> top finalists high-fidelity) with warm start.
// Candidates carry geometry, curvature, width legality, speed profile, time,
// envelope, traffic occupancy (swept), risk, strategic continuation value.
// Allocation-conscious: preallocated pool, scratch buffers, no per-tick closures.
import { clamp, wrap } from '../sim/math.js';
import { pathCurvature } from '../sim/path-geometry.js';

const POOL = 20;
function makeCandidate() {
  return { entryQ: 0, apexQ: 0, exitQ: 0, brakeShift: 0, points: [], speed: null, time: 0, risk: 0, value: 0, legal: true, reason: '', flank: 'NONE', type: 'HOLD_LINE' };
}
const pool = Array.from({ length: POOL }, makeCandidate);

export class TrajectorySearch {
  constructor(track, line, envelope) {
    this.track = track;
    this.line = line;
    this.envelope = envelope;
    this.prevWinner = null;
    this.horizon = 140; // m
    this.step = 7; // m between samples
    this.stats = { screened: 0, finalists: 0, ms: 0 };
  }
  // Build candidate lateral profile: blend global line with maneuver offsets.
  // Ego-anchored: starts at current q, blends to maneuver target over ~45m
  // (smoothstep) so replans never command an instant lateral jump.
  buildGeometry(s0, spec, egoQ = 0) {
    const out = [];
    const flank = spec.flank;
    const L = this.track.length;
    const baseAt = (s) => this.line.offsetAt(s);
    const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    // Parameter grid depends on maneuver type.
    const n = Math.floor(this.horizon / this.step);
    for (let i = 0; i <= n; i++) {
      const s = s0 + i * this.step;
      let q = baseAt(s);
      const u = i / n; // 0 near -> 1 far
      if (flank === 'OUTSIDE') q += (1 - u) * spec.amp + u * -0.5;
      else if (flank === 'INSIDE') q += (1 - u * 0.6) * spec.amp;
      else if (flank === 'SWITCHBACK') q += Math.sin(u * Math.PI) * spec.amp * 0.7 - (1 - u) * 1.2;
      q = clamp(q, -(this.track.halfWidth - 1.3), this.track.halfWidth - 1.3);
      // Anchor start to ego lateral to avoid yank.
      const blend = smooth((i * this.step) / 45);
      q = egoQ * (1 - blend) + q * blend;
      const p = this.track.at(wrap(s, L), q);
      out.push({ x: p.x, z: p.z, s: wrap(s, L), offset: q, nx: p.nx, nz: p.nz, curvature: p.curvature });
    }
    return out;
  }
  timeOf(points, v0) {
    // Fast coupled forward-backward on candidate polyline.
    const n = points.length;
    const dist = new Float64Array(n);
    const curv = new Float64Array(n);
    const spd = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = points[Math.max(0, i - 1)], b = points[i], c = points[Math.min(n - 1, i + 1)];
      curv[i] = pathCurvature(a, b, c);
      const nxt = points[Math.min(n - 1, i + 1)];
      dist[i] = Math.hypot(nxt.x - b.x, nxt.z - b.z);
      let lo = 4, hi = 85;
      for (let k = 0; k < 10; k++) {
        const v = (lo + hi) / 2;
        if (v * v * Math.abs(curv[i]) <= this.envelope.lateral(v)) lo = v; else hi = v;
      }
      spd[i] = lo;
    }
    spd[0] = Math.min(spd[0], v0 + 4);
    for (let i = n - 2; i >= 0; i--) {
      const v = spd[i + 1];
      const ul = Math.min(0.99, (v * v * Math.abs(curv[i + 1])) / Math.max(1, this.envelope.lateral(v)));
      const dec = this.envelope.brake(v) * Math.sqrt(1 - ul * ul);
      spd[i] = Math.min(spd[i], Math.sqrt(v * v + 2 * dec * dist[i]));
    }
    for (let i = 1; i < n; i++) {
      const v = spd[i - 1];
      const ul = Math.min(0.99, (v * v * Math.abs(curv[i - 1])) / Math.max(1, this.envelope.lateral(v)));
      const acc = this.envelope.drive(v) * Math.sqrt(1 - ul * ul);
      spd[i] = Math.min(spd[i], Math.sqrt(v * v + 2 * acc * dist[i - 1]));
    }
    let t = 0;
    for (let i = 0; i < n - 1; i++) t += (2 * dist[i]) / Math.max(1, spd[i] + spd[i + 1]);
    return { time: t, speed: spd, curv, dist };
  }
  // Swept occupancy vs posterior-weighted rival predictions.
  trafficCost(points, egoSpeed, rivals, beliefs, t0) {
    let cost = 0, hardConflict = false, minGap = Infinity;
    for (const r of rivals) {
      const b = beliefs.map.has(r.id) ? beliefs.map.get(r.id) : null;
      const post = b ? b.posterior : { HOLD_LINE: 1 };
      for (const [h, p] of Object.entries(post)) {
        if (p < 0.06) continue;
        const pred = b ? b.predict(r.s, r.q, r.speed, 1.2, h) : { s: r.s + r.speed * 1.2, q: r.q, sigmaS: 3, sigmaQ: 1 };
        // Closest approach of candidate to predicted body (body=2m half-width 1m).
        for (let i = 0; i < points.length; i += 2) {
          const ds = Math.abs(wrap(points[i].s - pred.s + this.track.length / 2, this.track.length) - this.track.length / 2);
          const dq = Math.abs(points[i].offset - pred.q);
          const bodyGap = Math.hypot(ds / 4.6, dq / 2.0); // normalized: 1 = touching
          minGap = Math.min(minGap, bodyGap);
          if (bodyGap < 1.0) { cost += p * (1.6 - bodyGap) * 3; if (ds < 8 && dq < 2.2) hardConflict = true; }
          else if (bodyGap < 2.0) cost += p * (2.0 - bodyGap) * 0.4; // uncertainty costs less than body
        }
      }
    }
    return { cost, hardConflict, minGap };
  }
  search(s0, v0, maneuver, rivals, beliefs, opts = {}) {
    const t0 = performance.now ? performance.now() : Date.now();
    const detail = opts.detail ?? 1; // adaptive compute 0..2
    const egoQ = opts.egoQ ?? 0;
    // Clear-air detection: no maneuver and no rival within 45m. Then the
    // optimum is the global line — no eval offsets, no reason to leave it.
    let trafficNear = maneuver.flank !== 'NONE';
    if (!trafficNear && rivals) {
      for (const r of rivals) {
        const ds = Math.abs(wrap(r.s - s0 + this.track.length * 1.5, this.track.length) - this.track.length * 0.5);
        if (ds < 45) { trafficNear = true; break; }
      }
    }
    const ampSet = maneuver.flank === 'OUTSIDE' ? [3.2, 2.0, 0] : maneuver.flank === 'INSIDE' ? [-3.2, -2.0, 0] : maneuver.flank === 'SWITCHBACK' ? [2.4, -2.4, 0] : [1.6, -1.6, 0];
    const specs = [];
    // STAGE 0 warm start (scalar signature — pool memory is reused, never held)
    if (this.prevSig && trafficNear) specs.push({ flank: this.prevSig.flank, amp: this.prevSig.amp ?? 0, type: this.prevSig.type, warm: true });
    const count = !trafficNear ? 2 : detail === 0 ? 5 : detail === 1 ? 9 : 13;
    const flanks = !trafficNear ? ['NONE'] : maneuver.flank === 'NONE' ? ['NONE', 'OUTSIDE', 'INSIDE'] : [maneuver.flank, 'NONE', maneuver.flank === 'OUTSIDE' ? 'INSIDE' : 'OUTSIDE'];
    let si = 0;
    for (const f of flanks) {
      // Clear air: the line, the whole line — no offset evals to get stranded on.
      const amps = !trafficNear ? [0] : f === maneuver.flank ? ampSet : [f === 'OUTSIDE' ? 2.6 : f === 'INSIDE' ? -2.6 : 0];
      for (const a of amps) {
        if (specs.length >= count) break;
        if (specs.some((s) => s.flank === f && Math.abs(s.amp - a) < 0.3)) continue;
        specs.push({ flank: f, amp: a, type: f === 'NONE' ? 'HOLD_LINE' : maneuver.type });
        si++;
      }
    }
    // STAGE 1 cheap broad screen
    const scored = [];
    for (let k = 0; k < specs.length; k++) {
      const c = pool[k % POOL];
      const pts = this.buildGeometry(s0, specs[k], egoQ);
      const { time, speed, curv } = this.timeOf(pts, v0);
      // Width legality (car half width 0.99 + margin).
      let legal = true;
      for (const p of pts) if (Math.abs(p.offset) > this.track.halfWidth - 1.1) { legal = false; break; }
      const traf = this.trafficCost(pts, v0, rivals, beliefs, 0);
      // Exit advantage at +50/+100/+200m: terminal speed proxy.
      const exitV = speed[speed.length - 1];
      const strategic = (specs[k].flank === maneuver.flank ? -0.18 : 0) + (maneuver.passP ? -(maneuver.passP * 0.5) * (specs[k].flank === maneuver.flank ? 1 : 0) : 0);
      const value = time + traf.cost * 0.55 + (legal ? 0 : 5) - exitV * 0.004 + strategic;
      Object.assign(c, { entryQ: pts[0].offset, apexQ: pts[(pts.length / 2) | 0].offset, exitQ: pts[pts.length - 1].offset, points: pts, speed, time, risk: traf.cost, value, legal, flank: specs[k].flank, amp: specs[k].amp, type: specs[k].type, hardConflict: traf.hardConflict, warm: !!specs[k].warm });
      c.reason = !legal ? 'width illegal' : traf.hardConflict ? 'hard traffic conflict' : `t=${time.toFixed(2)}s risk=${traf.cost.toFixed(2)}`;
      scored.push(c);
    }
    scored.sort((a, b) => a.value - b.value);
    // STAGE 2/3: top finalists get curvature-stress recheck (high fidelity).
    const finalists = scored.slice(0, detail === 0 ? 2 : detail === 1 ? 4 : 5);
    for (const f of finalists) {
      let peakLat = 0;
      for (let i = 0; i < f.points.length; i++) {
        const v = f.speed[i];
        peakLat = Math.max(peakLat, (v * v * Math.abs(f.points[i].curvature || 0)) / Math.max(1, this.envelope.lateral(v)));
      }
      if (peakLat > 1.02) { f.value += 2; f.reason += ' | lat over limit'; }
    }
    finalists.sort((a, b) => a.value - b.value);
    const winner = finalists[0];
    this.prevWinner = winner;
    this.prevSig = { flank: winner.flank, amp: winner.amp ?? 0, type: winner.type };
    this.stats.screened = scored.length;
    this.stats.finalists = finalists.length;
    this.stats.ms = (performance.now ? performance.now() : Date.now()) - t0;
    return { winner, finalists, rejected: scored.slice(finalists.length), stats: { ...this.stats } };
  }
  at(s, winner, fallbackLine) {
    if (!winner) return fallbackLine.at(s);
    // Find nearest sample.
    let best = winner.points[0], bd = Infinity;
    for (const p of winner.points) {
      const d = Math.abs(wrap(p.s - s + this.track.length / 2, this.track.length) - this.track.length / 2);
      if (d < bd) { bd = d; best = p; }
    }
    if (bd > 12) return fallbackLine.at(s);
    const p = this.track.at(s, best.offset);
    p.offset = best.offset;
    return p;
  }
}
