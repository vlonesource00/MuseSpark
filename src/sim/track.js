import { clamp, lerp, wrap } from './math.js';
import { HARBOR_RING } from './harbor-ring.js';

// Original 2.96 km circuit. Local +Z is forward; positive lateral is right.
const CONTROL = [
  [-380, -255], [0, -255], [325, -255], [460, -180],
  [475, -20], [370, 85], [245, 65], [195, -35],
  [95, -40], [40, 95], [140, 215], [30, 320],
  [-180, 300], [-360, 235], [-460, 100], [-435, -70]
];
const cubic = (a, b, c, d, t) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);

export class Track {
  constructor(scenario=null) {
    if(scenario==='harbor-ring')scenario=HARBOR_RING;
    this.scenario=scenario;this.id=scenario?.id??'solenne';
    this.name = scenario?.name??'Circuit Solenne';
    const control=scenario?scenario.controlPoints.map(p=>[p.x,p.z]):CONTROL;
    const steps=scenario?.sampleDensity??60;
    this.width = scenario?scenario.roadHalfWidth*2:13;
    this.halfWidth = this.width / 2;
    this.curbWidth=scenario?.curbWidth??1;this.runoffWidth=scenario?.runoffWidth??6.5;
    this.barrierOffset=scenario?this.halfWidth+this.curbWidth+this.runoffWidth+1:16;
    this.rubberLanes=13;this.laneWidth=this.width/this.rubberLanes;
    this.nodes = [];
    let s = 0;
    for (let i = 0; i < control.length; i++) {
      const a = control[wrap(i - 1, control.length)], b = control[i], c = control[(i + 1) % control.length], d = control[(i + 2) % control.length];
      for (let j = 0; j < steps; j++) {
        const t = j / steps;
        const x = cubic(a[0], b[0], c[0], d[0], t), z = cubic(a[1], b[1], c[1], d[1], t);
        const last = this.nodes.at(-1);
        if (last) s += Math.hypot(x - last.x, z - last.z);
        this.nodes.push({ x, z, y: 0, s });
      }
    }
    const end = this.nodes.at(-1), start = this.nodes[0];
    this.length = s + Math.hypot(end.x - start.x, end.z - start.z);
    this.finishS=scenario?scenario.start.finishFraction*this.length:90;
    this.gridS=scenario?scenario.start.gridFraction*this.length:90;
    this.nodes.forEach((p, i, nodes) => {
      const prev = nodes[wrap(i - 1, nodes.length)], next = nodes[(i + 1) % nodes.length];
      const d = Math.hypot(next.x - prev.x, next.z - prev.z);
      p.tx = (next.x - prev.x) / d; p.tz = (next.z - prev.z) / d;
      p.nx = p.tz; p.nz = -p.tx;
      const a = Math.atan2(p.x - prev.x, p.z - prev.z), b = Math.atan2(next.x - p.x, next.z - p.z);
      p.curvature = Math.atan2(Math.sin(b - a), Math.cos(b - a)) / (d * 0.5);
      p.heading = Math.atan2(p.tx, p.tz);
    });
    this.rubber = new Float32Array(this.nodes.length * 13);
    this.wetness = 0;
    this.temperature = 31;
    this.grid = new Map();
    this.nodes.forEach((n, i) => { const k = this.key(n.x, n.z); if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(i); });
  }
  key(x, z) { return `${Math.floor(x / 30)},${Math.floor(z / 30)}`; }
  at(s, offset = 0) {
    s = wrap(s, this.length);
    let lo = 0, hi = this.nodes.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.nodes[mid].s <= s) lo = mid; else hi = mid - 1; }
    const a = this.nodes[lo], b = this.nodes[(lo + 1) % this.nodes.length];
    const ds = (lo === this.nodes.length - 1 ? this.length : b.s) - a.s;
    const t = clamp((s - a.s) / ds, 0, 1);
    const tx = lerp(a.tx, b.tx, t), tz = lerp(a.tz, b.tz, t), mag = Math.hypot(tx, tz);
    const nx = tz / mag, nz = -tx / mag;
    return { x: lerp(a.x, b.x, t) + nx * offset, z: lerp(a.z, b.z, t) + nz * offset, y: 0, tx: tx / mag, tz: tz / mag, nx, nz, heading: Math.atan2(tx, tz), curvature: lerp(a.curvature, b.curvature, t), s, index: lo };
  }
  nearest(x, z) {
    const gx = Math.floor(x / 30), gz = Math.floor(z / 30);
    let best = Infinity, index = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of this.grid.get(`${gx + dx},${gz + dz}`) || []) {
        const p = this.nodes[i], d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) { best = d; index = i; }
      }
    }
    if (best === Infinity) this.nodes.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < best) { best = d; index = i; } });
    const n = this.nodes[index];
    const along = (x - n.x) * n.tx + (z - n.z) * n.tz;
    const p = this.at(n.s + along);
    p.lateral = (x - p.x) * p.nx + (z - p.z) * p.nz;
    return p;
  }
  surface(x, z) {
    const p = this.nearest(x, z), l = Math.abs(p.lateral);
    const lane = this.laneAt(p.lateral);
    const rubber = this.rubber[p.index * 13 + lane];
    const zone = this.zoneAt(l);
    const base = { asphalt: 1, kerb: 0.88, gravel: 0.52, grass: 0.42 }[zone];
    return { ...p, zone, rubber, grip: base * (1 + rubber * 0.10) * (1 - this.wetness * (0.36 + rubber * 0.2)), bump: zone === 'kerb' ? 0.028 + Math.sin(p.s * 4) * 0.012 : 0, resistance: zone === 'gravel' ? 0.09 : zone === 'grass' ? 0.06 : 0.013 };
  }
  deposit(surface, slipEnergy, load, dt) {
    if (surface.zone !== 'asphalt' || load < 10) return;
    const lane = this.laneAt(surface.lateral), index = surface.index * 13 + lane;
    this.rubber[index] = clamp(this.rubber[index] + dt * (0.0005 + Math.min(slipEnergy, 30000) * 0.0000001), 0, 1);
  }
  laneAt(lateral){return clamp(Math.floor((lateral+this.halfWidth)/this.laneWidth),0,12);}
  zoneAt(lateral){const l=Math.abs(lateral);return l<this.halfWidth?'asphalt':l<this.halfWidth+this.curbWidth?'kerb':l<this.halfWidth+this.curbWidth+this.runoffWidth-1?'gravel':'grass';}
}
