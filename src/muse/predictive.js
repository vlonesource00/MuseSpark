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

// Smooth Huber: linear near zero, saturating far out. Bounds the influence of
// stale/hot references (15 m/s vel gaps, meters-off lateral) so stability
// barriers can win when they must. Plain quadratic lets one hot residual
// command full brake + full lock simultaneously — the entry-spin mechanism.
function hub(x, cap) {
  return cap * Math.tanh(x / cap);
}

function solveNormal(A, b) {  // Solve Ax=b, A symmetric positive-definite (n<=24), Gaussian elimination.
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
    // Horizon: N=16x0.12=1.92s braking preview. The earlier N=16 attempt failed
    // on explicit-Euler yaw instability; the model now subdivides h>0.07
    // transparently, so retry with correct numerics. N=10 kept as fallback.
    this.N = opts.horizon ?? 16;
    this.h = opts.step ?? 0.12;
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

  // Reference tuple at station s: committed-plan geometry (speed comes from
  // the governor's spatial profile, never from here).
  refAt(plan, s) {
    const p = plan.at(s);
    return { x: p.x, z: p.z, nx: p.nx, nz: p.nz, heading: p.heading ?? Math.atan2(p.tx, p.tz), q: p.offset ?? 0 };
  }

  update(car, plan, current, targetSpeed, envelope, safety, traffic, trackLength, muScale, gear, rpm, govCtx) {
    const t0 = performance.now();
    this.tick++;
    this._gov = govCtx?.gov ?? this._gov ?? null;
    const SPEC = this.spec, N = this.N, h = this.h;
    // 60Hz re-optimization; off-ticks advance the shifted sequence (proper
    // RTI hold: the applied command is always U[0] of the current sequence,
    // never a stale copy — stale holds masked solver behavior in diagnosis).
    if (this.tick % 2 === 0 && this.U && this.U.length === N) {
      this.U = this.U.slice(1).concat([{ ...this.U[N - 1] }]);
      this.lastU0 = { ...this.U[0] };
      const cmd = this.applyU0(car, this.U[0], targetSpeed, envelope, safety, traffic, current, gear, rpm, muScale);
      this.stats.ms = performance.now() - t0;
      return { ...cmd, mpc: { held: true, iters: 0, ms: this.stats.ms, miss: false } };
    }
    try {
      const res = this.solve(car, plan, current, targetSpeed, envelope, safety, traffic, trackLength, muScale, gear, rpm, govCtx, t0);
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

  solve(car, plan, current, targetSpeed, envelope, safety, traffic, trackLength, muScale, gear, rpm, govCtx, t0) {
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
    // Floor is speed-scheduled: 0.03 only helps below ~20 m/s; at 57 a 0.03
    // floor PINNED the optimizer into a ±limit-cycle sway that stepped the
    // rear out under power. Launch (<12 m/s) is sampling-owned anyway.
    const v0v = Math.max(8, Math.abs(x0.vx));
    const latMax0 = envelope.lateral(v0v);
    const dFloor = v0v < 20 ? 0.03 : 0.008;
    const dMax = Math.max(dFloor, Math.min(lock, 1.5 * Math.atan(0.9 * latMax0 * SPEC.wheelbase / (v0v * v0v))));
    // Reference speed by DISTANCE ahead from the SHARED governor (Phase F):
    // V_ALLOW(s_k) is spatial/causal per predicted station. The banned
    // pattern was min(vBase, scalarTargetSpeed) copied across the horizon
    // (suppressed post-apex pickup). Fallback path only without a governor.
    const gov = govCtx?.gov ?? null;
    const w = plan.winner;
    const vBase = [];
    {
      let dist = 0;
      const v0 = Math.max(5, car.speed);
      // Reactive caps (mirror driver arbitration): in distress the spatial
      // profile is aspirational — survive now (full throttle into a slide
      // spins; measured s=794). Not a scalar-cap ban violation: these fire
      // only on current distress, never on clean running.
      const slip0 = Math.abs(Math.atan2(car.v, Math.max(4, Math.abs(car.u))));
      let capReactive = Infinity;
      if (slip0 > 0.2) capReactive = Math.min(capReactive, car.speed * (1 - clamp((slip0 - 0.2) * 1.1, 0, 0.45)));
      if (Math.abs(current.lateral) > (plan.halfWidth ?? 8.2) + 0.8) capReactive = Math.min(capReactive, 11);
      for (let k = 0; k < N; k++) {
        dist += v0 * h;
        const sK = current.s + dist;
        const va = gov ? gov.vAllow(sK, govCtx) : Infinity;
        // Spatial line cap per station (NOT a scalar cap): the dense line
        // knows entry-kink curvature the apex formula cannot see (hairpin
        // entry: allow said 40 where the line knew 29 — slide). vLine uses
        // the solve-entry speed for its lookahead (stationary reference).
        const vl = gov ? gov.vLine(sK, { ...govCtx, v: v0 }) : Infinity;
        const fb = Number.isFinite(va) ? va : vl;
        vBase.push(Math.min(fb, vl, capReactive));
      }
      if (!gov) {
        const smEff = 1;
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
      }
    }
    // Initial guess: current shifted sequence (holds already advance it —
    // do NOT shift again here) with P-seed blend on large speed gaps so the
    // solver needn't traverse 25kN in damped iters (regime changes defeat
    // pure warm start).
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
    // Causal brake reference from the shared governor (phantom discipline):
    // intent exists only when the spatial profile demands a slower apex
    // ahead. Recomputed every solve, never latched.
    {
      const bc = gov
        ? gov.brakeCause(current.s, car.speed, { winner: plan.winner, hardConflict: !!traffic?.hardConflict })
        : null;
      this.brakeRef = bc ? { source: bc.source } : null;
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
        // Clear-air reference = global LINE pose (honest off-line error +
        // working corridor wall). Anchored-plan reference reads ~zero error
        // by construction (the equilibrium trap); traffic keeps the maneuver
        // plan as reference. Mirrors the driver rejoin fix.
        const gov3 = govCtx?.gov ?? null;
        const ref = (gov3 && !govCtx?.rivalNear) ? gov3.linePose(current.s + dist) : plan.at(current.s + dist);
        const eLat = (s.x - ref.x) * ref.nx + (s.z - ref.z) * ref.nz;
        const eHead = angle(ref.heading - s.yaw);
        // SIGNED forward velocity everywhere: hypot() makes reversing look
        // optimal near standstill (speed deficit shrinks backwards too) and
        // the solver backs the car off the grid. Found on hotlap A/B.
        const v = s.vx;
        const beta = Math.atan2(s.vy, Math.max(4, Math.abs(s.vx)));
        const gov2 = govCtx?.gov ?? null;
        const kRef = gov2 ? gov2.kappaLine(current.s + dist) : this.refCurv(plan, current.s + dist);
        const rRef = kRef * Math.max(0, v);
        const wT = k === N - 1 ? 3 : 1;
        // Soft corridor wall: steep penalty beyond usable asphalt.
        const edge = (plan.halfWidth ?? 8.2) - 1.5;
        const over = Math.max(0, Math.abs(eLat) - edge);
        R.push(
          Math.sqrt(W.lat * wT) * hub(eLat, 3.0),
          Math.sqrt(W.head * wT) * eHead,
          Math.sqrt(W.vel) * hub(v - vBase[k], 6.0),
          Math.sqrt(W.beta) * hub(beta, 0.5) / 0.1,
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
      // Stability control: unexpected rotation (yaw vs governor-curvature
      // expectation) means the rear is already going — cut power hard.
      // Quasi-static availability cannot see transient breakaway.
      const gov3 = this._gov ?? null;
      const kExp = gov3 ? gov3.kappaLine(current.s) : 0;
      const yawErr = Math.abs(car.yawRate - kExp * car.speed);
      if (yawErr > 0.12) throttle *= clamp(1 - (yawErr - 0.12) * 4, 0.15, 1);
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
