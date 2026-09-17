import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { optimizeGlobal } from '../src/muse/global-opt.js';

test('global optimum improves on centerline and respects bounds', () => {
  const track = new Track('harbor-ring');
  const env = createEnvelope(carSpecFor('gt'), { fuel: 20 });
  const sol = optimizeGlobal(track, env, { step: 6, widths: [120, 50], amplitudes: [2.0, 0.8], sweeps: 1 });
  // coarse search improves the coarse centerline reference ...
  assert.ok(sol.coarseLapTime < sol.initialSeconds, `${sol.coarseLapTime} vs ${sol.initialSeconds}`);
  // ... and the dense final word (runtime-exact grid + measured brake factor)
  // is a sane lap time, not fantasy.
  assert.ok(sol.lapTime > 50 && sol.lapTime < 120, `lap=${sol.lapTime}`);
  const limit = track.halfWidth - 1.5;
  for (const q of sol.offsets) assert.ok(Math.abs(q) <= limit + 1e-9, `q=${q}`);
  assert.ok(sol.accepted >= 0);
});
