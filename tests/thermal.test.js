import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thermalMargin, observationFromGame } from '../src/muse/types.js';
import { Track } from '../src/sim/track.js';

test('thermalMargin: cool rubber full pace, hot/worn derates bounded', () => {
  assert.equal(thermalMargin(70, 0), 1);
  assert.equal(thermalMargin(85, 0), 1);
  const warm = thermalMargin(100, 0);
  assert.ok(warm < 1 && warm >= 0.85, `warm=${warm}`);
  const worn = thermalMargin(70, 0.5);
  assert.ok(worn < 1 && worn >= 0.85, `worn=${worn}`);
  const worst = thermalMargin(170, 1);
  assert.ok(worst >= 0.85 && worst < 1, `worst=${worst}`);
});

test('observation carries plant-agnostic thermal scalars', () => {
  const track = new Track('harbor-ring');
  const car = {
    id: 0, x: 0, z: 0, vx: 0, vz: 0, yaw: 0, yawRate: 0, u: 10, v: 0, speed: 10,
    steering: 0, controls: { throttle: 0, brake: 0 }, fuel: 20, damage: 0, s: 100, lateral: 0,
    wheels: [{ tyre: { core: 90, wear: 0.1 } }, { tyre: { core: 100, wear: 0.2 } }, { tyre: { core: 80, wear: 0 } }, { tyre: { core: 85, wear: 0 } }],
    race: { lap: 1 }
  };
  const obs = observationFromGame({ time: 0, dt: 1 / 120, car, track, cars: [car], line: null });
  assert.equal(obs.ego.tyreMax, 100);
  assert.equal(obs.ego.tyreWear, 0.2);
});
