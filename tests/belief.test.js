import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefBank } from '../src/muse/belief.js';

test('beliefs are probabilistic, sum to 1, body != uncertainty', () => {
  const bank = new BeliefBank(4000);
  const b = bank.get(1);
  // Rival defends inside repeatedly while ego closes.
  for (let i = 0; i < 60; i++) bank.update(i * 0.1, 0, [{ id: 0, s: 100, q: 0, speed: 40 }, { id: 1, s: 120, q: -2.6, speed: 38 }]);
  const sum = Object.values(b.posterior).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
  assert.ok(b.posterior.DEFEND_INSIDE > 0.18, `inside=${b.posterior.DEFEND_INSIDE}`);
  const pred = b.predict(120, -2.6, 38, 1.0, 'HOLD_LINE');
  assert.ok(pred.sigmaQ > 0.2 && pred.sigmaQ < 3, `sigmaQ=${pred.sigmaQ}`);
  // Body is NOT widened by uncertainty: prediction is a point + sigmas.
  assert.ok(Math.abs(pred.q - (-2.6)) < 2, `q=${pred.q}`);
});
