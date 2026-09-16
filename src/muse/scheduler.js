// MuseSpark multi-rate scheduler — deliberate update frequencies + adaptive compute.
// PHYSICS/CONTROL/SAFETY 120Hz | MPCC 40Hz | TRAJECTORY 15Hz adaptive |
// OPPONENT 15Hz | STRATEGY 7Hz + events | GLOBAL offline cached.
export class Scheduler {
  constructor() {
    this.t = 0;
    this.next = { mpcc: 0, traj: 0, belief: 0, strategy: 0 };
    this.profile = {
      strategyMs: 0, trajMs: 0, mpcMs: 0, totalMs: 0,
      samples: 0, p95window: []
    };
    this.detail = 1;
    this.counts = { candidates: 0, finalists: 0 };
  }
  tick(dt) { this.t += dt; }
  // Adaptive compute: CLEAR cheap, SINGLE moderate, SIDE-BY-SIDE high, 3-WIDE max.
  adapt(rivals, ego, trackLength) {
    let near = 0, side = 0;
    for (const r of rivals) {
      if (r.id === ego.id) continue;
      const ds = Math.abs(((r.s - ego.s + trackLength * 1.5) % trackLength) - trackLength * 0.5);
      const dq = Math.abs(r.q - ego.q);
      if (ds < 80) near++;
      if (ds < 14 && dq < 3.2) side++;
    }
    this.detail = side >= 2 ? 2 : side === 1 ? 2 : near >= 2 ? 1 : 0;
    return this.detail;
  }
  due(kind) { return this.t >= this.next[kind]; }
  mark(kind, interval) { this.next[kind] = this.t + interval; }
  record(ms) {
    const p = this.profile;
    p.samples++;
    p.totalMs += (ms - p.totalMs) * (1 / Math.min(p.samples, 120));
    p.p95window.push(ms);
    if (p.p95window.length > 240) p.p95window.shift();
  }
  p95() {
    const w = [...this.profile.p95window].sort((a, b) => a - b);
    return w.length ? w[(w.length * 0.95) | 0] : 0;
  }
}
