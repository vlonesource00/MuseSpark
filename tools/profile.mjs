// Perf profile: 1/3/6/8-car step cost, debugger on/off proxy (telemetry load).
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

for (const field of [1, 3, 6, 8]) {
  const track = new Track('harbor-ring');
  const session = new MuseSession(track, { mode: field === 1 ? 'practice' : 'race', laps: 1, field, fastLine: true });
  session.start({});
  const dt = 1 / 120;
  const N = 120 * 20;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) session.step(dt);
  const ms = performance.now() - t0;
  console.log(`field=${field} total=${ms.toFixed(0)}ms perStep=${(ms / N).toFixed(3)}ms simRate=${((N * dt) / (ms / 1000)).toFixed(1)}x`);
}
