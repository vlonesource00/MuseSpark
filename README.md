# MuseSpark Racing — Closure-wave checkpoint (GATE 1 Murrayfield)

Extreme autonomous racing AI on the Astra physical plant. All components live,
wired, measured, tested. No physics advantages. No phantom brakes.

- **Theoretical (global-opt):** 71.92s session line (T_PROFILE 72.72; pure T_GEOMETRIC 71.21; T_DYNAMIC≈77.8 model-ideal frontier)
- **Realized (controlled):** **81.967s** valid, 0.00 off (QUALIFYING @0.985) — M1 was 94.29
- **SPRINT stint pace:** 83.83 best, 0.0 off across 3 laps (repeatable)
- **Control gap:** ~10s vs PROFILE, ~4s vs DYNAMIC-feasible — entries + pickup
- **Shared-host official:** **82.82s** (SPRINT, pin fb7e16e, confirmed ×2 deterministic), 0 off/dmg/errors;
  same-day Astra 78.77, pinned Supreme 78.34 (GATE <82 open by 0.8s)
- **Phantom brakes:** 0 samples (unit + headless gates green)
- **Perf:** 8-car 1.28ms/step (6.5× realtime) — PASS (MPC p95 ~2ms, deadline-guarded)
- **Tests:** 29/29 green (model validation, MPC unit, thermal, wet, determinism, soak, phantom)
- **Racecraft lab:** slow-rival P1 severe-0; equal-duel + 6-car contact cost tracked as open work
- **GitHub:** https://github.com/vlonesource00/MuseSpark

## Run

```sh
npm install
npm test                 # 29 tests: model validation, MPC unit, phantom, thermal, wet, determinism, perf
node tools/optimize-line.mjs         # T_GEOMETRIC vs T_TRANSIENT accounting
node tools/headless-hotlap.mjs [--mpc]  # QUALIFYING by default (83.88 sampling; --mpc = predictive lab)
node tools/execution-gap.mjs [--laps N] # plan-vs-local-vs-actual audit + complex table + feasibility
node tools/identify-model.mjs        # M_CONTROL identification vs M_PLANT
node tools/mpc-corner.mjs            # MPC corner sandbox (fast weight iteration)
node tools/delta-analysis.mjs        # 5m loss classes
node tools/headless-race.mjs          # 6-car metrics + contact bins/frames
node tools/racecraft-lab.mjs          # slow-rival / equal-duel gates
node tools/soak.mjs                   # 8-car stint gates
node tools/profile.mjs
node tools/bridge-smoke.mjs [--pace]  # Muse on REAL host physics, benchmark tree untouched
node tools/install-benchmark-bridge.mjs  # mechanical benchmark registration
npm run dev              # browser: DRIVE / AI HOTLAP / AI RACE / LAB / ENGINEER (B), camera (C), focus (Tab)
```

## What works now

Global multi-resolution time-optimal line (dense runtime-exact final word),
identified reduced vehicle model, genuine coupled MPC (lab-grade) + preserved
sampling baseline, physical envelope (real forces, unit-verified), belief
posteriors, persistent episodes + flank memory + blocked debt, 2-stage
space-time search with swept occupancy, causal spatial braking, independent
safety supervisor, multi-rate adaptive scheduler, telemetry, engineer overlay
(T-levels, loss source, strategy/maneuver/braking/physics/pace/compute),
headless determinism.

## Honest weaknesses (tracked, gated)

1. **Pace:** 83.88 vs 73.2 target (~8s off shared best on host physics).
   Audit: entries (hot + wide at true power) + exits. Gates <82/<80/<79 OPEN.
2. **MPC entries:** corner-capable with real trail braking, but full-lap entries
   defeat it (target-capped vBase + barriers + stability envelope in place;
   needs entry-line/braking coordination). Default stays sampling.
3. **Pack racecraft:** 6-car frames ~1900 (Supreme 12-car ref 926), severe open.
   Slow-rival converts (P1, severe 0) but costly; equal-duel severe open.
   Lateral resolution is the tracked fix (untouched this wave, by mandate).
3. **Visuals:** minimal three.js shell; physics already identical to host.
4. **Done in M4:** soak gates, wet lap, determinism guard, racecraft lab,
   QUALIFYING/SPRINT/ENDURANCE differentiation, thermal adaptation.

Baseline → hypothesis → implement → unit → headless → visual → profile →
compare → keep/revert. Failed experiments are documented in DEVELOPMENT_REPORT
so they are not repeated.
