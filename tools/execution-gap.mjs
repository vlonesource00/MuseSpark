// M2g — Execution-gap audit: GLOBAL PLAN vs LOCAL TRAJECTORY vs ACTUAL VEHICLE.
// Station-domain (~3m) comparison over one flying lap + corner-complex table +
// transient-feasibility walk of the theoretical plan. Measure, don't guess.
import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';
import { pathCurvature } from '../src/sim/path-geometry.js';
import { thermalMargin } from '../src/muse/types.js';

const BIN = 3;
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f; };

// ---------------------------------------------------------------- run + log
const track = new Track('harbor-ring');
const session = new MuseSession(track, { mode: 'practice', laps: Number(arg('laps', 4)), fastLine: true, driverMode: 'QUALIFYING' });
const line = session.line;
const L = track.length;
session.start({});
const dt = 1 / 120;
const samples = [];
let steps = 0;
const t0wall = Date.now();
while (session.phase !== 'finished' && steps < 120 * 600) {
  session.step(dt);
  steps++;
  const c = session.player, d = session.drivers[0];
  const w = d.debug?.winner;
  let winQ = null, winV = null;
  if (w?.points?.length) {
    let bd = Infinity, bi = 0;
    for (let k = 0; k < w.points.length; k++) {
      const dd = Math.abs(((w.points[k].s - c.s) % L + L * 1.5) % L - L * 0.5);
      if (dd < bd) { bd = dd; bi = k; }
    }
    if (bd < 14) { winQ = w.points[bi].offset; winV = w.speed?.[bi] ?? null; }
  }
  samples.push({
    t: session.time, lap: c.race.lap, s: c.s, x: c.x, z: c.z, yaw: c.yaw, yawRate: c.yawRate,
    u: c.u, v: c.v, speed: c.speed, steer: c.steering, thr: c.controls.throttle, brk: c.controls.brake,
    ax: c.ax, ay: c.ay, q: c.lateral,
    util: Math.max(...c.wheels.map((x) => x.tyre.utilisation ?? 0)),
    core: Math.max(...c.wheels.map((x) => x.tyre.core ?? 70)),
    wear: Math.max(...c.wheels.map((x) => x.tyre.wear ?? 0)),
    tgt: d.targetSpeed, src: d.brakeSource, pursuit: d.debug?.pursuit ?? 0,
    cmdSteer: d.debug?.cmd?.steer ?? c.controls.steer,
    lineQ: line.offsetAt(c.s), lineV: line.speedAt(c.s),
    winQ, winV,
    bevMin: d.debug?.brakeEvent?.targetMinimumSpeed ?? null,
    bevStart: d.debug?.brakeEvent?.startS ?? null,
    bevRel: d.debug?.brakeEvent?.releaseS ?? null,
    bevApex: d.debug?.brakeEvent?.apexS ?? null,
    mpcMs: d.controller?.ms ?? 0, trajMs: d.debug?.trajMs ?? 0, stratMs: d.debug?.strategyMs ?? 0
  });
}
// ------------------------------------------------------- pick lap to analyze
const byLap = new Map();
for (const sm of samples) {
  if (!byLap.has(sm.lap)) byLap.set(sm.lap, []);
  byLap.get(sm.lap).push(sm);
}
const edge = track.halfWidth + 0.5;
let best = null;
for (const [lapIdx, arr] of byLap) {
  if (lapIdx <= 1 || arr.length < 100) continue; // lap 1 is the standing-start out-lap
  const t = arr.at(-1).t - arr[0].t;
  const valid = !arr.some((a) => Math.abs(a.q) > edge);
  if (!best || (valid && !best.valid) || (valid === best.valid && t < best.time)) best = { lap: lapIdx, time: t, valid, n: arr.length };
}
if (!best) { console.error('no analyzable lap'); process.exit(1); }
const lap = byLap.get(best.lap);
console.log(`analyzing lap ${best.lap}: ${best.time.toFixed(3)}s valid=${best.valid} samples=${lap.length} (wall ${(Date.now() - t0wall) / 1000}s)`);
// ------------------------------------------------------------------- binning
const nbins = Math.ceil(L / BIN);
const bins = [];
for (let i = 0; i < nbins; i++) {
  const s0 = i * BIN, s1 = s0 + BIN;
  const inBin = lap.filter((a) => { const s = ((a.s % L) + L) % L; return s >= s0 && s < s1; });
  if (!inBin.length) { bins.push(null); continue; }
  const mean = (f) => inBin.reduce((x, a) => x + f(a), 0) / inBin.length;
  const mx = (f) => Math.max(...inBin.map(f));
  const s = s0 + BIN / 2;
  const lp = line.at(s);
  bins.push({
    s, n: inBin.length,
    v: mean((a) => a.speed), ref: line.speedAt(s),
    qA: mean((a) => a.q), qG: line.offsetAt(s),
    qL: mean((a) => (a.winQ ?? line.offsetAt(a.s))),
    headG: lp.heading,
    yaw: mean((a) => a.yaw), yawRate: mean((a) => a.yawRate),
    kG: lp.curvature,
    brk: mean((a) => a.brk), mxBrk: mx((a) => a.brk),
    thr: mean((a) => a.thr),
    steer: mean((a) => a.steer), cmdSteer: mean((a) => a.cmdSteer),
    mxSteerRate: 0, // filled below
    slip: mean((a) => Math.atan2(a.v, Math.max(4, Math.abs(a.u)))),
    mxSlip: mx((a) => Math.abs(Math.atan2(a.v, Math.max(4, Math.abs(a.u))))),
    ax: mean((a) => a.ax), ay: mean((a) => a.ay),
    util: mean((a) => a.util), mxUtil: mx((a) => a.util),
    core: mx((a) => a.core),
    tgt: mean((a) => a.tgt),
    off: inBin.some((a) => Math.abs(a.q) > edge),
    src: inBin.map((a) => a.src).sort((a, b) =>
      inBin.filter((x) => x.src === b).length - inBin.filter((x) => x.src === a).length)[0]
  });
}
// steering rate from actual steering, per bin
for (let i = 1; i < bins.length; i++) {
  if (!bins[i] || !bins[i - 1]) continue;
  const dSteer = bins[i].steer - bins[i - 1].steer;
  const dtBin = BIN / Math.max(5, (bins[i].v + bins[i - 1].v) / 2);
  bins[i].mxSteerRate = Math.abs(dSteer * 0.48) / Math.max(1e-3, dtBin); // road-wheel rad/s
}
// braking events (contiguous brake>0.25 ranges) for release/exit attribution
const events = [];
{
  let open = null;
  bins.forEach((b, i) => {
    if (!b) return;
    if (b.mxBrk > 0.25 && !open) open = { from: i };
    if (open && b.mxBrk <= 0.25) { open.to = i; events.push(open); open = null; }
  });
  if (open) { open.to = bins.length - 1; events.push(open); }
}
const distSinceBrakeEnd = (i) => {
  let d = Infinity;
  for (const e of events) {
    if (i <= e.to) continue;
    const ahead = (bins[i].s - bins[e.to].s + L) % L;
    if (ahead < d) d = ahead;
  }
  return d;
};
// distance to NEXT braking onset ahead (ENTRY attribution: arriving hot)
const distToBrakeOnset = (i) => {
  let d = Infinity;
  for (const e of events) {
    const ahead = (bins[e.from].s - bins[i].s + L) % L;
    if (ahead > 1 && ahead < d) d = ahead;
  }
  return d;
};
// ---------------------------------------------------------- classification
const loss = {};
const add = (cls, dt) => { loss[cls] = (loss[cls] ?? 0) + dt; };
const rows = [];
bins.forEach((b, i) => {
  if (!b) return;
  const dtRef = BIN / Math.max(4, b.ref), dtAct = BIN / Math.max(4, b.v);
  const dSec = dtAct - dtRef;
  let cls = 'NONE';
  if (dSec > 0.002) {
    const sinceBrk = distSinceBrakeEnd(i);
    const therm = thermalMargin(b.core, 0);
    if (b.off || b.mxSlip > 0.35) cls = 'INCIDENT';
    else if (b.mxBrk > 0.2 && b.v < b.ref - 1.0) cls = 'BRAKING';
    else if (sinceBrk < 30 && b.thr < 0.6 && b.v < b.ref - 0.5) cls = 'BRAKE_RELEASE';
    else if (sinceBrk < 200 && b.thr < 0.95 && b.v < b.ref - 0.5) cls = sinceBrk < 45 ? 'THROTTLE_PICKUP' : 'EXIT';
    else if (distToBrakeOnset(i) < 60 && b.v > b.ref + 1.5) cls = 'ENTRY';
    else if (Math.abs(b.kG) > 0.004 && b.v < b.ref - 1.0) cls = 'MID_CORNER';
    // THERMAL only when tracking (v≈tgt) a heat-depressed target — heat alone
    // explains nothing while the car is braking/cornering below target.
    else if (therm < 0.97 && b.v > b.tgt - 1.5 && b.v < b.ref - 0.5) cls = 'THERMAL';
    else if (b.mxSteerRate > 1.0) cls = 'STEERING_RATE';
    else if (Math.abs(b.yawRate - b.v * b.kG) > 0.15) cls = 'YAW_TRANSIENT';
    else if (b.mxUtil > 0.92) cls = 'COMBINED_SLIP';
    else if (Math.abs(b.qA - b.qG) > 2 && Math.abs(b.qA - b.qL) < 1) cls = 'LOCAL_TRAJECTORY';
    else if (Math.abs(b.qA - b.qG) > 2) cls = 'GLOBAL_GEOMETRY';
    else cls = 'CONTROL';
    add(cls, dSec);
  }
  rows.push({ s: +b.s.toFixed(1), dSec: +dSec.toFixed(4), cls, v: +b.v.toFixed(1), ref: +b.ref.toFixed(1) });
});
const total = Object.values(loss).reduce((a, b) => a + b, 0);
console.log(`\nLOSS vs GEOMETRIC-INSTANTANEOUS (lap ${best.lap}, total +${total.toFixed(2)}s):`);
for (const [k, v] of Object.entries(loss).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${v.toFixed(2)}s`);
}
console.log('\nWORST 12 BINS:');
for (const r of rows.filter((r) => r.dSec > 0.004).sort((a, b) => b.dSec - a.dSec).slice(0, 12)) {
  console.log(`  s=${r.s} +${r.dSec}s ${r.cls.padEnd(16)} v=${r.v} ref=${r.ref}`);
}
// ------------------------------------------------------- complex audit
const sectors = track.scenario?.sectors ?? [
  { id: 'harbor-straight', fromFraction: 0.0, toFraction: 0.235 },
  { id: 'east-hairpin', fromFraction: 0.235, toFraction: 0.405 },
  { id: 'infield', fromFraction: 0.405, toFraction: 0.69 },
  { id: 'west-loop', fromFraction: 0.69, toFraction: 0.865 },
  { id: 'final-chicane', fromFraction: 0.865, toFraction: 1.0 }
];
console.log('\nCOMPLEX AUDIT:');
const complexes = [];
for (const sec of sectors) {
  const a = sec.fromFraction * L, b = sec.toFraction * L;
  const inSec = bins.filter((x) => x && x.s >= a && x.s < b);
  if (!inSec.length) continue;
  const speedAt = (s) => {
    let bestB = null, bd = Infinity;
    for (const x of bins) {
      if (!x) continue;
      const d = Math.abs(((x.s - s) % L + L) % L);
      if (d < bd) { bd = d; bestB = x; }
    }
    return bestB?.v ?? NaN;
  };
  let minB = inSec[0];
  for (const x of inSec) if (x.v < minB.v) minB = x;
  let brakeOnset = null, peakBrk = 0, release = null, pickup = null;
  for (const x of inSec) {
    if (brakeOnset === null && x.mxBrk > 0.3) brakeOnset = x.s;
    peakBrk = Math.max(peakBrk, x.mxBrk);
    if (brakeOnset !== null && release === null && x.mxBrk < 0.1) release = x.s;
    if (release !== null && pickup === null && x.thr > 0.9) pickup = x.s;
  }
  const tAct = inSec.reduce((t, x) => t + BIN / Math.max(4, x.v), 0);
  const tRef = inSec.reduce((t, x) => t + BIN / Math.max(4, x.ref), 0);
  const c = {
    id: sec.id, entryV: +inSec[0].v.toFixed(1), entryQ: +inSec[0].qA.toFixed(1),
    brakeOnset: brakeOnset?.toFixed(0) ?? '-', peakBrk: +peakBrk.toFixed(2),
    minV: +minB.v.toFixed(1), minS: +minB.s.toFixed(0), mxSlip: +Math.max(...inSec.map((x) => x.mxSlip)).toFixed(2),
    mxUtil: +Math.max(...inSec.map((x) => x.mxUtil)).toFixed(2),
    release: release?.toFixed(0) ?? '-', pickup: pickup?.toFixed(0) ?? '-',
    exitV: +inSec.at(-1).v.toFixed(1), exitQ: +inSec.at(-1).qA.toFixed(1),
    plus50: +speedAt(minB.s + 50).toFixed(1), plus100: +speedAt(minB.s + 100).toFixed(1), plus200: +speedAt(minB.s + 200).toFixed(1),
    tAct: +tAct.toFixed(2), tRef: +tRef.toFixed(2), loss: +(tAct - tRef).toFixed(2)
  };
  complexes.push(c);
  console.log(`  ${c.id}: entry ${c.entryV}@q${c.entryQ} | brake@${c.brakeOnset} pk${c.peakBrk} | min ${c.minV}@${c.minS} slip${c.mxSlip} util${c.mxUtil} | rel@${c.release} pick@${c.pickup} | exit ${c.exitV}@q${c.exitQ} +50 ${c.plus50} +100 ${c.plus100} +200 ${c.plus200} | t ${c.tAct}s vs ${c.tRef}s (+${c.loss})`);
}
// --------------------------------------------- optimizer-vs-geometric check
// Does the optimizer's own speed profile respect the TRUE geometric curvature
// of its interpolated line (same ±4m stencil the car drives), or an aliased
// coarse version? u>1 here = the plan demands impossible grip.
const deltaAt = (s) => {
  const a = line.at(s - 4), b = line.at(s), c = line.at(s + 4);
  return pathCurvature(a, b, c);
};
const env = session.envelope, SPEC = session.spec, Lwb = SPEC.wheelbase;
let maxRate = 0, mUtil1 = 0, mUtil09 = 0, mRate = 0, worstU = 0, worstS = 0;
for (let s = 0; s < L; s += BIN) {
  const v = line.speedAt(s);
  const k = deltaAt(s);
  const d1 = Math.atan(deltaAt(s + 3) * Lwb), d0 = Math.atan(deltaAt(s - 3) * Lwb);
  const rate = Math.abs(d1 - d0) / 6 * v; // road-wheel rad/s to follow plan
  maxRate = Math.max(maxRate, rate);
  if (rate > 1.35) mRate += BIN;
  const u = (v * v * Math.abs(k)) / Math.max(1, env.lateral(v));
  if (u > worstU) { worstU = u; worstS = s; }
  if (u > 1.0) mUtil1 += BIN;
  else if (u > 0.9) mUtil09 += BIN;
}
console.log(`\nFEASIBILITY WALK (geometric plan @ profile speed):`);
console.log(`  max required steering rate: ${maxRate.toFixed(2)} rad/s road (provisional limit 1.35)`);
console.log(`  meters over rate limit: ${mRate.toFixed(0)}m`);
console.log(`  worst combined utilization: ${worstU.toFixed(3)} @ s=${worstS.toFixed(0)}`);
console.log(`  meters u>1.0 (infeasible): ${mUtil1.toFixed(0)}m | meters 0.9<u<=1.0: ${mUtil09.toFixed(0)}m`);
// Optimizer-internal vs geometric curvature at the worst stations: if the
// optimizer's stencil saw far less curvature than the driven line has, its
// speeds are founded on an aliased ghost, not the real path.
{
  const sol = session.solution;
  const st = sol.stations;
  const idxAt = (s) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < st.length; i++) {
      const d = Math.abs(((st[i].s - s) % L + L) % L);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  console.log(`  optimizer-vs-geometric @ worst spots (kopt=internal stencil, kgeo=driven ±4m):`);
  for (const s of [worstS, 860, 1330, 1410, 2250, 2590]) {
    const bi = idxAt(((s % L) + L) % L);
    const kopt = Math.abs(sol.curvatures?.[bi] ?? NaN);
    const kgeo = Math.abs(deltaAt(((s % L) + L) % L));
    console.log(`    s=${s} kopt=${kopt.toFixed(4)} kgeo=${kgeo.toFixed(4)} ratio=${(kgeo / Math.max(1e-6, kopt)).toFixed(2)} vprof=${line.speedAt(s).toFixed(1)}`);
  }
}
// ------------------------------------------------------------------ report
const out = {
  lap: best.lap, lapTime: +best.time.toFixed(3), valid: best.valid,
  theoretical: +session.theoreticalLap.toFixed(3),
  loss, totalLoss: +total.toFixed(3), rows, complexes,
  feasibility: { maxSteerRate: +maxRate.toFixed(3), metersOverRate: mRate, worstU: +worstU.toFixed(3), worstS: +worstS.toFixed(0), metersUgt1: mUtil1, metersU09_10: mUtil09 }
};
const outPath = arg('json', 'reports/execution-gap.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`\nwrote ${outPath}`);
