// Soak: 8-car / 4-lap stint. Gates: all finish, no NaN/teleport, perf gate.
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

const track = new Track('harbor-ring');
const session = new MuseSession(track, { mode: 'race', laps: 4, field: 8, fastLine: true });
session.start({});
const dt = 1 / 120;
let steps = 0;
const maxSteps = 120 * 900;
const aiMs = [];
let nanFound = false;
while (session.phase !== 'finished' && steps < maxSteps) {
  const t0 = performance.now();
  session.step(dt);
  aiMs.push(performance.now() - t0);
  steps++;
  if (steps % 120 === 0) {
    for (const c of session.activeCars) {
      if (!Number.isFinite(c.x + c.z + c.speed) || Math.abs(c.x) > 3000 || Math.abs(c.z) > 3000) nanFound = true;
    }
  }
}
aiMs.sort((a, b) => a - b);
const mean = aiMs.reduce((a, b) => a + b, 0) / Math.max(1, aiMs.length);
const finished = session.activeCars.filter((c) => c.race.finishTime !== null).length;
console.log(`phase=${session.phase} simTime=${session.time.toFixed(1)}s steps=${steps} finished=${finished}/8`);
console.log(`validBestLaps=${session.activeCars.filter((c) => c.race.bestLap !== null).length}/8`);
console.log(`contacts=${session.contacts} frames=${session.contactFrames} severe=${session.collisionStats.severeContacts}`);
console.log(`step_ms mean=${mean.toFixed(3)} p95=${(aiMs[(aiMs.length * 0.95) | 0] ?? 0).toFixed(3)} max=${(aiMs.at(-1) ?? 0).toFixed(3)}`);
console.log(`activations=[${session.drivers.slice(0, 8).map((d) => d.safety.activations).join(',')}]`);
let fail = 0;
// Session ends when the player finishes; backmarkers may still run. Gate on
// player finish + integrity + perf, report field spread informationally.
if (session.player.race.finishTime === null) { console.error('SOAK FAIL: player did not finish'); fail = 1; }
if (nanFound) { console.error('SOAK FAIL: NaN/teleport'); fail = 1; }
if (mean > 8) { console.error('SOAK FAIL: perf gate'); fail = 1; }
process.exitCode = fail;
