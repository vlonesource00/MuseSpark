import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';

test('envelope is physically grounded: positive, aero-sensitive, combined-slip', () => {
  const spec = carSpecFor('gt');
  const env = createEnvelope(spec, { fuel: 20 });
  const lat20 = env.lateral(20), lat60 = env.lateral(60);
  assert.ok(lat20 > 8 && lat20 < 30, `lat20=${lat20}`);
  assert.ok(lat60 > lat20, `aero should raise lateral with speed: ${lat20} -> ${lat60}`);
  assert.ok(env.drive(20) > 2 && env.drive(20) < 20);
  assert.ok(env.brake(40) > 8, `brake=${env.brake(40)}`);
  const c = env.combined(40, 8, 'drive');
  assert.ok(c.longitudinal < env.drive(40) && c.longitudinal > 0);
  // Throttle physics: at moderate lateral, full engine request still legal.
  const gate = env.throttleLegal(40, 4);
  assert.equal(typeof gate.legal, 'boolean');
  assert.ok(gate.remaining > 0 && gate.request > 0);
});

test('engine force uses best gear and never grants magic power', () => {
  const spec = carSpecFor('gt');
  const env = createEnvelope(spec, {});
  const f = env.engineForceAt(30, 0);
  assert.ok(f > 2000 && f < 30000, `F=${f}`);
});
