# MuseSpark Racing — Milestones 1–5 Checkpoint

Extreme autonomous racing AI on the Astra physical plant. All components live,
wired, measured, tested. No physics advantages. No phantom brakes.

- **Theoretical (global-opt):** 76.22s (Harbor GT)
- **Realized (controlled):** **86.875s** valid (off 0.41, dmg 0) — M1 was 94.29
- **Control gap:** 10.7s (was 18.1) — tracking still the bottleneck
- **Shared-host official:** **89.82s** (SPRINT), 0 off/dmg/errors; same-day Astra 78.77, pinned Supreme 78.34
- **Phantom brakes:** 0 samples (unit + headless gates green)
- **Perf:** 8-car 1.28ms/step (6.5× realtime) — PASS
- **Tests:** 20/20 green (incl. wet, determinism, soak slice, thermal)
- **Racecraft lab:** slow-rival P1 severe-0; equal-duel + 6-car contact cost tracked as open work
- **GitHub:** https://github.com/vlonesource00/MuseSpark

## Run

```sh
npm install
npm test                 # 20 tests: unit + integration + phantom + thermal + wet + determinism + perf
node tools/optimize-line.mjs
node tools/headless-hotlap.mjs        # QUALIFYING by default (86.88 valid)
node tools/delta-analysis.mjs         # 5m loss classes driving M2 work
node tools/headless-race.mjs          # 6-car metrics + contact bins/frames
node tools/racecraft-lab.mjs          # slow-rival / equal-duel gates
node tools/soak.mjs                   # 8-car stint gates
node tools/profile.mjs
node tools/bridge-smoke.mjs [--pace]  # Muse on REAL host physics, benchmark tree untouched
node tools/install-benchmark-bridge.mjs  # mechanical benchmark registration
npm run dev              # browser: DRIVE / AI HOTLAP / AI RACE / LAB / ENGINEER (B), camera (C), focus (Tab)
```

## What works now

Global multi-resolution time-optimal line, physical envelope (real forces),
belief posteriors, persistent episodes + flank memory + blocked debt, 2-stage
space-time search with swept occupancy, coupled MPCC with latched spatial brake
events + combined-slip throttle gate, independent safety supervisor, multi-rate
adaptive scheduler, telemetry, engineer overlay (strategy/maneuver/braking/
physics/pace/attack/defense/beliefs/compute), headless determinism.

## Honest weaknesses (tracked, gated)

1. **Pace:** 86.88 vs 73.2 target (~11s off shared best on host physics).
   Delta: MID-CORNER 5.5s, BRAKING 4.0s. Full-res line untrackable.
2. **Pack racecraft:** 6-car frames 1917 (Supreme 12-car ref 926 — ~4x per car),
   severe 16, trains collapse to ~140s/lap. Slow-rival converts (P1, severe 0)
   but costs 1925 contacts; equal-duel severe open. Speed-only protocols
   falsified (deadlock or ram); lateral resolution is the tracked fix.
3. **Visuals:** minimal three.js shell; physics already identical to host.
4. **Done in M4:** soak gates, wet lap, determinism guard, racecraft lab,
   QUALIFYING/SPRINT/ENDURANCE differentiation, thermal adaptation.

Baseline → hypothesis → implement → unit → headless → visual → profile →
compare → keep/revert. Failed experiments are documented in DEVELOPMENT_REPORT
so they are not repeated.
