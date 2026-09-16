// Line optimizer CLI: prints theoretical lap for current envelope.
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/muse/envelope.js';
import { optimizeGlobal } from '../src/muse/global-opt.js';

const track = new Track('harbor-ring');
const spec = carSpecFor('gt');
const envelope = createEnvelope(spec, { fuel: 20 });
const t0 = performance.now();
const sol = optimizeGlobal(track, envelope, { step: 4, widths: [140, 70, 32], amplitudes: [2.2, 1.0, 0.4], sweeps: 1 });
console.log(`initial=${sol.initialSeconds.toFixed(3)}s theoretical=${sol.lapTime.toFixed(3)}s accepted=${sol.accepted} ms=${(performance.now() - t0).toFixed(0)}`);
