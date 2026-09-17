// T-level accounting: T_GEOMETRIC (pure quasi-steady optimum) vs T_PROFILE
// (dense capability profile with measured derates). T_DYNAMIC (transient
// minimum-time through M_CONTROL) comes from tools/dynamic-feasibility.mjs —
// a derated quasi-steady number must NEVER be called transient-optimal.
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
console.log(`T_PROFILE   =${tra.lapTime.toFixed(3)}s (accepted=${tra.accepted} ms=${(performance.now() - t0).toFixed(0)})`);
console.log(`profile-vs-geometric = ${(tra.lapTime - geo.lapTime).toFixed(3)}s (derate cost, not controller gap)`);
