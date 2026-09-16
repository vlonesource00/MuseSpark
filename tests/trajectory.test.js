import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { GlobalLine, optimizeGlobal } from '../src/muse/global-opt.js';
import { TrajectorySearch } from '../src/muse/trajectory.js';
import { BeliefBank } from '../src/muse/belief.js';

test('trajectory candidates are legal width and ranked with reasons', () => {
  const track = new Track('harbor-ring');
  const env = createEnvelope(carSpecFor('gt'), {});
  const sol = optimizeGlobal(track, env, { step: 6, widths: [120], amplitudes: [2.0], sweeps: 1 });
  const line = new GlobalLine(track, sol);
  const search = new TrajectorySearch(track, line, env);
  const beliefs = new BeliefBank(track.length);
  const res = search.search(100, 40, { type: 'OUTSIDE_MOMENTUM', flank: 'OUTSIDE', passP: 0.7 }, [], beliefs, { detail: 1 });
  assert.ok(res.winner.legal, res.winner.reason);
  assert.ok(res.finalists.length >= 2 && res.finalists.length <= 5);
  for (const p of res.winner.points) assert.ok(Math.abs(p.offset) <= track.halfWidth - 1.0 + 1e-9);
  assert.ok(Number.isFinite(res.winner.time) && res.winner.time > 0);
});
