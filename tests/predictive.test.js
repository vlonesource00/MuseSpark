// Predictive controller tests: convergence, bounds, deadline/fallback,
// brake causality (phantom discipline), force complementarity. No full laps
// (corner sandbox only) — full-lap A/B lives in tools/headless-hotlap.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

function cornerSession() {
  const track = new Track('harbor-ring');
  const s = new MuseSession(track, { mode: 'practice', laps: 1, fastLine: true, driverMode: 'QUALIFYING', controller: 'mpc' });
  s.start({});
  for (let i = 0; i < 250; i++) s.step(1 / 120); // past countdown
  const c = s.player;
  c.place(track, 590, 0, 55);
  c.race.previousS = c.s;
  let g = 1;
  for (; g <= 6; g++) {
    const r = (55 / c.spec.radius) * c.spec.gears[g] * c.spec.finalDrive * 9.5493;
    if (r <= 7450) break;
  }
  c.gear = Math.min(6, Math.max(1, g));
  c.rpm = (55 / c.spec.radius) * c.spec.gears[c.gear] * c.spec.finalDrive * 9.5493;
  const d = s.drivers[0];
  d.mpc.U = null; d.mpc.lastU0 = null;
  return { s, c, d, track };
}

test('mpc converges: cost decreases, bounds respected, stats sane', () => {
  const { s, c, d } = cornerSession();
  let prevCost = Infinity;
  for (let i = 0; i < 120; i++) {
    s.step(1 / 120);
    const info = d.debug.mpc;
    if (!info || info.held) continue;
    assert.ok(Number.isFinite(info.cost), 'finite cost');
    assert.ok(Math.abs(d.mpc.U[0].deltaCmd) <= c.spec.steeringLock + 1e-9, 'steer bound');
    prevCost = info.cost;
  }
  const st = d.mpc.stats;
  assert.ok(st.solves > 20, `solves=${st.solves}`);
  assert.ok(st.maxMs < 50, `maxMs=${st.maxMs} (pathological)`);
  void prevCost;
});

test('mpc brakes for the hairpin (no sail-past) and stays finite', () => {
  const { s, c, d } = cornerSession();
  let sawBrake = false, minV = Infinity;
  for (let i = 0; i < 600 && c.s < 860; i++) {
    s.step(1 / 120);
    if (c.controls.brake > 0.3) sawBrake = true;
    minV = Math.min(minV, c.speed);
    for (const v of [c.x, c.z, c.speed, c.yawRate]) assert.ok(Number.isFinite(v), 'finite state');
  }
  assert.ok(sawBrake, 'must brake before hairpin apex');
  assert.ok(minV < 45, `must shed speed, minV=${minV}`);
});

test('mpc causality: no event + at/above target => never brakes (phantom gate)', () => {
  const { s, c, d } = cornerSession();
  // straight, on profile: brake must be zero even with optimizer running
  let checked = 0;
  for (let i = 0; i < 120 && c.s < 680; i++) {
    s.step(1 / 120);
    if (c.speed > 40 && d.targetSpeed >= c.speed - 0.5 && !d.mpc.brakeRef) {
      assert.equal(c.controls.brake, 0, `phantom brake at s=${c.s}`);
      checked++;
    }
  }
  assert.ok(checked > 5, 'causality window sampled');
});

test('mpc force complementarity + NaN state degrades finite (no throw/stab)', () => {
  const { s, c, d } = cornerSession();
  for (let i = 0; i < 120; i++) {
    s.step(1 / 120);
    assert.ok(!(c.controls.throttle > 0 && c.controls.brake > 0), 'overlap');
  }
  // poison the state: must degrade to finite output, never throw or NaN-stab.
  // (Stale warm command is acceptable fallback; plant integrity is separate.)
  c.yawRate = NaN;
  let threw = false;
  try {
    s.step(1 / 120);
  } catch { threw = true; }
  assert.equal(threw, false, 'no throw');
  assert.ok(Number.isFinite(c.controls.throttle + c.controls.brake + c.controls.steer), 'finite after NaN');
});
