// MuseSpark independent safety supervisor — separate from pace/tactics.
// Intervenes ONLY for imminent severe collision, track departure, unstable
// rejoin, unrecoverable loss of control. Every activation is logged.
import { clamp } from '../sim/math.js';

export class SafetySupervisor {
  constructor(track) {
    this.track = track;
    this.activations = 0;
    this.log = [];
    this.reason = 'CLEAR';
    this.emergency = false;
    this.maxSpeed = 90;
    this.counts = this.counts ?? {};
  }
  update(car, cars, current, dt, t) {
    this.emergency = false;
    this.maxSpeed = 90;
    this.reason = 'CLEAR';
    // 1) Imminent severe collision: TTC + closing + overlap geometry.
    // LAST-RESORT only: cap when time-to-contact < 1.0s, emergency < 0.6s.
    // Train-following (TTC of seconds) is planning's job, never the supervisor's.
    for (const o of cars) {
      if (o === car) continue;
      const dx = o.x - car.x, dz = o.z - car.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 22) continue;
      const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
      const closing = (car.vx - o.vx) * (dx / Math.max(0.5, dist)) * -1 + (car.vz - o.vz) * (dz / Math.max(0.5, dist)) * -1;
      const ahead = (dx * fx + dz * fz) > 0;
      const ttc = closing > 0.5 ? (dist - 4.4) / closing : Infinity; // car lengths ~4.4m
      // T-bone / deep overlap: lateral small + closing high + very close.
      if (ahead && dist < 9 && closing > 3.5 && ttc < 1.0) {
        this.emergency = closing > 7 && dist < 6 && ttc < 0.6;
        this.maxSpeed = Math.min(this.maxSpeed, Math.max(4, o.speed - 2));
        this.reason = 'TRAFFIC_CONFLICT';
        if (this.emergency) { this.reason = 'CONTACT_AVOIDANCE'; break; }
      }
      // Side overlap (door-to-door is TOLERATED — no intervention, no cap).
      if (dist < 3.4 && Math.abs(closing) < 6) {
        // shallow rub: tolerated, supervisor stays CLEAR.
      }
    }
    // 2) Track departure.
    const edge = this.track.halfWidth;
    if (Math.abs(current.lateral) > edge + 1.2) {
      this.maxSpeed = Math.min(this.maxSpeed, 11);
      if (this.reason === 'CLEAR') this.reason = 'TRACK_LIMIT_AVOIDANCE';
    }
    // 3) Loss of control: body slip / yaw rate extreme.
    const slip = Math.atan2(car.v, Math.max(4, Math.abs(car.u)));
    if (Math.abs(slip) > 0.28 || Math.abs(car.yawRate) > 2.2) {
      this.maxSpeed = Math.min(this.maxSpeed, car.speed * 0.82);
      if (this.reason === 'CLEAR') this.reason = 'RECOVERY';
    }
    if (this.reason !== 'CLEAR' || this.emergency) {
      this.activations++;
      this.counts[this.reason] = (this.counts[this.reason] ?? 0) + 1;
      if (this.log.length < 400) this.log.push({ t, reason: this.reason, emergency: this.emergency, s: current.s, speed: car.speed });
    }
    return { maxSpeed: this.maxSpeed, emergency: this.emergency, reason: this.reason };
  }
}
