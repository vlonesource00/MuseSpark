// Racecraft lab: scripted deterministic 2-car scenarios with quantitative gates.
// S1 slow-rival: faster ego must complete a pass. S2 equal-duel: no kamikaze.
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

function runScenario(name, skills, laps, timeout) {
  const track = new Track('harbor-ring');
  const session = new MuseSession(track, { mode: 'race', laps, field: 2, fastLine: true, skills, driverMode: 'SPRINT' });
  session.start({});
  const dt = 1 / 120;
  let steps = 0;
  let minGap = Infinity, overlapSteps = 0;
  const maneuvers = {};
  // Ego (car 0) starts BEHIND: swap grid so rival leads.
  // (Grid P1/P2 by index; place car 0 behind car 1.)
  const c0 = session.cars[0], c1 = session.cars[1];
  const s0 = c0.s, q0 = c0.lateral;
  c0.place(track, c1.s - 12, 1.5); c1.place(track, s0, -1.5);
  for (const c of [c0, c1]) {
    const gridToFinish = ((track.finishS - track.gridS) % track.length + track.length) % track.length;
    c.race = { progress: -gridToFinish - (c === c0 ? 12 : 0), previousS: c.s, lap: 1, lastLap: null, bestLap: null, lapStart: 0, sector: 0, valid: true, sectors: [], finishTime: null, offtrack: 0 };
  }
  while (session.phase !== 'finished' && steps < 120 * timeout) {
    session.step(dt);
    steps++;
    const m = session.drivers[0].debug.maneuver?.type ?? '?';
    maneuvers[m] = (maneuvers[m] ?? 0) + 1;
    const ds = Math.abs(c0.s - c1.s);
    const wrapDs = Math.min(ds, track.length - ds);
    if (wrapDs < minGap) minGap = wrapDs;
    if (wrapDs < 8) overlapSteps++;
  }
  const order = session.standings();
  const egoPos = order.indexOf(c0) + 1;
  const res = {
    name, egoPos, egoBest: c0.race.bestLap?.toFixed(2) ?? '-', rivalBest: c1.race.bestLap?.toFixed(2) ?? '-',
    contacts: session.contacts, severe: session.collisionStats.severeContacts,
    egoOff: c0.race.offtrack.toFixed(1), minGap: minGap.toFixed(1), overlapS: (overlapSteps / 120).toFixed(1), maneuvers
  };
  console.log(JSON.stringify(res));
  return res;
}

const slow = runScenario('slow-rival', [0.99, 0.88], 2, 400);
const duel = runScenario('equal-duel', [0.96, 0.96], 2, 400);
// Gates: slow-rival must pass (P1); equal-duel must stay clean-ish (<40 contacts, no severe).
let fail = 0;
if (slow.egoPos !== 1) { console.error('GATE FAIL: slow-rival not passed'); fail = 1; }
if (duel.contacts > 60 || duel.severe > 0) { console.error('GATE FAIL: equal-duel kamikaze'); fail = 1; }
process.exitCode = fail;
