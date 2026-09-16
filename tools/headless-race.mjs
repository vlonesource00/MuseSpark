// Headless race: 6-car sprint, racecraft metrics + performance profile.
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

const track = new Track('harbor-ring');
const session = new MuseSession(track, { mode: 'race', laps: 3, field: 6, fastLine: true });
session.start({});
const dt = 1 / 120;
let steps = 0;
const maxSteps = 120 * 600;
const aiMs = [];
while (session.phase !== 'finished' && steps < maxSteps) {
  const t0 = performance.now();
  session.step(dt);
  aiMs.push(performance.now() - t0);
  steps++;
}
aiMs.sort((a, b) => a - b);
const mean = aiMs.reduce((x, y) => x + y, 0) / Math.max(1, aiMs.length);
const p95 = aiMs[(aiMs.length * 0.95) | 0] ?? 0;
const max = aiMs.at(-1) ?? 0;
console.log(`finished=${session.phase} time=${session.time.toFixed(1)}s steps=${steps}`);
console.log(`standings: ${session.standings().map((c) => `${c.name} best=${c.race.bestLap ? c.race.bestLap.toFixed(2) : '-'}`).join(' | ')}`);
console.log(`contacts=${session.contacts} severe=${session.collisionStats.severeContacts} peakClosing=${(session.collisionStats.peakClosing ?? 0).toFixed(1)}`);
console.log(`ai_step_ms mean=${mean.toFixed(3)} p95=${p95.toFixed(3)} max=${max.toFixed(3)} (6 cars, 120Hz step incl physics)`);
console.log(`supervisor_activations=${session.drivers.map((d) => d.safety.activations).join(',')}`);
console.log(`blocked_debt=${session.drivers[0].strategy.blockedDebt.toFixed(2)}s maneuver=${session.drivers[0].debug.maneuver?.type}`);
if (mean > 8) { console.error('PERF GATE FAILED: mean step too high'); process.exitCode = 1; }
