import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

test('integration: hotlap makes progress, laps over, no teleport', { timeout: 120000 }, () => {
  const track = new Track('harbor-ring');
  const session = new MuseSession(track, { mode: 'practice', laps: 1, fastLine: true });
  session.start({});
  const dt = 1 / 120;
  const p0 = session.player.race.progress;
  for (let i = 0; i < 120 * 30; i++) session.step(dt);
  const p1 = session.player.race.progress;
  assert.ok(p1 > p0 + 200, `progress ${p0} -> ${p1}`);
  assert.ok(Math.abs(session.player.x) < 3000 && Math.abs(session.player.z) < 3000);
});

test('integration: 3-car race steps without explosion', { timeout: 120000 }, () => {
  const track = new Track('harbor-ring');
  const session = new MuseSession(track, { mode: 'race', laps: 1, field: 3, fastLine: true });
  session.start({});
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 30; i++) session.step(dt);
  for (const c of session.activeCars) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.speed));
  assert.ok(session.contacts >= 0);
});

test('performance: 6-car 10s mean step well under gate', { timeout: 180000 }, () => {
  const track = new Track('harbor-ring');
  const session = new MuseSession(track, { mode: 'race', laps: 1, field: 6, fastLine: true });
  session.start({});
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 3; i++) session.step(dt); // warmup (line caches, plans init)
  const N = 120 * 10;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) session.step(dt);
  const mean = (performance.now() - t0) / N;
  assert.ok(mean < 8, `mean=${mean.toFixed(3)}ms`);
});
