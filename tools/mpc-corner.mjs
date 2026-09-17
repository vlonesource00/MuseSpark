// MPC corner sandbox: 12s hairpin entry, 0.1s logging. Fast weight iteration.
import { Track } from '../src/sim/track.js';
import { MuseSession } from '../src/game/session.js';

const track = new Track('harbor-ring');
const session = new MuseSession(track, { mode: 'practice', laps: 1, fastLine: true, driverMode: 'QUALIFYING', controller: 'mpc' });
session.start({});
// fast-forward past countdown
for (let i = 0; i < 250; i++) session.step(1 / 120);
const c = session.player;
c.place(track, 590, 0, 55);
c.race.previousS = c.s;
// Respin the gearbox to match road speed (place() resets to gear 1; the
// automatic would refuse every upshift as over-rev and pin the limiter).
{
  const u = 55;
  let g = 1;
  for (; g <= 6; g++) {
    const r = (u / c.spec.radius) * c.spec.gears[g] * c.spec.finalDrive * 9.5493;
    if (r <= 7450) break;
  }
  c.gear = Math.min(6, Math.max(1, g));
  c.rpm = (u / c.spec.radius) * c.spec.gears[c.gear] * c.spec.finalDrive * 9.5493;
}
const d = session.drivers[0];
d.mpc.U = null; d.mpc.lastU0 = null;
console.log('t s v tgt thr brk steer slip utilR eLat U0F U0d iters cost');
for (let i = 0; i < 3000; i++) {
  session.step(1 / 120);
  if (session.phase !== 'racing') continue;
  if (i % 12 !== 0) continue;
  const w = d.debug?.winner;
  let eLat = NaN;
  if (w?.points?.length) {
    let bd = 1e9, bq = 0;
    for (const p of w.points) {
      const dd = Math.abs(((p.s - c.s) % track.length + track.length) % track.length);
      const d2 = Math.min(dd, track.length - dd);
      if (d2 < bd) { bd = d2; bq = p.offset; }
    }
    eLat = c.lateral - bq;
  }
  const slip = Math.atan2(c.v, Math.max(4, Math.abs(c.u)));
  console.log(`${(i / 120).toFixed(1)} ${c.s.toFixed(0)} ${c.speed.toFixed(1)} ${d.targetSpeed.toFixed(1)} ${c.controls.throttle.toFixed(2)} ${c.controls.brake.toFixed(2)} ${c.controls.steer.toFixed(2)} ${slip.toFixed(2)} ${(c.wheels[2].tyre.utilisation ?? 0).toFixed(2)} ${eLat.toFixed(1)} ${(d.mpc.U?.[0]?.F ?? NaN).toFixed(0)} ${(d.mpc.U?.[0]?.deltaCmd ?? NaN).toFixed(3)} ${d.debug.mpc?.iters ?? '-'} ${(d.debug.mpc?.cost ?? NaN).toFixed(0)}`);
  if (Math.abs(c.lateral) > track.halfWidth + 2 || Math.abs(slip) > 0.5) { console.log('OFF/SPIN — stop'); break; }
}
