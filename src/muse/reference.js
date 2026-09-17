// SpatialReferenceGovernor — ONE physical future shared by both controllers.
// The sampling path and the predictive path previously computed speed authority
// twice, differently (driver allow-loop + MPC vBase shaping + scalar target cap),
// disagreeing by up to 13 m/s at entries. There is now one spatial reference:
//   qRef(s) / kappaRef(s)      geometry of the committed plan (winner | line)
//   vLine(s, prm)              global line speed with skill/margin/wet
//   vAllow(s, prm)             braking-limited profile over the winner line
//   target(s, v, prm)          min(line-lookahead, allow) — the scalar command
//   requiredDecel(s, v, prm)   longitudinal demand to stay on the profile
//   brakeCause(s, v, prm)      causal braking intent (phantom discipline)
//   pickupOpen(s, prm)         whether the profile wants power at s (exits)
// prm = { winner, skill, margin, wet, dec }. Pure functions, no state, no I/O.
// Controllers arbitrate (safety/slip/traffic caps stay controller-side); the
// governor only answers what the SPATIAL future allows.
import { clamp, wrap } from '../sim/math.js';

export function createGovernor({ track, line, envelope }) {
  const L = track.length;
  const dsOf = (a, b) => wrap(a - b + L * 1.5, L) - L * 0.5;

  function qRef(s, prm = {}) {
    // Committed plan geometry: winner where fresh, global line otherwise.
    const w = prm.winner;
    if (w?.points?.length) {
      let bd = Infinity, bq = null;
      for (let k = 0; k < w.points.length; k++) {
        const d = Math.abs(dsOf(w.points[k].s, s));
        if (d < bd) { bd = d; bq = w.points[k].offset; }
      }
      if (bd < 14 && bq !== null) return bq;
    }
    return line.offsetAt(s);
  }

  function kappaRef(s, prm = {}) {
    // Path curvature of the committed geometry (same stencil the car drives).
    const a = track.at(s - 4, qRef(s - 4, prm));
    const b = track.at(s, qRef(s, prm));
    const c = track.at(s + 4, qRef(s + 4, prm));
    const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z;
    let d = Math.atan2(bcx, bcz) - Math.atan2(abx, abz);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d / Math.max(1, (Math.hypot(abx, abz) + Math.hypot(bcx, bcz)) / 2);
  }

  function vLine(s, prm) {
    const ahead = s + Math.max(4, (prm.v ?? 30) * 0.2);
    return line.speedAt(ahead) * prm.skill * prm.margin * (1 - (prm.wet ?? 0) * 0.24);
  }

  function vAllow(s, prm) {
    // min over ALL future stations j of sqrt(v_j^2 + 2*dec*d_j): the speed
    // from which the profile's own braking still makes every downstream
    // station — not just the single slowest apex. Apex-only formulation
    // underconstrains entry kinks (hairpin entry: allow said 50 where the
    // line knew 29, car arrived +20 hot and slid). Default 9.0: dec 10 tried
    // 2026-09-17 with zero measured effect anywhere (the line binds, not
    // allow). MPC experiments override via prm.
    const w = prm.winner;
    if (!w?.speed) return Infinity;
    const dec = prm.dec ?? 9.0;
    const sm = prm.skill * prm.margin;
    let lim = Infinity;
    for (let i = 0; i < w.points.length; i++) {
      const ds = dsOf(w.points[i].s, s);
      if (ds < -5 || ds > 170) continue;
      const vj = w.speed[i] * sm;
      const allow = Math.sqrt(vj * vj + 2 * dec * Math.max(0, ds));
      if (allow < lim) lim = allow;
    }
    return lim;
  }

  function target(s, v, prm) {
    return Math.min(vLine(s, prm), vAllow(s, { ...prm, v }));
  }

  function requiredDecel(s, v, prm) {
    // Find the binding apex (min allow) and the decel to arrive at it.
    const w = prm.winner;
    const dec = prm.dec ?? 9.0;
    const sm = prm.skill * prm.margin;
    let best = null;
    if (w?.speed) {
      for (let i = 0; i < w.points.length; i++) {
        const ds = dsOf(w.points[i].s, s);
        if (ds < -5 || ds > 170) continue;
        const apexV = w.speed[i] * sm;
        const allow = Math.sqrt(apexV * apexV + 2 * dec * Math.max(0, ds));
        if (!best || allow < best.allow) best = { allow, apexV, ds, sApex: w.points[i].s };
      }
    }
    if (!best) return { req: 0, vMin: v, sMin: s, dist: Infinity };
    const dist = Math.max(10, best.ds);
    const req = Math.max(0, (v * v - best.apexV * best.apexV) / (2 * dist));
    return { req, vMin: best.apexV, sMin: best.sApex, dist };
  }

  function brakeCause(s, v, prm) {
    const w = prm.winner;
    if (!w?.speed) return null;
    let apexV = Infinity, apexS = s + 60;
    for (let i = 0; i < w.points.length; i++) {
      const ds = dsOf(w.points[i].s, s);
      if (ds < -5 || ds > 170) continue;
      if (w.speed[i] < apexV) { apexV = w.speed[i]; apexS = w.points[i].s; }
    }
    if (apexV < v - 1.2) {
      return { source: prm.hardConflict ? 'TRAFFIC_CONFLICT' : 'PLANNED_BRAKING', apexV, apexS };
    }
    return null;
  }

  function pickupOpen(s, prm) {
    // Profile rising through s faster than the car can be behind it:
    // allow(s+15) > allow(s) + 1 means the plan wants power (post-apex).
    const a0 = vAllow(s, prm), a1 = vAllow(s + 15, prm);
    return Number.isFinite(a0) && Number.isFinite(a1) && a1 > a0 + 1.0;
  }

  function kappaLine(s) {
    // Smooth global-line curvature (seam-free): the yaw-damping reference.
    // Winner/line switching makes plan-sampled curvature spike pi-flips at
    // coverage seams (measured: yaw cost 3612 from garbage rRef); damping
    // needs sanity, not maneuver exactness.
    return line.curvatureAt ? line.curvatureAt(s) : track.at(s).curvature;
  }

  function pose(s, prm = {}) {
    // Committed-plan pose (position + frame) for tracking references.
    const q = qRef(s, prm);
    const p = track.at(s, q);
    p.offset = q;
    return p;
  }

  function linePose(s) {
    // Pure global-line pose (no winner blending): the honest clear-air
    // reference for controllers that must see true off-line error.
    const q = line.offsetAt(s);
    const p = track.at(s, q);
    p.offset = q;
    p.speed = line.speedAt(s);
    return p;
  }

  return { qRef, kappaRef, kappaLine, pose, linePose, vLine, vAllow, target, requiredDecel, brakeCause, pickupOpen };
}
