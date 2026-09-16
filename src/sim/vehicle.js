import { clamp, damp, angle } from './math.js';
import { createTyre, tyreForce } from './tyre.js';
import { CAR_CLASSES, carSpecFor } from './car-specs.js';

export const SPEC = CAR_CLASSES.gt;

export class Vehicle {
  constructor(id = 0, name = 'YOU', color = '#df482d', classId = 'gt') {
    this.spec=carSpecFor(classId);this.classId=this.spec.key;
    this.id = id; this.name = name; this.color = color;
    this.setup = { wing: 6, brakeBias: this.spec.brakeBias, tc: 3, abs: 4, pressure: 1.65, fuel: 35 };
    this.automatic = true;
    this.resetState();
  }
  resetState() {
    const SPEC=this.spec;
    this.x = 0; this.z = 0; this.y = 0; this.yaw = 0;
    this.vx = 0; this.vz = 0; this.u = 0; this.v = 0; this.speed = 0; this.yawRate = 0;
    this.ax = 0; this.ay = 0; this.roll = 0; this.pitch = 0; this.heave = 0;
    this.steering = 0; this.gear = 1; this.rpm = 1100; this.shiftTimer = 0;
    this.controls = { throttle: 0, brake: 0, steer: 0 };
    this.fuel = this.setup.fuel; this.damage = 0; this.aero = { downforce: 0, drag: 0, wake: 0 };
    this.wheels = [-1, 1, -1, 1].map((side, i) => ({ x: side * SPEC.track / 2, z: (i < 2 ? (1 - SPEC.frontWeight) : -SPEC.frontWeight) * SPEC.wheelbase, omega: 0, steer: 0, compression: 0.045, load: 0, brakeTemp: 180, tyre: createTyre(this.setup.pressure) }));
    this.s = 0; this.lateral = 0; this.zone = 'asphalt'; this.impact = 0; this.absActive = false; this.tcActive = false;
  }
  place(track, s, lateral = 0, speed = 0) {
    const SPEC=this.spec;
    this.resetState();
    const p = track.at(s, lateral);
    this.x = p.x; this.z = p.z; this.yaw = p.heading; this.s = p.s; this.lateral = lateral;
    this.vx = p.tx * speed; this.vz = p.tz * speed; this.u = speed; this.speed = speed;
    this.wheels.forEach(w => { w.omega = speed / SPEC.radius; });
  }
  shift(direction) {
    const SPEC=this.spec;
    if (this.shiftTimer > 0) return;
    const next = clamp(this.gear + direction, 1, 6);
    const rpm = Math.abs(this.u) / SPEC.radius * SPEC.gears[next] * SPEC.finalDrive * 60 / (2 * Math.PI);
    if (rpm > 8100 || next === this.gear) return;
    this.gear = next; this.shiftTimer = 0.11;
  }
  step(dt, track, wake = 0) {
    const SPEC=this.spec;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    this.u = this.vx * s + this.vz * c; this.v = this.vx * c - this.vz * s;
    this.speed = Math.hypot(this.u, this.v);
    this.steering = damp(this.steering, clamp(this.controls.steer, -1, 1) * SPEC.steeringLock, 12, dt);
    let throttle = this.fuel > 0 ? clamp(this.controls.throttle, 0, 1) : 0;
    const brake = clamp(this.controls.brake, 0, 1);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const ratio = SPEC.gears[this.gear] * SPEC.finalDrive;
    this.rpm = damp(this.rpm, clamp(Math.abs(this.u) / SPEC.radius * ratio * 9.5493, 1100 + throttle * 1500, 8300), 20, dt);
    if (this.automatic) { if (this.rpm > 7450) this.shift(1); else if (this.rpm < 3450 && this.gear > 1) this.shift(-1); }
    if (this.shiftTimer > 0 || this.rpm > 8100) throttle = 0;
    const mass = SPEC.mass + this.fuel * 0.75;
    const q = 0.5 * 1.225 * this.u * this.u;
    const ride = 0.066 - this.heave;
    const platform = clamp(1 - Math.abs(this.pitch) * 1.4 - Math.max(0, 0.03 - ride) * 14, 0.55, 1);
    this.aero.wake = clamp(wake, 0, 0.8);
    this.aero.downforce = q * SPEC.area * (SPEC.cl + (this.setup.wing - 6) * 0.11) * platform * (1 - wake * 0.32);
    this.aero.drag = q * SPEC.area * (SPEC.cd + (this.setup.wing - 6) * 0.013) * (1 - wake * 0.24) * (1 + this.damage * 0.2);
    const longitudinalTransfer = clamp(this.ax, -22, 18) * mass * SPEC.cg / SPEC.wheelbase;
    const lateralTransfer = clamp(this.ay, -25, 25) * mass * SPEC.cg / SPEC.track;
    const frontLoad = mass * 9.81 * SPEC.frontWeight - longitudinalTransfer + this.aero.downforce * SPEC.frontAero;
    const rearLoad = mass * 9.81 * (1 - SPEC.frontWeight) + longitudinalTransfer + this.aero.downforce * (SPEC.key==='gt'?.57:1-SPEC.frontAero);
    const centerSurface = track.surface(this.x, this.z);
    this.s = centerSurface.s; this.lateral = centerSurface.lateral; this.zone = centerSurface.zone;
    let fx = 0, fz = -this.aero.drag * Math.sign(this.u), moment = -this.yawRate * 130;
    const torqueCurve = clamp(1 - ((this.rpm - 5500) / 6700) ** 2, 0.45, 1);
    const reversing = Boolean(this.controls.reverse);
    const drive = (reversing ? -1 : 1) * throttle * SPEC.maxTorque * torqueCurve * ratio * 0.91 * (1 - this.damage * 0.28);
    const drivenStart=SPEC.drive==='front'?0:2;
    const rearSlip = Math.max(this.wheels[drivenStart].tyre.kappa, this.wheels[drivenStart+1].tyre.kappa);
    const tc = this.setup.tc > 0 && !reversing ? clamp(1 - Math.max(0, rearSlip - (0.14 - this.setup.tc * 0.009)) * this.setup.tc * 0.7, 0.18, 1) : 1;
    this.tcActive = tc < 0.92; this.absActive = false;
    this.wheels.forEach((w, i) => {
      const front = i < 2;
      // Ackermann follows the turn centre; outside wheel uses less lock.
      w.steer = front && Math.abs(this.steering) > 0.0001 ? Math.atan(SPEC.wheelbase / (SPEC.wheelbase / Math.tan(this.steering) - w.x)) : 0;
      const wx = this.x + w.x * c + w.z * s, wz = this.z - w.x * s + w.z * c;
      const surface = track.surface(wx, wz);
      const targetLoad = Math.max(0, (front ? frontLoad : rearLoad) / 2 - Math.sign(w.x) * lateralTransfer * (front ? 0.52 : 0.48));
      const spring = front ? SPEC.springFront : SPEC.springRear;
      const targetCompression = clamp(targetLoad / spring + surface.bump * 0.3, 0, 0.12);
      w.compression = damp(w.compression, targetCompression, 24, dt);
      w.load = Math.max(0, targetLoad + (targetCompression - w.compression) * 16000);
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      const localVx = this.v + this.yawRate * w.z, localVz = this.u - this.yawRate * w.x;
      const tyreVx = localVz * cs + localVx * sn, tyreVy = localVx * cs - localVz * sn;
      const abs = this.setup.abs > 0 && this.speed > 3 ? clamp(1 + Math.min(0, w.tyre.kappa + 0.13) * (4 + this.setup.abs), 0.06, 1) : 1;
      this.absActive ||= abs < 0.8;
      const brakeTorque = brake * SPEC.brakeTorque * (front ? this.setup.brakeBias : 1 - this.setup.brakeBias) * abs;
      const driven=front===(SPEC.drive==='front');
      const diff = driven ? clamp((this.wheels[i^1].omega - w.omega) * 12, -130, 130) : 0;
      const wheelDrive = driven ? drive * tc * 0.5 + diff - (throttle < 0.02 ? Math.sign(this.u) * 22 * ratio : 0) : 0;
      let avgFx = 0, avgFy = 0;
      // Wheel rotation and relaxation solve at 480 Hz, chassis at 120 Hz.
      for (let sub = 0; sub < 4; sub++) {
        const h = dt / 4;
        tyreForce(w.tyre, { vx: tyreVx, vy: tyreVy, omega: w.omega, radius: SPEC.radius, load: w.load, grip: surface.grip*SPEC.tyreGrip, ambient: 24 }, h);
        const unbraked = w.omega + (wheelDrive - w.tyre.fx * SPEC.radius) / SPEC.wheelInertia * h;
        const brakeStep = brakeTorque / SPEC.wheelInertia * h;
        w.omega = Math.sign(unbraked) * Math.max(0, Math.abs(unbraked) - brakeStep);
        w.omega = clamp(w.omega, -300, 520);
        avgFx += w.tyre.fx / 4; avgFy += w.tyre.fy / 4;
      }
      const forceX = avgFy * cs + avgFx * sn, forceZ = avgFx * cs - avgFy * sn;
      fx += forceX; fz += forceZ - surface.resistance * w.load * Math.tanh(this.u * 2);
      moment += forceX * w.z - forceZ * w.x;
      w.brakeTemp = clamp(w.brakeTemp + (brakeTorque * Math.abs(w.omega) * 0.00009 - (w.brakeTemp - 24) * (0.02 + this.speed * 0.0007)) * dt, 24, 1000);
      track.deposit(surface, w.tyre.slipPower, w.load, dt);
    });
    this.ax = damp(this.ax, fz / mass, 16, dt); this.ay = damp(this.ay, fx / mass, 16, dt);
    this.vx += (fx * c + fz * s) / mass * dt;
    this.vz += (-fx * s + fz * c) / mass * dt;
    this.yawRate = clamp(this.yawRate + moment / SPEC.yawInertia * dt, -3, 3);
    if (this.speed < 0.6 && throttle < 0.02) { this.vx *= Math.exp(-15 * dt); this.vz *= Math.exp(-15 * dt); this.yawRate *= Math.exp(-15 * dt); }
    this.yaw = angle(this.yaw + this.yawRate * dt);
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.roll = damp(this.roll, clamp(this.ay * 0.0035, -0.09, 0.09), 8, dt);
    this.pitch = damp(this.pitch, clamp(-this.ax * 0.0028, -0.06, 0.07), 9, dt);
    this.heave = damp(this.heave, this.aero.downforce / 310000, 10, dt);
    this.fuel = Math.max(0, this.fuel - (0.0007 + throttle * this.rpm / 7500 * 0.0045) * dt);
    this.impact *= Math.exp(-4 * dt);
    const barrier=track.barrierOffset??16;
    if (Math.abs(centerSurface.lateral) > barrier) {
      const side = Math.sign(centerSurface.lateral), out = (this.vx * centerSurface.nx + this.vz * centerSurface.nz) * side;
      const penetration = Math.abs(centerSurface.lateral) - barrier;
      this.x -= centerSurface.nx * side * penetration; this.z -= centerSurface.nz * side * penetration;
      if (out > 0) { this.vx -= centerSurface.nx * side * out * 1.1; this.vz -= centerSurface.nz * side * out * 1.1; this.damage = clamp(this.damage + out * 0.005, 0, 1); this.impact = clamp(out / 15, 0, 1); }
    }
  }
}

export function wakes(cars) {
  return cars.map(car => {
    let wake = 0;
    for (const other of cars) {
      if (other === car) continue;
      const dx = car.x - other.x, dz = car.z - other.z;
      const behind = -(dx * Math.sin(other.yaw) + dz * Math.cos(other.yaw));
      const lateral = Math.abs(dx * Math.cos(other.yaw) - dz * Math.sin(other.yaw));
      if (behind > 2 && behind < 75) wake = Math.max(wake, Math.exp(-behind / 40) * clamp(1 - lateral / (1.4 + behind * 0.035), 0, 1));
    }
    return wake;
  });
}

// OBB separating-axis collisions, mass-weighted impulses and yaw response.
export function collisions(cars, diagnostics = null) {
  let count = 0;
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j], dx = b.x - a.x, dz = b.z - a.z;
    if (dx * dx + dz * dz > 28) continue;
    const ar = [Math.cos(a.yaw), -Math.sin(a.yaw)], af = [Math.sin(a.yaw), Math.cos(a.yaw)];
    const br = [Math.cos(b.yaw), -Math.sin(b.yaw)], bf = [Math.sin(b.yaw), Math.cos(b.yaw)];
    let depth = Infinity, normal = null;
    for (const axis of [ar, af, br, bf]) {
      const dot = v => Math.abs(axis[0] * v[0] + axis[1] * v[1]);
      const overlap = 0.98 * (dot(ar) + dot(br)) + 2.28 * (dot(af) + dot(bf)) - Math.abs(dx * axis[0] + dz * axis[1]);
      if (overlap <= 0) { normal = null; break; }
      if (overlap < depth) { depth = overlap; const sign = Math.sign(dx * axis[0] + dz * axis[1]) || 1; normal = [axis[0] * sign, axis[1] * sign]; }
    }
    if (!normal) continue;
    const [nx, nz] = normal;
    // Collision effective masses use dry class mass; fuel remains part of
    // chassis/load-transfer dynamics. Preserve the equal-class impulse path.
    const ma=a.spec.mass,mb=b.spec.mass;
    const shareA=mb/(ma+mb),shareB=ma/(ma+mb);
    a.x -= nx * depth * shareA; a.z -= nz * depth * shareA; b.x += nx * depth * shareB; b.z += nz * depth * shareB;
    const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
    if (closing > 0) {
      if(diagnostics){
        diagnostics.peakClosing=Math.max(diagnostics.peakClosing||0,closing);
        diagnostics.severeContacts=(diagnostics.severeContacts||0)+Number(closing>6);
      }
      const impulse = closing * 1.1/(1/ma+1/mb);
      const deltaA=ma===mb?closing*.55:impulse/ma,deltaB=ma===mb?closing*.55:impulse/mb;
      a.vx -= nx * deltaA; a.vz -= nz * deltaA; b.vx += nx * deltaB; b.vz += nz * deltaB;
      a.damage = clamp(a.damage + closing * 0.003, 0, 1); b.damage = clamp(b.damage + closing * 0.003, 0, 1);
      a.impact = b.impact = clamp(closing / 12, 0, 1);
      count++;
    }
  }
  return count;
}
