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
    // min over apexes of sqrt(apexV^2 + 2*dec*d): the speed from which the
    // profile's own braking still makes every downstream apex. dec=9 default.
    const w = prm.winner;
    if (!w?.speed) return Infinity;
    const dec = prm.dec ?? 9.0;
    const sm = prm.skill * prm.margin;
    let lim = Infinity;
    for (let i = 0; i < w.points.length; i++) {
      const ds = dsOf(w.points[i].s, s);
      if (ds < -5 || ds > 170) continue;
      const apexV = w.speed[i] * sm;
      const allow = Math.sqrt(apexV * apexV + 2 * dec * Math.max(0, ds));
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

  return { qRef, kappaRef, vLine, vAllow, target, requiredDecel, brakeCause, pickupOpen };
}
