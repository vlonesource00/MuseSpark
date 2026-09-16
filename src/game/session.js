// MuseSpark session — Astra-derived race/session framework, Muse intelligence.
// Plant (Vehicle/wakes/collisions/Track) inherited verbatim from Astra;
// drivers are 100% MuseSpark (MuseDriver + GlobalLine + envelope).
import { Vehicle, wakes, collisions } from '../sim/vehicle.js';
import { wrap, clamp } from '../sim/math.js';
import { carSpecFor, CLASS_IDS } from '../sim/car-specs.js';
import { createEnvelope } from '../muse/envelope.js';
import { optimizeGlobal, GlobalLine } from '../muse/global-opt.js';
import { MuseDriver } from '../muse/driver.js';

const GRID = [['MUSE-01', '#e8482d'], ['RIVAL-02', '#d4dbd9'], ['RIVAL-03', '#356653'], ['RIVAL-04', '#d7a32e'], ['RIVAL-05', '#2e515f'], ['RIVAL-06', '#a0a399'], ['RIVAL-07', '#4058a0'], ['RIVAL-08', '#d5c6a8']];

export function buildLine(track, classId = 'gt', fast = false) {
  const spec = carSpecFor(classId);
  const envelope = createEnvelope(spec, { fuel: 20, wetness: track.wetness ?? 0 });
  const sol = optimizeGlobal(track, envelope, fast
    ? { widths: [120, 50], amplitudes: [2.0, 0.8], sweeps: 1, step: 5, skill: 1.0 }
    : { widths: [140, 70, 32], amplitudes: [2.2, 1.0, 0.4], sweeps: 1, step: 3, skill: 1.0 });
  return { line: new GlobalLine(track, sol), envelope, solution: sol, spec };
}

export class MuseSession {
  constructor(track, opts = {}) {
    this.track = track;
    this.classId = carSpecFor(opts.classId ?? 'gt').key;
    this.mixed = !!opts.mixed;
    this.mode = opts.mode ?? 'race'; // practice | race
    this.laps = opts.laps ?? 3;
    this.field = opts.field ?? 6;
    this.aggression = opts.aggression ?? 0.72;
    this.fastLine = !!opts.fastLine;
    const built = buildLine(track, this.classId, this.fastLine);
    this.line = built.line; this.envelope = built.envelope; this.solution = built.solution; this.spec = built.spec;
    this.theoreticalLap = built.line.theoreticalLap;
    this.cars = GRID.map(([name, color], id) => new Vehicle(id, name, color, this.mixed ? CLASS_IDS[(id + CLASS_IDS.indexOf(this.classId)) % CLASS_IDS.length] : this.classId));
    this.drivers = this.cars.map((c, i) => new MuseDriver(i, track, this.line, createEnvelope(c.spec, { fuel: 20 }), {
      skill: 0.955 + (i % 4) * 0.008, aggression: this.aggression, mode: opts.driverMode ?? 'SPRINT', spec: c.spec
    }));
    this.player = this.cars[0];
    this.phase = 'menu'; this.time = 0; this.countdown = 0; this.contacts = 0; this.autopilot = true;
    this.collisionStats = { peakClosing: 0, severeContacts: 0 };
    this.reset();
  }
  get activeCars() { return this.cars.slice(0, this.mode === 'practice' ? 1 : this.field); }
  reset() {
    this.time = 0; this.contacts = 0; this.results = null;
    this.collisionStats = { peakClosing: 0, severeContacts: 0 };
    this.cars.forEach((c, i) => {
      const start = this.track.scenario?.start, rowSpacing = start?.rowSpacingM ?? 9.5, lane = start?.laneOffsetM ?? 2.3;
      c.place(this.track, this.track.gridS - Math.floor(i / 2) * rowSpacing, i % 2 ? -lane : lane);
      const gridToFinish = wrap(this.track.finishS - this.track.gridS, this.track.length);
      c.race = { progress: -gridToFinish - Math.floor(i / 2) * rowSpacing, previousS: c.s, lap: 1, lastLap: null, bestLap: null, lapStart: 0, sector: 0, valid: true, sectors: [], finishTime: null, offtrack: 0 };
    });
    this.timingHistory = this.cars.map((c) => [{ progress: c.race.progress, time: 0 }]);
    this.nextTimingAt = 0;
  }
  start({ freshTrack = false } = {}) {
    if (freshTrack) this.track.rubber.fill(0);
    this.reset();
    this.phase = 'countdown'; this.countdown = 2;
  }
  step(dt, playerControls = null) {
    if (!['racing', 'countdown'].includes(this.phase)) return;
    if (this.phase === 'countdown') { this.countdown -= dt; if (this.countdown <= 0) this.phase = 'racing'; return; }
    this.time += dt;
    const cars = this.activeCars;
    const order = [...cars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress);
    const context = { order, totalLaps: this.laps, mode: this.mode, time: this.time };
    cars.forEach((c, i) => {
      if (i === 0 && !this.autopilot && playerControls) c.controls = playerControls;
      else this.drivers[i].update(c, cars, dt, context);
      if (c.race.finishTime !== null) c.controls = { ...c.controls, throttle: Math.min(0.35, c.controls.throttle), brake: Math.max(c.controls.brake, c.speed > 25 ? 0.2 : 0) };
    });
    const airflow = wakes(cars);
    cars.forEach((c, i) => c.step(dt, this.track, airflow[i]));
    this.contacts += collisions(cars, this.collisionStats);
    for (const c of cars) {
      const r = c.race;
      const prev = r.progress;
      const delta = wrap(c.s - r.previousS + this.track.length / 2, this.track.length) - this.track.length / 2;
      r.previousS = c.s;
      if (Math.abs(delta) < 20) r.progress += delta;
      if (this.track.scenario && prev < 0 && r.progress >= 0) { r.lapStart = this.time; r.valid = true; }
      const halfCar = 0.99;
      if (Math.abs(c.lateral) > this.track.halfWidth - halfCar + 0.6) { /* still valid unless fully out */ }
      if (Math.abs(c.lateral) > this.track.halfWidth + 0.5) { r.valid = false; r.offtrack += dt; }
      const totalSectors = Math.floor(Math.max(0, r.progress) / (this.track.length / 3));
      if (totalSectors > r.sector) {
        r.sectors.push(this.time); r.sector = totalSectors;
        if (totalSectors % 3 === 0) {
          r.lastLap = this.time - r.lapStart;
          if (r.valid && (r.bestLap === null || r.lastLap < r.bestLap)) r.bestLap = r.lastLap;
          const drv = this.drivers[c.id];
          if (drv && c.id === 0) drv.realizedLap = r.lastLap;
          r.lapStart = this.time; r.lap++; r.valid = true;
          if (this.mode !== 'practice' && r.lap > this.laps && r.finishTime === null) r.finishTime = this.time;
        }
      }
    }
    if (this.time >= this.nextTimingAt) {
      this.nextTimingAt = this.time + 0.25;
      for (const c of cars) {
        const h = this.timingHistory[c.id];
        if (c.race.progress > h.at(-1).progress) { h.push({ progress: c.race.progress, time: this.time }); if (h.length > 2400) h.shift(); }
      }
    }
    if (this.player.race.finishTime !== null || (this.mode === 'practice' && this.player.race.lap > this.laps)) {
      this.phase = 'finished'; this.results = this.standings();
    }
  }
  standings() { return [...this.activeCars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress); }
}
