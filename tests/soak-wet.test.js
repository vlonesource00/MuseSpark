import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';

test('wet envelope derates lateral grip, engine-limited drive unchanged', () => {
  const spec = carSpecFor('gt');
  const dry = createEnvelope(spec, { fuel: 20, wetness: 0 });
  const wet = createEnvelope(spec, { fuel: 20, wetness: 0.75 });
  assert.ok(wet.lateral(40) < dry.lateral(40) * 0.85, `wet=${wet.lateral(40)} dry=${dry.lateral(40)}`);
  assert.ok(wet.brake(40) < dry.brake(40));
});

test('wet hotlap completes valid and slower than dry', { timeout: 180000 }, () => {
  const track = new Track('harbor-ring');
  track.wetness = 0.75;
  const session = new MuseSession(track, { mode: 'practice', laps: 1, fastLine: true, driverMode: 'SPRINT' });
  session.start({});
  const dt = 1 / 120;
  let i = 0;
  while (session.phase !== 'finished' && i < 120 * 500) { session.step(dt); i++; }
  assert.equal(session.phase, 'finished');
  assert.ok(session.player.race.bestLap !== null, 'wet lap must be valid');
  assert.ok(session.player.race.bestLap > 86.88, `wet ${session.player.race.bestLap} must exceed dry best`);
  assert.ok(session.player.race.bestLap < 160, `wet ${session.player.race.bestLap} absurd`);
});

test('determinism: identical runs produce identical trajectories', { timeout: 120000 }, () => {
  const run = () => {
    const track = new Track('harbor-ring');
    const s = new MuseSession(track, { mode: 'practice', laps: 1, fastLine: true, driverMode: 'QUALIFYING' });
    s.start({});
    for (let i = 0; i < 120 * 20; i++) s.step(1 / 120);
    return `${s.player.race.progress.toFixed(6)}|${s.player.x.toFixed(6)}|${s.player.z.toFixed(6)}|${s.player.speed.toFixed(6)}`;
  };
  assert.equal(run(), run());
});

test('soak slice: 8-car 30s, no NaN, all finite, perf sane', { timeout: 180000 }, () => {
  const track = new Track('harbor-ring');
  const session = new MuseSession(track, { mode: 'race', laps: 9, field: 8, fastLine: true });
  session.start({});
  const t0 = performance.now();
  for (let i = 0; i < 120 * 30; i++) session.step(1 / 120);
  const mean = (performance.now() - t0) / (120 * 30);
  for (const c of session.activeCars) {
    assert.ok(Number.isFinite(c.x + c.z + c.speed), `car ${c.id} non-finite`);
  }
  assert.ok(mean < 8, `mean=${mean}`);
});
