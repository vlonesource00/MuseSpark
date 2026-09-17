// M2h-b — True coupled predictive controller (receding-horizon, warm-started).
// Jointly optimizes steering + longitudinal force over a horizon with the
// IDENTIFIED reduced model (vehicle-model.js, not a kinematic fantasy):
//   state  x/z/yaw/vx/vy/r/delta/F  (7 + force lag)
//   inputs deltaCmd (road rad), F (signed Newtons)
//   cost   contouring + lag/heading + speed vs profile + progress +
//          slip/yaw regularization + control-rate + terminal exit value
//   Gauss-Newton single shooting, box bounds, warm-started shifted sequence,
//   hard wall-clock deadline with previous-solution fallback.
// Force maps to pedals complementarily (never overlap); braking additionally
// requires the SAME causal gate as the sampling path (phantom discipline).
// The sampling CoupledController is preserved as baseline/fallback/regression
// reference (driver opts.controller 'sampling', tools --baseline).
import { clamp, angle } from '../sim/math.js';

function solveNormal(A, b) {
  // Solve Ax=b, A symmetric positive-definite (n<=24), Gaussian elimination.
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

export class PredictiveController {
  constructor(spec, envelope, model, opts = {}) {
    this.spec = spec;
    this.envelope = envelope;
    this.model = model;
    // Horizon: N=10x0.09=0.9s. N=16x0.12 was tried (sees full zones) but
    // explicit-Euler yaw modes go marginal at h=0.12 even substepped, costs
    // blew up 1000x, and entries still failed. Braking demand comes from the
    // target-capped vBase profile, not horizon length — 0.9s of honest
    // reference beats 1.9s of noise. Revisit horizon with implicit integration.
    this.N = opts.horizon ?? 10;
    this.h = opts.step ?? 0.09;
    this.rateHz = opts.rateHz ?? 60;
    this.deadlineMs = opts.deadlineMs ?? 5;
    this.maxIters = opts.iters ?? 3;
    this.U = null; // warm solution: [{deltaCmd, F}...] length N
    this.tick = 0;
    this.lastU0 = null;
    this.stats = { solves: 0, iters: 0, ms: 0, maxMs: 0, misses: 0, fallbacks: 0, p95win: [] };
    this.steer = 0;
    // Cost weights: order-unity at acceptable error (0.25m, 0.05rad, 1m/s…).
    // Tuned on hotlap A/B 2026-09-17; frozen after. See DEVELOPMENT_REPORT.
    this.W = {
      lat: 8.0, head: 40.0, vel: 1.0, beta: 6.0, yaw: 8.0,
      dDelta: 0.6, dF: 0.5, prog: 0.08, termLat: 24.0, termHead: 120.0, termVel: 3.0,
      cont: 2.0 // first-move continuity vs previously applied U (anti-flap)
    };
  }

  // Reference tuple at station s: lateral/heading/curvature/speed from plan.
  refAt(plan, vRefAt, s) {
    const p = plan.at(s);
    return { x: p.x, z: p.z, nx: p.nx, nz: p.nz, heading: p.heading ?? Math.atan2(p.tx, p.tz), q: p.offset ?? 0, v: vRefAt(s) };
  }

  update(car, plan, vRefAt, current, targetSpeed, envelope, safety, traffic, trackLength, muScale, gear, rpm, sm = 1) {
    const t0 = performance.now();
    this.tick++;
    const SPEC = this.spec, N = this.N, h = this.h;
    // 60Hz re-optimization; off-ticks hold the shifted previous solution.
    if (this.tick % 2 === 0 && this.lastU0) {
      const cmd = this.applyU0(car, this.lastU0, targetSpeed, envelope, safety, traffic, current, gear, rpm, muScale);
      this.stats.ms = performance.now() - t0;
      return { ...cmd, mpc: { held: true, iters: 0, ms: this.stats.ms, miss: false } };
    }
    try {
      const res = this.solve(car, plan, vRefAt, current, targetSpeed, envelope, safety, traffic, trackLength, muScale, gear, rpm, sm, t0);
      if (!res) throw new Error('no-solution');
      return res;
    } catch (e) {
      this.stats.fallbacks++;
      if (this.lastU0) {
        const cmd = this.applyU0(car, this.lastU0, targetSpeed, envelope, safety, traffic, current, gear, rpm, muScale);
        return { ...cmd, mpc: { held: true, fallback: true, iters: 0, ms: performance.now() - t0, miss: true } };
      }
      // Cold-start failure: safe coast (never a brake stab).
      return { steer: this.steer, throttle: 0, brake: 0, source: 'NONE', coasting: true, mpc: { held: false, fallback: true, iters: 0, ms: performance.now() - t0, miss: true } };
    }
  }

  solve(car, plan, vRefAt, current, targetSpeed, envelope, safety, traffic, trackLength, muScale, gear, rpm, sm, t0) {
    const SPEC = this.spec, N = this.N, h = this.h, L = trackLength;
    const x0 = this.model.fromCar(car);
    const lim = this.model.forceLimits(Math.max(5, car.speed), car.ax, gear || 0);
    const Fmax = Math.max(1500, lim.driveMax);
    const Fmin = -Math.max(3000, lim.brakeMax);
    const lock = SPEC.steeringLock;
    // Stability envelope on steering authority: at speed, tiny road angles
    // already saturate the tires (0.27 rad at 56 m/s spun the car while the
    // optimizer chased lateral error). Bound = 1.5x the angle for 0.9·latMax
    // steady cornering — generous for rejoins, impossible to yank past grip.
    // Floor 0.03 keeps low-speed maneuverability (launch handled by sampling).
    const v0v = Math.max(8, Math.abs(x0.vx));
    const latMax0 = envelope.lateral(v0v);
    const dMax = Math.max(0.03, Math.min(lock, 1.5 * Math.atan(0.9 * latMax0 * SPEC.wheelbase / (v0v * v0v))));
    // Reference speed by DISTANCE ahead (precomputed once per solve): winner
    // profile shaped by the same braking-distance limit the driver target
    // uses. Raw winner speeds hide braking demand (found: optimizer never
    // braked, sailed into hairpin at 42). vRefAt(s) arg kept for API compat.
    const smEff = sm ?? 1;
    const w = plan.winner;
    const vBase = [];
    {
      let dist = 0;
      const v0 = Math.max(5, car.speed);
      for (let k = 0; k < N; k++) {
        dist += v0 * h;
        vBase.push(vRefAt(current.s + dist));
      }
      // braking-limited shaping: min over apexes of sqrt(apex^2+2*dec*d)
      const dec = 9.0;
      for (let k = 0; k < N; k++) {
        let lim2 = Infinity;
        if (w?.speed) {
          for (let i = 0; i < w.points.length; i++) {
            let dsA = (w.points[i].s - current.s) % L;
            if (dsA > L / 2) dsA -= L;
            if (dsA < -L / 2) dsA += L;
            const ahead = dsA - k * v0 * h;
            if (ahead < -5) continue;
            const a = Math.sqrt(w.speed[i] * w.speed[i] * smEff * smEff + 2 * dec * Math.max(0, ahead));
            if (a < lim2) lim2 = a;
          }
        }
        if (lim2 < Infinity) vBase[k] = Math.min(vBase[k], lim2);
      }
      // Single speed authority: the driver's target already encodes line +
      // allow-profile + safety + slip + thermal. MPC chasing a second,
      // hotter reconstruction (13 m/s disagreement at hairpin entry) sails
      // past corners at full throttle. vBase never exceeds target.
      for (let k = 0; k < N; k++) vBase[k] = Math.min(vBase[k], targetSpeed);
    }
    // Initial guess: warm start shifted, else feedforward.
    // Warm start shifted; on large speed gaps blend in a P-seed so the
    // solver needn't traverse 25kN in 3 damped iters (found: U0F frozen at
    // Fmax while needing full brake — regime changes defeat pure warm start).
    let U;
    if (this.U && this.U.length === N) {
      U = this.U.slice(1).concat([{ ...this.U[N - 1] }]);
    } else {
      const k0 = plan.at(current.s).curvature ?? 0;
      U = Array.from({ length: N }, () => ({ deltaCmd: clamp(Math.atan(k0 * SPEC.wheelbase), -lock, lock), F: 0 }));
    }
    {
      const gap0 = (vBase[0] ?? car.speed) - car.speed;
      if (Math.abs(gap0) > 3) {
        const m = SPEC.mass + 20 * 0.75;
        const pseed = clamp(m * gap0 * 1.5, Fmin, Fmax);
        U = U.map((u) => ({ deltaCmd: u.deltaCmd, F: 0.5 * u.F + 0.5 * pseed }));
      }
    }
    const clampU = (u) => ({
      deltaCmd: clamp(u.deltaCmd, -dMax, dMax),
      F: clamp(u.F, Fmin, Fmax)
    });
    U = U.map(clampU);
    // Causal brake reference (phantom discipline): braking intent exists only
    // when the winner profile demands a slower apex ahead — same rule as the
    // sampling path, recomputed every solve, never latched.
    {
      let apexV = Infinity;
      const w = plan.winner;
      if (w?.speed) {
        for (let i = 0; i < w.points.length; i++) {
          let ds = (w.points[i].s - current.s) % L;
          if (ds > L / 2) ds -= L;
          if (ds < -L / 2) ds += L;
          if (ds < -5 || ds > 170) continue;
          if (w.speed[i] < apexV) apexV = w.speed[i];
        }
      }
      this.brakeRef = apexV < car.speed - 1.2
        ? { source: traffic?.hardConflict ? 'TRAFFIC_CONFLICT' : 'PLANNED_BRAKING' }
        : null;
    }
    const W = this.W;

    const residuals = (Useq) => {
      const R = [];
      let s = { ...x0 };
      let dist = 0;
      let prevD = s.delta, prevF = s.F ?? 0;
      for (let k = 0; k < N; k++) {
        const u = Useq[k];
        s = this.model.step(s, u, h, muScale);
        dist += Math.max(0, s.vx) * h;
        const ref = this.refAt(plan, vRefAt, current.s + dist);
        const eLat = (s.x - ref.x) * ref.nx + (s.z - ref.z) * ref.nz;
        const eHead = angle(ref.heading - s.yaw);
        // SIGNED forward velocity everywhere: hypot() makes reversing look
        // optimal near standstill (speed deficit shrinks backwards too) and
        // the solver backs the car off the grid. Found on hotlap A/B.
        const v = s.vx;
        const beta = Math.atan2(s.vy, Math.max(4, Math.abs(s.vx)));
        const rRef = this.refCurv(plan, current.s + dist) * Math.max(0, v);
        const wT = k === N - 1 ? 3 : 1;
        // Soft corridor wall: steep penalty beyond usable asphalt.
        const edge = (plan.halfWidth ?? 8.2) - 1.5;
        const over = Math.max(0, Math.abs(eLat) - edge);
        R.push(
          Math.sqrt(W.lat * wT) * eLat,
          Math.sqrt(W.head * wT) * eHead,
          Math.sqrt(W.vel) * (v - vBase[k]),
          Math.sqrt(W.beta) * beta / 0.1,
          Math.sqrt(W.yaw) * (s.r - rRef),
          Math.sqrt(W.dDelta) * (u.deltaCmd - prevD) / 0.05,
          Math.sqrt(W.dF) * (u.F - prevF) / 8000,
          -Math.sqrt(W.prog) * Math.max(0, v) * h,
          30 * over,
          // First-move continuity vs previously applied command (anti-flap
          // between drive/brake basins across solves).
          // Slip-stability barriers: the identified model is validated in the
          // linear region; beyond these the plant snaps while the model stays
          // polite (power-oversteer spins at ul_total 0.83). Rear margin sits
          // below the quasi-static circle as transient headroom (measured gap).
          25 * Math.max(0, (s.utilR ?? 0) - 0.75),
          8 * Math.max(0, (s.utilF ?? 0) - 0.9)
        );
        if (k === 0 && this.lastU0) {
          R.push(
            Math.sqrt(W.cont) * (u.deltaCmd - this.lastU0.deltaCmd) / 0.05,
            Math.sqrt(W.cont) * (u.F - this.lastU0.F) / 8000
          );
        }
        if (k === N - 1) {
          R.push(Math.sqrt(W.termLat) * eLat, Math.sqrt(W.termHead) * eHead, Math.sqrt(W.termVel) * (v - vBase[k]));
        }
        prevD = u.deltaCmd; prevF = u.F;
      }
      return R;
    };

    const nV = 2 * N;
    // Scaled decision space (steer rad ~0.1, force/10000 ~1): without this the
    // normal-equation damping swamps force gradients (A_FF ~1e-9 vs λ=1e-3)
    // and F never moves — found on hotlap A/B when the car sat at standstill.
    const FS = 10000;
    const flat = (Useq) => { const v = []; for (const u of Useq) v.push(u.deltaCmd, u.F / FS); return v; };
    const unflat = (v) => { const U2 = []; for (let k = 0; k < N; k++) U2.push(clampU({ deltaCmd: v[2 * k], F: v[2 * k + 1] * FS })); return U2; };
    const costOf = (R) => { let c = 0; for (const r of R) c += r * r; return c; };
    const compOf = (R) => {
      // component sums in residual order: lat,head,vel,beta,yaw,dD,dF,prog,wall,barR,barF (+terminal lat,head,vel)
      const names = ['lat', 'head', 'vel', 'beta', 'yaw', 'dD', 'dF', 'prog', 'wall', 'barR', 'barF'];
      const out = {};
      const per = 11;
      for (let k = 0; k < N; k++) {
        for (let j = 0; j < per; j++) {
          const v = R[k * per + j] ?? 0;
          out[names[j]] = (out[names[j]] ?? 0) + v * v;
        }
      }
      for (let j = N * per; j < R.length; j++) out.term = (out.term ?? 0) + R[j] * R[j];
      return out;
    };

    let R = residuals(U);
    let cost = costOf(R);
    const cost0 = cost;
    // Persistent damping across solves (warm-started RTI): resetting lambda
    // every solve repeats one huge rejected step 3x and freezes U forever
    // (found: U0F pinned, 0 accepts after the first solve).
    let lam = this.lam ?? 1e-3, iters = 0, miss = false, accepts = 0, rejects = 0, lastStep = 0;
    while (iters < this.maxIters) {
      if (performance.now() - t0 > this.deadlineMs) { miss = true; break; }
      const x = flat(U);
      const J = [];
      const eps = 1e-4; // FD step (relative for F via Fscale, absolute for steer)
      for (let j = 0; j < nV; j++) {
        const xp = x.slice();
        xp[j] += eps;
        const Up = unflat(xp);
        const Rp = residuals(Up);
        const col = [];
        for (let i = 0; i < R.length; i++) col.push((Rp[i] - R[i]) / (xp[j] - x[j]));
        J.push(col);
      }
      // J is nV columns of length nR; build normal equations.
      const nR = R.length;
      const A = Array.from({ length: nV }, () => new Array(nV).fill(0));
      const g = new Array(nV).fill(0);
      for (let a = 0; a < nV; a++) {
        for (let m = 0; m < nR; m++) {
          g[a] += J[a][m] * R[m];
          for (let b = a; b < nV; b++) A[a][b] += J[a][m] * J[b][m];
        }
      }
      for (let a = 0; a < nV; a++) { for (let b = 0; b < a; b++) A[a][b] = A[b][a]; A[a][a] += lam; }
      const step = solveNormal(A, g.map((v) => -v));
      if (!step) { lam *= 10; iters++; rejects++; continue; }
      const xn = x.map((v, j) => v + step[j]);
      const Un = unflat(xn);
      const Rn = residuals(Un);
      const cn = costOf(Rn);
      lastStep = Math.hypot(...step);
      if (cn < cost) {
        U = Un; R = Rn; cost = cn; lam = Math.max(1e-6, lam / 3); iters++; accepts++;
      } else {
        lam *= 10; iters++; rejects++;
        if (lam > 1e4) break;
      }
    }
    const ms = performance.now() - t0;
    if (ms > this.deadlineMs) miss = true;
    if (!Number.isFinite(U[0].deltaCmd) || !Number.isFinite(U[0].F) || !Number.isFinite(cost)) {
      throw new Error('mpc-nonfinite');
    }
    this.U = U;
    this.lastU0 = { ...U[0] };
    this.lam = clamp(lam, 1e-6, 1e2);
    this.stats.diag = { cost0, cost1: cost, lamEnd: lam, accepts, rejects, stepNorm: lastStep, comp: compOf(R) };
    this.stats.solves++;
    this.stats.iters += iters;
    if (miss) this.stats.misses++;
    this.stats.ms = ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.p95win.push(ms);
    if (this.stats.p95win.length > 240) this.stats.p95win.shift();
    const cmd = this.applyU0(car, U[0], targetSpeed, envelope, safety, traffic, current, gear, rpm, muScale);
    return { ...cmd, mpc: { held: false, iters, ms, miss, cost } };
  }

  refCurv(plan, s) {
    const a = plan.at(s - 4), b = plan.at(s), c = plan.at(s + 4);
    const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z;
    const a1 = Math.atan2(abx, abz), a2 = Math.atan2(bcx, bcz);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d / Math.max(1, (Math.hypot(abx, abz) + Math.hypot(bcx, bcz)) / 2);
  }

  // Force + steer intent -> causal pedals. Braking needs the same gate as the
  // sampling path (phantom discipline); throttle is TC-mapped, complementary.
  applyU0(car, u0, targetSpeed, envelope, safety, traffic, current, gear, rpm, muScale) {
    const SPEC = this.spec;
    if (!u0 || !Number.isFinite(u0.deltaCmd) || !Number.isFinite(u0.F)) {
      throw new Error('mpc-bad-u0');
    }
    const steer = clamp(u0.deltaCmd / SPEC.steeringLock, -1, 1);
    this.steer = this.steer + (steer - this.steer) * 0.5; // 60Hz apply smoothing
    const lim = this.model.forceLimits(Math.max(5, car.speed), car.ax, gear || 0);
    const F = clamp(u0.F, -lim.brakeMax, lim.driveMax);
    const err = targetSpeed - car.speed;
    const overspeed = car.speed - targetSpeed;
    // Brake intent: winner-apex rule OR driver-target rule. The target already
    // encodes allow-profile + skill + thermal + safety over 170m; the winner
    // window (140m) can miss the apex that justifies it, vetoing MPC braking
    // while the driver screams for decel (s=436: U0F -25kN vetoed at 47 vs
    // 38.8). Both clauses are causal (corner ahead); a clear-road target
    // never demands braking, so phantom discipline holds. The fallback is
    // withheld while sliding (braking into a slide worsens it).
    const slipNow = Math.abs(Math.atan2(car.v, Math.max(4, Math.abs(car.u))));
    const brakeRef = this.brakeRef ?? ((overspeed > 0.5 && slipNow < 0.15) ? { source: 'PLANNED_BRAKING' } : null);
    let brakeAllowed = false, brakeSource = 'NONE', brakePressure = 0;
    if (safety && safety.emergency) { brakeAllowed = true; brakeSource = 'CONTACT_AVOIDANCE'; brakePressure = 1; }
    else if (traffic && traffic.hardConflict && err < -1) { brakeAllowed = true; brakeSource = 'TRAFFIC_CONFLICT'; brakePressure = clamp(-err * 0.25, 0.3, 1); }
    else if (overspeed > 0.5 && brakeRef) { brakeAllowed = true; brakeSource = brakeRef.source; brakePressure = clamp(0.4 + overspeed / 12, 0.4, 1); }
    else if (Math.abs(current.lateral) > 7.5) { brakeAllowed = true; brakeSource = 'TRACK_LIMIT_AVOIDANCE'; brakePressure = 0.5; }
    let throttle = 0, brake = 0, source = 'NONE', coasting = false;
    if (F >= 0) {
      // TC law on measured state: deliver min(desired, rear-available) with a
      // transient haircut (0.9) for relaxation/TC lag the quasi-static circle
      // cannot see. Complementarity preserved (this branch never brakes).
      const gate = envelope.throttleLegal(car.speed, car.ay, 0, car.ax, muScale ?? 1);
      const eng = Math.max(1500, this.model.engineForceGear(Math.max(5, car.speed), gear || 0, rpm || 0));
      throttle = clamp(Math.min(F, 0.9 * gate.remaining) / eng, 0, 1);
      source = 'NONE';
    } else if (brakeAllowed) {
      brake = brakePressure > 0 && brakeSource === 'CONTACT_AVOIDANCE' ? 1 : clamp(-F / Math.max(3000, lim.brakeMax), 0, 1);
      if (traffic && traffic.hardConflict && err < -1) brake = Math.max(brake, clamp(-err * 0.25, 0.3, 1));
      source = brakeSource;
    } else {
      coasting = true;
    }
    return { steer: this.steer, throttle, brake, source, coasting };
  }
}
