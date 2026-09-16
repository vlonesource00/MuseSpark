// Bridge smoke (LOCAL, benchmark tree untouched): Muse on REAL host physics.
// (a) shared-mode step integrity over 1500 ticks; (b) solo pace on host plant.
import { Track } from '../../benchmark/host/astra/src/sim/track.js';
import { Session } from '../../benchmark/host/astra/src/sim/session.js';
import { createMuseBridge } from '../bridge/musespark-bridge.js';

const mode = process.argv.includes('--pace') ? 'pace' : 'smoke';
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt', mixed: false });
session.laps = mode === 'pace' ? 2 : 99;
session.field = mode === 'pace' ? 1 : 3;
session.aggression = 0.72;
session.autopilot = true;
session.start({ freshTrack: true });
// Install Muse bridges as the session's driver stack (same as field.attach).
const bridges = session.activeCars.map((car, index) => createMuseBridge({
  cars: session.activeCars, hostTrack: track, index, options: { mode: mode === 'pace' ? 'QUALIFYING' : 'SPRINT', skill: mode === 'pace' ? 0.995 : 0.955 + (index % 4) * 0.008 }
}));
bridges.forEach((b, i) => { session.drivers[i] = b; });
const DT = 1 / 120;
const maxSteps = mode === 'pace' ? 120 * 500 : 1500;
let steps = 0, nanFound = false;
while (steps < maxSteps && session.phase !== 'finished') {
  session.step(DT, { throttle: 0, brake: 0, steer: 0 });
  if (session.phase === 'finished' && mode !== 'pace') session.phase = 'racing';
  steps++;
  for (const c of session.activeCars) {
    if (!Number.isFinite(c.x + c.z + c.speed)) nanFound = true;
  }
}
const errors = bridges.reduce((a, b) => a + b.errors, 0);
console.log(`mode=${mode} steps=${steps} phase=${session.phase} errors=${errors} nan=${nanFound}`);
for (const c of session.activeCars) {
  console.log(`car${c.id} best=${c.race.bestLap?.toFixed(3) ?? '-'} off=${c.race.offtrack.toFixed(1)} dmg=${c.damage.toFixed(2)}`);
}
console.log(`contacts=${session.contacts}`);
let fail = 0;
if (errors > 0 || nanFound) { console.error('BRIDGE SMOKE FAIL: errors/NaN'); fail = 1; }
if (mode === 'pace' && session.activeCars[0].race.bestLap == null) { console.error('BRIDGE PACE FAIL: no valid host-physics lap'); fail = 1; }
process.exitCode = fail;
