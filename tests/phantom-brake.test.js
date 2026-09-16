import { test } from 'node:test';
import assert from 'node:assert/strict';
import { musePedals, brakeNeeded, planBrakeEvent } from '../src/muse/mpcc.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';

// ABSOLUTE REQUIREMENT: brake needs explicit causal reason.
test('PHANTOM BRAKE: clear straight, supervisor clear, no conflict, distant braking => BRAKE ZERO', () => {
  const env = createEnvelope(carSpecFor('gt'), {});
  // Small decel desire: must coast, never brake without cause.
  const coast = musePedals(-0.3, env, 55, 2, { allowed: false, source: 'NONE' });
  assert.equal(coast.brake, 0, `coast brake=${coast.brake}`);
  assert.ok(coast.throttle >= 0);
  // Even larger decel: without causal gate, still zero brake.
  const noCause = musePedals(-4, env, 55, 2, { allowed: false, source: 'NONE' });
  assert.equal(noCause.brake, 0, `phantom brake=${noCause.brake} source=${noCause.source}`);
  // With planned braking cause: brake allowed.
  const cause = musePedals(-4, env, 55, 2, { allowed: true, source: 'PLANNED_BRAKING', pressure: 0.7 });
  assert.ok(cause.brake > 0.2 && cause.source === 'PLANNED_BRAKING');
});

test('brake > 0.8 flagged only with cause on acceleration zone', () => {
  const env = createEnvelope(carSpecFor('gt'), {});
  // Simulate clear acceleration region: target above current (should be full throttle).
  const full = musePedals(3, env, 45, 3, { allowed: false, source: 'NONE' });
  assert.equal(full.throttle, 1);
  assert.equal(full.brake, 0);
});

test('spatial brake events are track-space intents carried through replans', () => {
  const ev = planBrakeEvent(1000, 60, 25, 1200, 5400);
  assert.ok(ev && ev.startS < ev.releaseS && ev.releaseS < ev.apexS);
  assert.equal(ev.source, 'PLANNED_BRAKING');
  const before = brakeNeeded(ev, 500, 60, 25);
  assert.equal(before.need, false);
  const inside = brakeNeeded(ev, (ev.startS + ev.releaseS) / 2, 55, 25);
  assert.equal(inside.need, true);
  const after = brakeNeeded(ev, ev.releaseS + 10, 25, 25);
  assert.equal(after.need, false);
});
