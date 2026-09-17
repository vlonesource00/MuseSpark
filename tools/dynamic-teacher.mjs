// T_DYNAMIC (teacher upper bound): the ONLINE MPC stack with generous compute
// (long horizon, many iterations, no deadline) in closed loop on the plant.
// This is M_CONTROL executed at its best — a feasible dynamic trajectory and
// hence an UPPER BOUND on the transient optimum (a true offline
// multiple-shooting optimum could only be faster). Label honestly:
//   profile optimism = T_DYNAMIC - T_PROFILE (model/planner side)
//   execution gap    = T_ACTUAL - T_DYNAMIC (controller/compute side)
// Wall time is minutes (offline analysis, never the live path).
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

const track = new Track('harbor-ring');
const session = new MuseSession(track, {
  mode: 'practice', laps: 3, fastLine: true, driverMode: 'QUALIFYING',
  controller: 'mpc',
  mpc: { horizon: 16, step: 0.12, iters: 12, deadlineMs: 1e9, rateHz: 60 }
});
console.log(`T_GEOMETRIC=${session.theoreticalLap.toFixed(3)} T_PROFILE=${session.profileLap.toFixed(3)}`);
session.start({});
const dt = 1 / 120;
let steps = 0;
const t0 = Date.now();
while (session.phase !== 'finished' && steps < 120 * 600) {
  session.step(dt);
  steps++;
}
const d = session.drivers[0];
const st = d.mpc.stats;
const w = [...st.p95win].sort((a, b) => a - b);
console.log(`T_DYNAMIC(teacher)=${session.player.race.bestLap?.toFixed(3) ?? 'none'}s off=${session.player.race.offtrack.toFixed(1)} (wall ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log(`teacher solves=${st.solves} meanIters=${(st.iters / Math.max(1, st.solves)).toFixed(1)} maxMs=${st.maxMs.toFixed(1)} p95=${(w[(w.length * 0.95) | 0] ?? 0).toFixed(1)} miss=${st.misses} fb=${st.fallbacks}`);
const dyn = session.player.race.bestLap;
if (dyn) {
  console.log(`profile optimism = ${(dyn - session.profileLap).toFixed(3)}s (dynamic - profile)`);
}
