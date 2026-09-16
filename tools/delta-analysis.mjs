// Delta-time analysis: per-5m realized vs theoretical, loss classification.
// Classes: LINE / BRAKING / MID-CORNER / EXIT / STRAIGHT / CONTROL / TRAFFIC / THERMAL
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

const track = new Track('harbor-ring');
const fast = process.argv.includes('--fast');
const session = new MuseSession(track, { mode: 'practice', laps: 2, fastLine: fast });
session.start({});
const dt = 1 / 120;
let steps = 0;
const samples = []; // {s, speed, throttle, brake, q, latG}
while (session.phase !== 'finished' && steps < 120 * 500) {
  session.step(dt);
  steps++;
  const c = session.player;
  if (session.phase === 'racing' && steps % 2 === 0) {
    samples.push({ s: c.s, speed: c.speed, throttle: c.controls.throttle, brake: c.controls.brake, q: c.lateral, latG: c.ay / 9.81, t: session.time });
  }
}
// Only keep laps after the first out-lap-ish progress? Use all; bin by station.
const L = track.length;
const BIN = 5;
const nbins = Math.ceil(L / BIN);
const bins = Array.from({ length: nbins }, () => ({ speeds: [], q: [], brake: 0, n: 0, thr: [] }));
for (const sm of samples) {
  const b = Math.floor((((sm.s % L) + L) % L) / BIN) % nbins;
  bins[b].speeds.push(sm.speed); bins[b].q.push(sm.q); bins[b].thr.push(sm.throttle);
  if (sm.brake > 0.2) bins[b].brake++;
  bins[b].n++;
}
let cum = 0;
const losses = [];
for (let i = 0; i < nbins; i++) {
  const s = (i + 0.5) * BIN;
  if (!bins[i].n) continue;
  const act = bins[i].speeds.reduce((a, b) => a + b, 0) / bins[i].n;
  const ref = session.line.speedAt(s);
  const dSec = BIN / Math.max(4, act) - BIN / Math.max(4, ref);
  cum += dSec;
  const q = Math.abs(bins[i].q.reduce((a, b) => a + b, 0) / bins[i].n);
  const braking = bins[i].brake > bins[i].n * 0.15;
  const avgThr = bins[i].thr.reduce((a, b) => a + b, 0) / bins[i].n;
  const curv = Math.abs(track.at(s).curvature);
  let cls = 'STRAIGHT';
  if (dSec > 0.002) {
    if (braking && act < ref - 1.5) cls = 'BRAKING';
    else if (curv > 0.004 && act < ref - 1.5) cls = 'MID-CORNER';
    else if (curv > 0.002 && avgThr < 0.8 && act < ref - 1) cls = 'EXIT';
    else if (q > 3) cls = 'LINE';
    else if (act < ref - 0.4) cls = 'CONTROL';
  }
  losses.push({ s, dSec, cum, ref, act, cls });
}
const byClass = {};
for (const l of losses) {
  byClass[l.cls] = byClass[l.cls] ?? { total: 0, n: 0, worst: [] };
  byClass[l.cls].total += l.dSec; byClass[l.cls].n++;
  if (l.dSec > 0.01) byClass[l.cls].worst.push(l);
}
console.log(`bins=${losses.length} cumDelta=${cum.toFixed(2)}s (approx; includes out-lap)`);
for (const [cls, v] of Object.entries(byClass).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${cls.padEnd(10)} loss=${v.total.toFixed(2)}s bins=${v.n}`);
  for (const w of v.worst.sort((a, b) => b.dSec - a.dSec).slice(0, 4)) {
    console.log(`   s=${w.s.toFixed(0)} dSec=${w.dSec.toFixed(3)} ref=${w.ref.toFixed(1)} act=${w.act.toFixed(1)}`);
  }
}
console.log(`best=${session.player.race.bestLap?.toFixed(2) ?? 'none'} theo=${session.theoreticalLap.toFixed(2)}`);
