// T-level accounting: T_GEOMETRIC (pure quasi-steady optimum) vs T_TRANSIENT
// (measured-capability plan: skill 0.97 headroom + brakeReal 0.9). The gap
// between them is planner optimism, NOT controller gap.
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { optimizeGlobal } from '../src/muse/global-opt.js';

const track = new Track('harbor-ring');
const spec = carSpecFor('gt');
const envelope = createEnvelope(spec, { fuel: 20 });
const OPTS = { step: 4, widths: [140, 70, 32], amplitudes: [2.2, 1.0, 0.4], sweeps: 1 };
let t0 = performance.now();
const geo = optimizeGlobal(track, envelope, { ...OPTS, skill: 1.0, brakeScale: 1.0 });
console.log(`T_GEOMETRIC =${geo.lapTime.toFixed(3)}s (accepted=${geo.accepted} ms=${(performance.now() - t0).toFixed(0)})`);
t0 = performance.now();
const tra = optimizeGlobal(track, envelope, OPTS);
console.log(`T_TRANSIENT =${tra.lapTime.toFixed(3)}s (accepted=${tra.accepted} ms=${(performance.now() - t0).toFixed(0)})`);
console.log(`planner optimism = ${(tra.lapTime - geo.lapTime).toFixed(3)}s`);
