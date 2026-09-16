// MuseSpark telemetry — sufficient-resolution record + delta-time analysis.
// Same trace format for human and AI (SAVE BEST / SAVE LAST).
export class Telemetry {
  constructor() {
    this.samples = [];
    this.max = 12000;
    this.lapStart = 0;
    this.lastLap = null;
    this.bestLap = null;
    this.current = { s: 0, start: 0 };
  }
  record(row) {
    this.samples.push(row);
    if (this.samples.length > this.max) this.samples.shift();
  }
  lapBoundary(t, lapNo, valid, seconds) {
    const lap = { lapNo, valid, seconds, t };
    this.lastLap = lap;
    if (valid && (!this.bestLap || seconds < this.bestLap.seconds)) this.bestLap = lap;
    return lap;
  }
  export(which = 'best') {
    const lap = which === 'best' ? this.bestLap : this.lastLap;
    if (!lap) return null;
    return { driver: 'MUSE', ...lap, samples: this.samples.length };
  }
}

// Delta analysis every ~5m vs reference speeds: classify loss.
export function deltaAnalysis(track, lineSpeedAt, actualSamples) {
  // actualSamples: [{s, speed, throttle, brake, q}]
  const rows = [];
  let cum = 0;
  for (let s = 0; s < track.length; s += 5) {
    const ref = lineSpeedAt(s);
    const near = actualSamples.filter((a) => Math.abs(((a.s - s + track.length / 2) % track.length) - track.length / 2) < 4);
    if (!near.length) continue;
    const act = near.reduce((x, a) => x + a.speed, 0) / near.length;
    const dt = 5 / Math.max(4, act) - 5 / Math.max(4, ref);
    cum += dt;
    const q = near.reduce((x, a) => x + a.q, 0) / near.length;
    const braking = near.some((a) => a.brake > 0.2);
    let cls = 'STRAIGHT';
    if (Math.abs(q) > 3) cls = 'LINE';
    else if (braking && act < ref - 1.5) cls = 'BRAKING';
    else if (act < ref - 1.5 && ref < 30) cls = 'MID-CORNER';
    else if (act < ref - 1) cls = 'EXIT';
    else if (act < ref - 0.4) cls = 'CONTROL';
    rows.push({ s, dt, cum, ref, act, q, cls });
  }
  return rows;
}
