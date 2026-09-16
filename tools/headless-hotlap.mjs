// Headless deterministic hotlap: 1-car practice, theoretical vs realized.
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

const track = new Track('harbor-ring');
const session = new MuseSession(track, { mode: 'practice', laps: 3, fastLine: !process.argv.includes('--full'), driverMode: 'QUALIFYING' });
console.log(`theoretical=${session.theoreticalLap.toFixed(3)}s initial=${session.solution.initialSeconds.toFixed(3)}s accepted=${session.solution.accepted}`);
session.start({});
const dt = 1 / 120;
let steps = 0;
const maxSteps = 120 * 400;
let phantomEvents = 0;
while (session.phase !== 'finished' && steps < maxSteps) {
  session.step(dt);
  steps++;
  const d = session.drivers[0];
  const car = session.player;
  // Phantom brake detector: brake>0.8 on clear straight, no conflict, brake event distant.
  if (car.controls.brake > 0.8 && car.speed > 30 && d.brakeSource === 'NONE') {
    const aheadV = session.line.speedAt(car.s + 40);
    if (aheadV > car.speed + 2) phantomEvents++;
  }
}
const best = session.player.race.bestLap;
console.log(`realized_best=${best ? best.toFixed(3) : 'none'}s steps=${steps} time=${session.time.toFixed(1)}s`);
console.log(`phantom_brake_samples=${phantomEvents}`);
console.log(`offtrack=${session.player.race.offtrack.toFixed(2)}s contacts=${session.contacts}`);
const gap = best ? best - session.theoreticalLap : NaN;
console.log(`control_gap=${Number.isFinite(gap) ? gap.toFixed(3) : 'n/a'}s (theoretical vs realized)`);
if (phantomEvents > 0) { console.error('PHANTOM BRAKE DETECTED'); process.exitCode = 1; }
