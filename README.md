# MuseSpark Racing — Milestone 1 Checkpoint

Extreme autonomous racing AI on the Astra physical plant. All components live,
wired, measured, tested. No physics advantages. No phantom brakes.

- **Theoretical (global-opt):** ~76.2s fast / ~75.7s full (Harbor GT)
- **Realized (controlled):** ~94.3s clean, 0 offtrack, 0 contacts (solo)
- **Control gap:** ~18s → tracking is the bottleneck (Milestone 2 work, not the line)
- **Phantom brakes:** 0 samples (automated CI gate)
- **Perf:** 6-car 0.92ms/step (9× realtime), 8-car 1.30ms/step — PASS
- **Tests:** 14/14 green

## Run

```sh
npm install
npm test                 # unit + integration + phantom + performance
node tools/optimize-line.mjs
node tools/headless-hotlap.mjs --fast
node tools/headless-race.mjs
node tools/profile.mjs
npm run dev              # browser: DRIVE / AI HOTLAP / AI RACE / LAB / ENGINEER (B), camera (C), focus (Tab)
```

## What works now

Global multi-resolution time-optimal line, physical envelope (real forces),
belief posteriors, persistent episodes + flank memory + blocked debt, 2-stage
space-time search with swept occupancy, coupled MPCC with latched spatial brake
events + combined-slip throttle gate, independent safety supervisor, multi-rate
adaptive scheduler, telemetry, engineer overlay (strategy/maneuver/braking/
physics/pace/attack/defense/beliefs/compute), headless determinism.

## Honest weaknesses (next waves)

1. **Pace:** 94s vs 73.2 target. Fix tracking (brake later/harder, throttle earlier,
   line refinement + corner-complex polish, steering-rate discipline).
2. **Pack racecraft:** 6-car race is contact-heavy (3119 contacts/3 laps) and
   supervisor rate is high (~1000+ activations/car) — traffic prediction and
   corridor planning must get smarter, not just more capped.
3. **Visuals:** minimal three.js shell (ribbon + boxes); full Astra scenery port
   (world/scenery/effects/audio) is tracked follow-up — physics already identical.
4. **Soak/wet/endurance/racecraft-lab scenarios:** lab harness + 8-lap soaks +
   wet + qualifying/sprint/endurance differentiation still to be built out.

Baseline → hypothesis → implement → unit → headless → visual → profile →
compare → keep/revert. This checkpoint is the BASELINE.
