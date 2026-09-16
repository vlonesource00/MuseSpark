// MuseSpark global time-optimal solution — whole-lap path/speed optimization.
// Minimizes T = ∫ ds_path / v(s) subject to track bounds, curvature, steering
// feasibility, lateral/longitudinal/combined tyre, aero, engine, braking.
// Multi-resolution: coarse global -> regional refinement -> complex polish.
// Linked complexes (T1/chicane) fall out of the full-lap objective + wide basis,
// never from independent corner optimization.
import { clamp, lerp, wrap } from '../sim/math.js';
import { pathCurvature } from '../sim/path-geometry.js';

export function sampleStations(track, step = 3) {
  const stations = [];
  for (let s = 0; s < track.length; s += step) {
    const p = track.at(s);
    stations.push({ s, x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz, curvature: p.curvature, index: p.index });
  }
  return stations;
}

function offsetPoint(track, s, q) {
  const p = track.at(s, q);
  return { x: p.x, z: p.z, s, offset: q, nx: p.nx, nz: p.nz, tx: p.tx, tz: p.tz };
}

// Closed-lap time objective with coupled envelope. Points carry world x/z.
export function lapTimeProfile(points, envelope, opts = {}) {
  const ceiling = opts.ceiling ?? 85;
  const skill = opts.skill ?? 1.0;
  const passes = opts.passes ?? 6;
  const wheelbase = opts.wheelbase ?? 2.78;
  const steeringRate = opts.steeringRate ?? 1.35;
  const n = points.length;
  const speed = new Float64Array(n);
  const distance = new Float64Array(n);
  const curvature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 3) % n], b = points[i], c = points[(i + 3) % n];
    const next = points[(i + 1) % n];
    curvature[i] = pathCurvature(a, b, c);
    distance[i] = Math.hypot(next.x - b.x, next.z - b.z);
    // Corner-limited speed: v^2*|k| = lat(v)*skill^2 (bisection, coupled).
    let lo = 1, hi = ceiling;
    for (let j = 0; j < 14; j++) {
      const v = (lo + hi) / 2;
      if (v * v * Math.abs(curvature[i]) <= envelope.lateral(v) * skill * skill) lo = v;
      else hi = v;
    }
    speed[i] = lo;
  }
  // Steering-rate feasibility (road-wheel angle rate).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const change = Math.abs(Math.atan(curvature[j] * wheelbase) - Math.atan(curvature[i] * wheelbase));
    const limit = (steeringRate * distance[i]) / Math.max(1e-9, change);
    if (limit < speed[i]) speed[i] = limit;
    if (limit < speed[j]) speed[j] = Math.min(speed[j], limit);
  }
  const accelAt = (i, v, kind) => {
    const lat = envelope.lateral(v);
    const u = Math.min(0.999, (v * v * Math.abs(curvature[i])) / Math.max(1, lat));
    const cap = kind === 'brake' ? envelope.brake(v) : envelope.drive(v);
    return Math.max(0, cap * Math.sqrt(1 - u * u));
  };
  for (let pass = 0; pass < passes; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n, v = speed[j];
      speed[i] = Math.min(speed[i], Math.sqrt(v * v + 2 * accelAt(j, v, 'brake') * distance[i]));
    }
    for (let i = 0; i < n; i++) {
      const j = (i + n - 1) % n, v = speed[j];
      speed[i] = Math.min(speed[i], Math.sqrt(v * v + 2 * accelAt(j, v, 'drive') * distance[j]));
    }
  }
  let seconds = 0, maxSteer = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dt = (2 * distance[i]) / Math.max(0.1, speed[i] + speed[j]);
    seconds += dt;
    maxSteer = Math.max(maxSteer, Math.abs(Math.atan(curvature[j] * wheelbase) - Math.atan(curvature[i] * wheelbase)) / Math.max(0.001, dt));
  }
  return { seconds, speed, distance, curvature, maxSteeringRate: maxSteer };
}

export function optimizeGlobal(track, envelope, opts = {}) {
  const limit = opts.limit ?? Math.max(1.5, track.halfWidth - 1.5);
  const widths = opts.widths ?? [140, 70, 32];
  const amplitudes = opts.amplitudes ?? [2.2, 1.0, 0.4];
  const sweeps = opts.sweeps ?? 1;
  const step = opts.step ?? 3;
  const stations = sampleStations(track, step);
  const m = stations.length;
  const offsets = new Float64Array(m); // coarse control = station offsets directly
  const pointAt = (i, q) => offsetPoint(track, stations[i].s, clamp(q, -limit, limit));
  const evaluate = (arr) => lapTimeProfile(arr.map((q, i) => pointAt(i, q)), envelope, opts);
  let points = Array.from(offsets, (_, i) => pointAt(i, 0));
  let profile = evaluate(Array.from(offsets));
  const initialSeconds = profile.seconds;
  let accepted = 0;
  const stationGap = (a, b) => ((a - b + track.length * 1.5) % track.length) - track.length * 0.5;
  for (let scale = 0; scale < widths.length; scale++) {
    for (let sweep = 0; sweep < sweeps; sweep++) {
      const width = widths[scale], amp = amplitudes[scale];
      for (let center = 0; center < m; center += 2) {
        const affected = [];
        for (let i = 0; i < m; i++) {
          const u = Math.abs(stationGap(stations[i].s, stations[center].s)) / width;
          if (u < 1) affected.push({ i, basis: (1 - u * u) ** 2, old: offsets[i] });
        }
        if (!affected.length) continue;
        let winner = null;
        for (const sign of [-1, 1]) {
          const cand = new Float64Array(offsets);
          let legal = true;
          for (const { i, basis, old } of affected) {
            const q = old + sign * amp * basis;
            if (Math.abs(q) > limit) { legal = false; break; }
            cand[i] = q;
          }
          if (!legal) continue;
          const next = evaluate(Array.from(cand));
          if (next.maxSteeringRate > 1.5) continue;
          if (next.seconds < profile.seconds - 1e-4 && (!winner || next.seconds < winner.profile.seconds)) {
            winner = { sign, profile: next, cand };
          }
        }
        if (winner) {
          offsets.set(winner.cand);
          profile = winner.profile;
          accepted++;
        }
      }
    }
  }
  return { stations, offsets, speeds: profile.speed, distances: profile.distance, curvatures: profile.curvature, lapTime: profile.seconds, initialSeconds, accepted, maxSteeringRate: profile.maxSteeringRate };
}

// Runtime line: interpolates global optimum at any station + lateral extra.
export class GlobalLine {
  constructor(track, solution) {
    this.track = track;
    this.stations = solution.stations;
    this.offsets = solution.offsets;
    this.speeds = solution.speeds;
    this.theoreticalLap = solution.lapTime;
    this.limit = Math.max(1.5, track.halfWidth - 1.2);
  }
  _interp(s) {
    const L = this.track.length;
    s = ((s % L) + L) % L;
    const st = this.stations, m = st.length;
    // binary search
    let lo = 0, hi = m - 1;
    if (s <= st[0].s) return { i: m - 1, j: 0, t: s / (st[0].s + L - st[m - 1].s) >= 0 ? (s + L - st[m - 1].s) / (st[0].s + L - st[m - 1].s) : 0 };
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (st[mid].s <= s) lo = mid; else hi = mid; }
    // handle wrap segment lo=m-1 -> j=0
    const a = st[lo], b = st[(lo + 1) % m];
    const span = ((b.s - a.s + L) % L) || 1;
    const t = clamp(((s - a.s + L) % L) / span, 0, 1);
    return { i: lo, j: (lo + 1) % m, t };
  }
  offsetAt(s) {
    const { i, j, t } = this._interp(s);
    return lerp(this.offsets[i], this.offsets[j], t);
  }
  speedAt(s) {
    const { i, j, t } = this._interp(s);
    return lerp(this.speeds[i], this.speeds[j], t);
  }
  at(s, extra = 0) {
    const q = clamp(this.offsetAt(s) + extra, -this.limit, this.limit);
    const p = this.track.at(s, q);
    p.offset = q;
    p.speed = this.speedAt(s);
    return p;
  }
  curvatureAt(s) {
    const a = this.at(s - 4), b = this.at(s), c = this.at(s + 4);
    return pathCurvature(a, b, c);
  }
}
