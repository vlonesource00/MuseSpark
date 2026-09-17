// T_DYNAMIC (model-ideal tracking): can M_CONTROL execute the dense profile?
// Forward-simulates the IDENTIFIED model tracking line geometry at profile
// speed with an ideal preview controller (pure pursuit + P-force). If the
// model — validated to 0.06m@0.5s — tracks within ~1s of T_PROFILE with small
// violations, the profile is dynamically feasible and the remaining gap is
// controller/plant-mismatch, not planning fantasy. Cheap (one forward sim);
// the plant gap is bounded separately by RMSE (tests/model.test.js).
// This is NOT a full-lap trajectory optimum (that needs a joint solver —
// tracked future work); it is a feasibility upper bound, labelled honestly.
// Skill sweep: derated profiles locate the model's clean feasible frontier.
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { createVehicleModel } from '../src/muse/vehicle-model.js';
import { buildLine } from '../src/game/session.js';
import { clamp } from '../src/sim/math.js';

const SKILL = Number(process.argv.find((a) => a.startsWith('--skill='))?.slice(8) ?? 0.995);

const track = new Track('harbor-ring');
const spec = carSpecFor('gt');
const envelope = createEnvelope(spec, { fuel: 20 });
const { line } = buildLine(track, 'gt', true);
const model = createVehicleModel(spec, envelope);
const L = track.length;
const h = 1 / 60;
let s = { x: 0, z: 0, yaw: 0, vx: 0, vy: 0, r: 0, delta: 0, F: 0, axPrev: 0 };
{
  const p0 = track.at(10, line.offsetAt(10));
  s.x = p0.x; s.z = p0.z; s.yaw = p0.heading;
  s.vx = 20; s.vy = 0; s.r = 0; s.delta = 0;
}
let t = 0, progress = 10, prevS = 10, laps = 0, lapStart = 0, best = Infinity;
let maxLat = 0, maxUtil = 0, viol = 0, maxBeta = 0;
const lapTimes = [];
const muScale = 1;
while (laps < 3 && t < 400) {
  // reference: line pose + profile speed ahead
  const ahead = progress + Math.max(6, s.vx * 0.4);
  const rp = track.at(ahead, line.offsetAt(ahead));
  const dx = rp.x - s.x, dz = rp.z - s.z;
  const lx = dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw);
  const dist2 = dx * dx + dz * dz;
  const beta = Math.atan2(s.vy, Math.max(4, Math.abs(s.vx)));
  const pursuit = Math.atan2(2 * spec.wheelbase * lx, Math.max(5, dist2)) + beta * 0.4;
  const vRef = line.speedAt(ahead) * SKILL;
  const v = Math.max(0, s.vx);
  const lim = model.forceLimits(Math.max(5, v), s.ax ?? 0, 0);
  let F = clamp((vRef - v) * 1305 * 1.5, -lim.brakeMax, lim.driveMax);
  s = model.step(s, { deltaCmd: clamp(pursuit, -0.48, 0.48), F }, h, muScale);
  maxLat = Math.max(maxLat, Math.abs((s.x - rp.x) * rp.nx + (s.z - rp.z) * rp.nz));
  maxUtil = Math.max(maxUtil, s.utilR ?? 0, s.utilF ?? 0);
  if ((s.utilR ?? 0) > 1 || (s.utilF ?? 0) > 1) viol++;
  maxBeta = Math.max(maxBeta, Math.abs(beta));
  // progress via true nearest-station projection (dead reckoning diverges
  // once lateral error grows and poisons the reference).
  const proj = track.nearest(s.x, s.z);
  if (prevS > L - 200 && proj.s < 200) {
    laps++;
    const lt = t - lapStart;
    lapStart = t;
    lapTimes.push(lt);
    if (lt < best) best = lt;
  }
  progress = proj.s;
  prevS = proj.s;
  t += h;
}
console.log(`T_DYNAMIC(model-ideal)=${best.toFixed(3)}s laps=[${lapTimes.map((x) => x.toFixed(2)).join(', ')}]`);
console.log(`maxLat=${maxLat.toFixed(2)}m maxUtil=${maxUtil.toFixed(2)} violSteps=${viol} maxBeta=${maxBeta.toFixed(2)}`);
console.log(`(model RMSE bounds: 0.06m@0.5s lateral; plant gap bounded separately)`);
