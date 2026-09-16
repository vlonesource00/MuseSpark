# MuseSpark Racing — Architecture

MuseSpark 1.3 contender. Astra physical plant, Muse intelligence. No physics advantages.

## Inheritance (Astra, verbatim copies in `src/sim/`)

`math.js`, `track.js`, `harbor-ring.js`, `tyre.js`, `vehicle.js`, `car-specs.js`,
`path-geometry.js`, `style.css` — copied from `../astra`, never modified for advantage.
All drivers use identical forces: tyre transient combined-slip, aero (Cl/Cd + wake),
load transfer, TC/ABS, gearbox, damage, wakes, OBB collisions, Harbor Ring geometry.
Muse AI only READS the plant via the envelope; it cannot grant grip or power.

## Superstructure (all LIVE + WIRED)

```
GLOBAL TRACK/VEHICLE KNOWLEDGE (envelope.js — real Newtons)
  → OFFLINE TIME-OPTIMAL (global-opt.js — multi-resolution, full-lap T=∫ds/v)
  → DRIVER BELIEF STATE (belief.js — posterior over 6 intents, body≠uncertainty)
  → STRATEGIC OPTIMIZATION (strategy.js — episodes, flank memory, blocked debt,
      outside primary, switchback, joint attack+defense, 3-wide corridors)
  → SPACE-TIME KINODYNAMIC SEARCH (trajectory.js — warm-start, 2-stage screen,
      swept occupancy, exit advantage @ horizon)
  → COUPLED MPCC (mpcc.js — 15-rollout contouring + spatial brake events +
      combined-slip throttle gate + causal brake gate)
  → INDEPENDENT SAFETY SUPERVISOR (safety.js — logs every activation)
Orthogonal: scheduler.js (120/40/15/15/7Hz + adaptive detail),
  types.js (plant-agnostic MuseObservation/MuseCommand), telemetry.js.
```

## Key design decisions (failures designed against)

- **No global traffic fear:** strategy/trajectory evaluate maneuver value; clear-air
  pace uses the global optimum unmodified. Traffic cost is additive, never a global cut.
- **No phantom braking:** `musePedals()` brakes ONLY with a causal gate
  (PLANNED/TRAFFIC/CONTACT/TRACK_LIMIT/RECOVERY). Small decel → coast.
  Automated test `tests/phantom-brake.test.js` fails CI on violation.
- **No filter band-aid:** brake intent is a latched track-space event
  (start/trail/release/apex/pickup), carried through replans; never smoothed noise.
- **No compute explosion:** 2-stage search (broad cheap → top 2–5 finalists),
  adaptive detail (clear=5 cands, duel=13), 8-car @ 1.3ms/step (6.4× realtime).
- **T1/linked complexes:** full-lap objective + wide Gaussian basis couples
  entry/apex/transition/exit; never independent corner optimization.
- **Anti-stubbornness (vs Supreme V3.2):** failed flanks are remembered per episode;
  inside blocked after failures until evidence changes; switching requires dominance
  hysteresis, holding requires only non-domination (commitment without twitch).
- **Throttle physics:** `throttleLegal()` compares remaining longitudinal Newtons to
  engine-request Newtons; full throttle when covered, proportional only when truly
  combined-limited. Never scales by normalized reserve fraction.

## Theoretical vs realized (mandatory diagnostic)

Session exposes both: `theoreticalLap` (global-opt) and per-car `bestLap`.
Current Harbor GT: theoretical ~76.2s (fast) / 75.7s (full), realized ~94.3s.
Gap ~18s → controller tracking is the bottleneck (Milestone 2), not the line.

## Modes

QUALIFYING / SPRINT / ENDURANCE via StrategyBrain.mode (objective horizon only;
same plant). Game modes: DRIVE, AI HOTLAP, AI RACE, HUMAN VS AI, RACECRAFT LAB,
ENGINEER (B key), cameras chase/top/trackside (C key), focus Tab.
